import { addUsage } from "../utils.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").ProviderConfig} ProviderConfig
 */

// the codex provider talks to the ChatGPT Codex backend (Responses API wire
// format) using OAuth credentials from a ChatGPT subscription rather than a
// platform API key. pass the access token as apiKey and the account id via
// headers: { "chatgpt-account-id": ... }
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";

const REASONING_EFFORTS = { low: "low", medium: "medium", high: "high", max: "high" };

const toContentParts = (content, partType) => {
  if (typeof content === "string") return [{ type: partType, text: content }];
  return content.map((part) => {
    if (part.type === "text") return { type: partType, text: part.text };
    if (part.type === "image" && part.source?.kind === "base64") {
      return { type: "input_image", image_url: `data:${part.source.mediaType};base64,${part.source.data}` };
    }
    if (part.type === "image" && part.source?.kind === "url") {
      return { type: "input_image", image_url: part.source.url };
    }
    return { type: partType, text: "" };
  });
};

export const toCodexInput = (history) => {
  const input = [];
  for (const msg of history) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      input.push({ type: "message", role: "user", content: toContentParts(msg.content, "input_text") });
    } else if (msg.role === "assistant") {
      if (msg.content) {
        input.push({ type: "message", role: "assistant", content: toContentParts(msg.content, "output_text") });
      }
      for (const tc of msg.tool_calls || []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
    } else if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    }
  }
  return input;
};

export const toCodexTools = (tools) =>
  (tools || []).map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }));

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callCodex = async (config, ctx) => {
  const { model, instructions, apiKey, baseUrl, maxTokens, effort, headers } = config;
  if (!apiKey) {
    throw new Error("Codex provider requires a ChatGPT OAuth access token passed as apiKey");
  }

  const body = {
    model,
    instructions: instructions || "",
    input: toCodexInput(ctx.history),
    store: false,
    stream: true,
    parallel_tool_calls: false,
    ...(maxTokens && { max_output_tokens: maxTokens }),
  };
  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = toCodexTools(ctx.tools);
    body.tool_choice = "auto";
  }
  // codex models are reasoning models; always ask for summaries so thinking is
  // observable, and pin the effort only when one was requested
  body.reasoning = {
    summary: "auto",
    ...(REASONING_EFFORTS[effort] && { effort: REASONING_EFFORTS[effort] }),
  };

  const response = await fetch(`${baseUrl || DEFAULT_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: ctx.abortSignal,
  });

  if (!response.ok) {
    throw new Error(`Codex API error: ${response.status} ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let fullContent = "";
  const toolCalls = [];
  let usage = null;
  let buffer = "";
  let failure = null;

  try {
    while (true) {
      if (ctx.abortSignal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const type = parsed.type;
        if (type === "response.output_text.delta" && parsed.delta) {
          fullContent += parsed.delta;
          ctx.stream?.({ type: "content", content: parsed.delta });
        } else if (
          (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") &&
          parsed.delta
        ) {
          ctx.stream?.({ type: "thinking", content: parsed.delta });
        } else if (type === "response.output_item.done" && parsed.item?.type === "function_call") {
          toolCalls.push({
            id: parsed.item.call_id,
            type: "function",
            function: { name: parsed.item.name, arguments: parsed.item.arguments || "{}" },
          });
        } else if (type === "response.completed" && parsed.response?.usage) {
          usage = parsed.response.usage;
        } else if (type === "response.failed" || type === "error") {
          failure = parsed.response?.error?.message || parsed.message || "codex response failed";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (failure) throw new Error(`Codex API error: ${failure}`);

  /** @type {import("../types.js").Message & { tool_calls?: any[] }} */
  const msg = { role: "assistant", content: fullContent };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;

  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const nextUsage = addUsage(
    ctx.usage,
    inputTokens,
    outputTokens,
    usage?.total_tokens || inputTokens + outputTokens,
    usage?.input_tokens_details?.cached_tokens || 0,
    usage?.output_tokens_details?.reasoning_tokens || 0,
  );

  if (ctx.stream && usage) {
    ctx.stream({ type: "usage", usage: nextUsage });
  }

  return { ...ctx, lastResponse: msg, history: [...ctx.history, msg], usage: nextUsage };
};

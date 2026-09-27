import { addCost, addUsage } from "../utils.js";
import { request } from "./http.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").Message} Message
 * @typedef {import("./http.js").RequestOptions} RequestOptions
 */

/**
 * @typedef {object} ChatCompletionsRequest
 * @property {string} url
 * @property {string} label provider name used in error messages
 * @property {Record<string, string>} headers
 * @property {object} body
 * @property {RequestOptions} transport
 */

// tool calls stream as incremental chunks keyed by index that need assembly.
// example: {"index": 0, "function": {"name": "get_wea"}} then {"index": 0, "function": {"arguments": "ther"}}
const appendToolCalls = (toolCalls, tcchunklist) => {
  for (const tcchunk of tcchunklist) {
    while (toolCalls.length <= tcchunk.index) {
      toolCalls.push({ id: "", type: "function", function: { name: "", arguments: "" } });
    }
    const tc = toolCalls[tcchunk.index];
    tc.id += tcchunk.id || "";
    tc.function.name += tcchunk.function?.name || "";
    tc.function.arguments += tcchunk.function?.arguments || "";
  }
  return toolCalls;
};

const STREAMED_DETAIL_TEXT = ["text", "summary", "data", "signature"];

// reasoning details stream as fragments sharing an index: text arrives in
// pieces and the signature lands in a later fragment of the same block
const appendReasoningDetails = (details, chunks) => {
  for (const chunk of chunks) {
    const existing = details.find((d) => d.index === chunk.index);
    if (!existing) {
      details.push({ ...chunk });
      continue;
    }
    for (const [key, value] of Object.entries(chunk)) {
      if (value == null) continue;
      const joins = STREAMED_DETAIL_TEXT.includes(key) && typeof existing[key] === "string";
      existing[key] = joins ? existing[key] + value : value;
    }
  }
  return details;
};

const toUsage = (existing, usage) =>
  addCost(
    addUsage(
      existing,
      usage?.prompt_tokens || 0,
      usage?.completion_tokens || 0,
      usage?.total_tokens || 0,
      usage?.prompt_tokens_details?.cached_tokens || 0,
      usage?.completion_tokens_details?.reasoning_tokens || 0,
    ),
    usage?.cost,
  );

const toAssistantMessage = ({ content, toolCalls, reasoningDetails }) => {
  /** @type {Message & { tool_calls?: any[], _reasoning_details?: any[] }} */
  const msg = { role: "assistant", content: content || "" };
  if (toolCalls?.length) msg.tool_calls = toolCalls;
  if (reasoningDetails?.length) msg._reasoning_details = reasoningDetails;
  return msg;
};

const emitToolCallChunks = (ctx, toolCalls, tcchunklist) => {
  for (const tcchunk of tcchunklist) {
    const tc = toolCalls[tcchunk.index];
    if (tcchunk.function?.name) {
      ctx.stream?.({ type: "tool_call_start", index: tcchunk.index, name: tc?.function?.name || "" });
    }
    if (tcchunk.function?.arguments) {
      ctx.stream?.({
        type: "tool_call_delta",
        index: tcchunk.index,
        name: tc?.function?.name || "",
        argumentDelta: tcchunk.function.arguments,
        argumentsSoFar: tc?.function?.arguments || "",
      });
    }
  }
};

/**
 * @param {Response} response
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
const handleStream = async (response, ctx) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let content = "";
  let toolCalls = [];
  let reasoningDetails = [];
  let buffer = "";
  let streamUsage = null;

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
        if (data === "[DONE]" || !data) continue;

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        if (parsed.usage) streamUsage = parsed.usage;

        const delta = parsed.choices?.[0]?.delta;
        const thinking = delta?.reasoning || delta?.reasoning_content;

        if (thinking) ctx.stream?.({ type: "thinking", content: thinking });

        if (delta?.reasoning_details?.length) {
          reasoningDetails = appendReasoningDetails(reasoningDetails, delta.reasoning_details);
        }

        if (delta?.content) {
          content += delta.content;
          ctx.stream?.({ type: "content", content: delta.content });
        }

        if (delta?.tool_calls) {
          toolCalls = appendToolCalls(toolCalls, delta.tool_calls);
          emitToolCallChunks(ctx, toolCalls, delta.tool_calls);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const msg = toAssistantMessage({ content, toolCalls, reasoningDetails });
  const usage = toUsage(ctx.usage, streamUsage);
  if (streamUsage) ctx.stream?.({ type: "usage", usage });

  return { ...ctx, lastResponse: msg, history: [...ctx.history, msg], usage };
};

/**
 * @param {Response} response
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
const handleJson = async (response, ctx) => {
  const data = await response.json();
  const { message } = data.choices[0];
  const msg = toAssistantMessage({
    content: message.content,
    toolCalls: message.tool_calls,
    reasoningDetails: message.reasoning_details,
  });
  return { ...ctx, lastResponse: msg, history: [...ctx.history, msg], usage: toUsage(ctx.usage, data.usage) };
};

/**
 * send one OpenAI-style chat completions request and fold the reply into the
 * conversation. streams when the context carries a stream callback
 *
 * @param {ChatCompletionsRequest} req
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callChatCompletions = async ({ url, label, headers, body, transport }, ctx) => {
  const response = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      ...body,
      stream: !!ctx.stream,
      ...(ctx.stream && { stream_options: { include_usage: true } }),
      ...(ctx.tools?.length > 0 && { tools: ctx.tools, tool_choice: "auto" }),
    }),
  }, transport);

  if (!response.ok) {
    throw new Error(`${label} API error: ${await response.text()}`);
  }

  return ctx.stream ? handleStream(response, ctx) : handleJson(response, ctx);
};

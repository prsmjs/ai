import { addUsage, getKey } from "../utils.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").ContentPart} ContentPart
 * @typedef {import("../types.js").Message} Message
 * @typedef {import("../types.js").ProviderConfig} ProviderConfig
 */

/**
 * @param {string | ContentPart[]} content
 */
const toAnthropicUserContent = (content) => {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return part.source.kind === "base64"
        ? {
            type: "image",
            source: { type: "base64", media_type: part.source.mediaType, data: part.source.data },
          }
        : { type: "image", source: { type: "url", url: part.source.url } };
    }
    if (part.type === "document") {
      return part.source.kind === "base64"
        ? {
            type: "document",
            source: { type: "base64", media_type: part.source.mediaType, data: part.source.data },
          }
        : { type: "document", source: { type: "url", url: part.source.url } };
    }
    if (part.type === "audio") {
      throw new Error("Anthropic does not support audio input on the Messages API");
    }
    return part;
  });
};

/**
 * @param {string} [configApiKey]
 * @returns {string}
 */
const getApiKey = (configApiKey) => {
  if (configApiKey) return configApiKey;
  try {
    return getKey("anthropic");
  } catch {
    const key = process.env.ANTHROPIC_API_KEY || "";
    if (!key) throw new Error("Anthropic API key not found");
    return key;
  }
};

/**
 * @param {Message[]} messages
 */
const convertToAnthropicFormat = (messages) => {
  const result = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "system") {
      i++;
      continue;
    }

    if (msg.role === "assistant") {
      // thinking blocks must be replayed verbatim (signature included) or the
      // API rejects tool-use continuations of extended-thinking turns
      const thinking = Array.isArray(msg._thinking) ? msg._thinking : [];
      if (msg.tool_calls) {
        const content = msg.tool_calls.map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        }));
        // preserve any assistant text that accompanied the tool calls
        if (typeof msg.content === "string" && msg.content) {
          content.unshift({ type: "text", text: msg.content });
        }
        result.push({ role: "assistant", content: [...thinking, ...content] });
      } else if (thinking.length > 0) {
        const content = [...thinking];
        if (typeof msg.content === "string" && msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        result.push({ role: "assistant", content });
      } else {
        result.push({ role: "assistant", content: msg.content });
      }
      i++;
    } else if (msg.role === "tool") {
      const toolResults = [];
      while (i < messages.length && messages[i].role === "tool") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: messages[i].tool_call_id,
          content: messages[i].content,
        });
        i++;
      }
      result.push({ role: "user", content: toolResults });
    } else if (msg.role === "user") {
      result.push({ role: "user", content: toAnthropicUserContent(msg.content) });
      i++;
    } else {
      result.push(msg);
      i++;
    }
  }

  return result;
};

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 16384, max: 32000 };

export const callAnthropic = async (config, ctx) => {
  const { model, instructions, schema, apiKey: configApiKey, maxTokens, effort } = config;
  const apiKey = getApiKey(configApiKey);

  let system = instructions;
  if (ctx.history[0]?.role === "system") {
    const sc = ctx.history[0].content;
    system = typeof sc === "string" ? sc : undefined;
  }

  const messages = convertToAnthropicFormat(ctx.history);

  if (schema) {
    const schemaPrompt = `\n\nYou must respond with valid JSON that matches this schema:\n${JSON.stringify(
      schema.schema,
      null,
      2,
    )}\n\nReturn only the JSON object, no other text or formatting.`;
    system = system ? system + schemaPrompt : schemaPrompt.slice(2);
  }

  // the messages API requires max_tokens. 8192 is safe on every current claude
  // model without triggering the must-stream threshold; raise it via maxTokens
  const budget = THINKING_BUDGETS[effort];
  const body = {
    model,
    messages,
    // thinking budget must be strictly below max_tokens, so leave room above it
    max_tokens: budget ? Math.max(maxTokens ?? 8192, budget + 8192) : maxTokens ?? 8192,
    stream: !!ctx.stream,
  };
  if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
  if (system) body.system = system;

  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = ctx.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: ctx.abortSignal,
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${await response.text()}`);
  }

  if (ctx.stream) {
    return handleAnthropicStream(response, ctx);
  }

  const data = await response.json();

  // a single response can hold multiple content blocks (text plus one or more
  // tool_use). accumulate text and collect every tool call, not just the first
  let content = "";
  const toolCalls = [];
  const thinkingBlocks = [];
  for (const block of data.content || []) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      thinkingBlocks.push(block);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }

  /** @type {Message & { tool_calls?: any[] }} */
  const msg = { role: "assistant", content };
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls;
  }
  if (thinkingBlocks.length > 0) {
    msg._thinking = thinkingBlocks;
  }

  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const cachedTokens = data.usage?.cache_read_input_tokens || 0;

  return {
    ...ctx,
    lastResponse: msg,
    history: [...ctx.history, msg],
    usage: addUsage(ctx.usage, inputTokens, outputTokens, inputTokens + outputTokens, cachedTokens),
  };
};

/**
 * @param {Response} response
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
const handleAnthropicStream = async (response, ctx) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let fullContent = "";
  const toolCalls = [];
  const thinkingBlocks = [];
  let currentThinking = null;
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

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
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.type === "message_start" && parsed.message?.usage) {
            inputTokens = parsed.message.usage.input_tokens || 0;
            cachedTokens = parsed.message.usage.cache_read_input_tokens || 0;
          }

          if (parsed.type === "message_delta" && parsed.usage) {
            outputTokens = parsed.usage.output_tokens || 0;
          }

          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            fullContent += parsed.delta.text;
            ctx.stream?.({ type: "content", content: parsed.delta.text });
          }

          if (parsed.type === "content_block_start" && parsed.content_block?.type === "thinking") {
            currentThinking = { type: "thinking", thinking: "", signature: "" };
          }
          if (parsed.type === "content_block_start" && parsed.content_block?.type === "redacted_thinking") {
            thinkingBlocks.push(parsed.content_block);
          }
          if (parsed.type === "content_block_delta" && parsed.delta?.type === "thinking_delta") {
            if (currentThinking) currentThinking.thinking += parsed.delta.thinking;
            ctx.stream?.({ type: "thinking", content: parsed.delta.thinking });
          }
          if (parsed.type === "content_block_delta" && parsed.delta?.type === "signature_delta") {
            if (currentThinking) currentThinking.signature += parsed.delta.signature;
          }
          if (parsed.type === "content_block_stop" && currentThinking) {
            thinkingBlocks.push(currentThinking);
            currentThinking = null;
          }

          if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
            const toolUse = parsed.content_block;
            toolCalls.push({
              id: toolUse.id,
              type: "function",
              function: { name: toolUse.name, arguments: "" },
              index: parsed.index,
            });
            ctx.stream?.({ type: "tool_call_start", index: parsed.index, name: toolUse.name });
          }

          if (
            parsed.type === "content_block_delta" &&
            parsed.delta?.type === "input_json_delta"
          ) {
            const toolCall = toolCalls.find((tc) => tc.index === parsed.index);
            if (toolCall) {
              toolCall.function.arguments += parsed.delta.partial_json;
              ctx.stream?.({
                type: "tool_call_delta",
                index: parsed.index,
                name: toolCall.function.name,
                argumentDelta: parsed.delta.partial_json,
                argumentsSoFar: toolCall.function.arguments,
              });
            }
          }
        } catch {
          // skip invalid JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  /** @type {Message & { tool_calls?: any[] }} */
  const msg = { role: "assistant", content: fullContent };
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls.map(({ index, ...tc }) => tc);
  }
  if (thinkingBlocks.length > 0) {
    msg._thinking = thinkingBlocks;
  }

  const usage = addUsage(ctx.usage, inputTokens, outputTokens, inputTokens + outputTokens, cachedTokens);

  if (ctx.stream && (inputTokens || outputTokens)) {
    ctx.stream({ type: "usage", usage });
  }

  return { ...ctx, lastResponse: msg, history: [...ctx.history, msg], usage };
};

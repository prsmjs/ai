import { addUsage, getKey } from "../utils.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").ContentPart} ContentPart
 * @typedef {import("../types.js").MediaSource} MediaSource
 * @typedef {import("../types.js").Message} Message
 * @typedef {import("../types.js").ProviderConfig} ProviderConfig
 */

/**
 * @param {MediaSource} source
 */
const mediaSourceToXAIUrl = (source) =>
  source.kind === "url" ? source.url : `data:${source.mediaType};base64,${source.data}`;

/**
 * @param {string | ContentPart[]} content
 */
const toXAIContent = (content) => {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return { type: "image_url", image_url: { url: mediaSourceToXAIUrl(part.source) } };
    }
    if (part.type === "document") {
      throw new Error("xAI does not support document/PDF input on the chat completions API");
    }
    if (part.type === "audio") {
      throw new Error("xAI does not support audio input on the chat completions API");
    }
    return part;
  });
};

/**
 * @param {Message[]} history
 */
const toXAIMessages = (history) =>
  history.map((msg) => (msg.role === "user" ? { ...msg, content: toXAIContent(msg.content) } : msg));

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

/**
 * @param {string} [configApiKey]
 * @returns {string}
 */
const getApiKey = (configApiKey) => {
  if (configApiKey) return configApiKey;
  try {
    return getKey("xai");
  } catch {
    const key = process.env.XAI_API_KEY || "";
    if (!key) throw new Error("xAI API key not found");
    return key;
  }
};

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callXAI = async (config, ctx) => {
  const { model, instructions, schema, apiKey: configApiKey } = config;
  const apiKey = getApiKey(configApiKey);

  const messages = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  messages.push(...toXAIMessages(ctx.history));

  const body = {
    model,
    messages,
    stream: !!ctx.stream,
    ...(ctx.stream && { stream_options: { include_usage: true } }),
  };

  if (schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: schema.name,
        schema: { ...schema.schema, additionalProperties: false },
        strict: true,
      },
    };
  }

  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = ctx.tools;
    body.tool_choice = "auto";
  }

  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: ctx.abortSignal,
  });

  if (!response.ok) {
    throw new Error(`xAI API error: ${await response.text()}`);
  }

  if (ctx.stream) {
    return handleXAIStream(response, ctx);
  }

  const data = await response.json();
  const { message } = data.choices[0];

  /** @type {Message & { tool_calls?: any[] }} */
  const msg = { role: "assistant", content: message.content || "" };
  if (message.tool_calls) {
    msg.tool_calls = message.tool_calls;
  }

  return {
    ...ctx,
    lastResponse: msg,
    history: [...ctx.history, msg],
    usage: addUsage(
      ctx.usage,
      data.usage?.prompt_tokens || 0,
      data.usage?.completion_tokens || 0,
      data.usage?.total_tokens || 0,
      data.usage?.prompt_tokens_details?.cached_tokens || 0,
    ),
  };
};

/**
 * @param {Response} response
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
const handleXAIStream = async (response, ctx) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let fullContent = "";
  let toolCalls = [];
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

        try {
          const parsed = JSON.parse(data);

          if (parsed.usage) streamUsage = parsed.usage;

          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            fullContent += delta.content;
            ctx.stream?.({ type: "content", content: delta.content });
          }

          if (delta?.tool_calls) {
            toolCalls = appendToolCalls(toolCalls, delta.tool_calls);
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
    msg.tool_calls = toolCalls;
  }

  const usage = addUsage(
    ctx.usage,
    streamUsage?.prompt_tokens || 0,
    streamUsage?.completion_tokens || 0,
    streamUsage?.total_tokens || 0,
    streamUsage?.prompt_tokens_details?.cached_tokens || 0,
  );

  if (ctx.stream && streamUsage) {
    ctx.stream({ type: "usage", usage });
  }

  return { ...ctx, lastResponse: msg, history: [...ctx.history, msg], usage };
};

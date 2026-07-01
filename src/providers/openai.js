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
const mediaSourceToOpenAIUrl = (source) =>
  source.kind === "url" ? source.url : `data:${source.mediaType};base64,${source.data}`;

/**
 * @param {string} mediaType
 * @returns {"wav" | "mp3"}
 */
const mediaTypeToAudioFormat = (mediaType) => {
  const mt = mediaType.toLowerCase();
  if (mt === "audio/wav" || mt === "audio/wave" || mt === "audio/x-wav") return "wav";
  if (mt === "audio/mp3" || mt === "audio/mpeg" || mt === "audio/mpeg3") return "mp3";
  throw new Error(`OpenAI audio input only supports wav or mp3, got: ${mediaType}`);
};

/**
 * @param {string | ContentPart[]} content
 */
const toOpenAIContent = (content) => {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return { type: "image_url", image_url: { url: mediaSourceToOpenAIUrl(part.source) } };
    }
    if (part.type === "document") {
      if (part.source.kind !== "base64") {
        throw new Error(
          "OpenAI document input requires base64 source; upload via Files API and use a text reference instead",
        );
      }
      return {
        type: "file",
        file: {
          filename: part.filename || "document.pdf",
          file_data: `data:${part.source.mediaType};base64,${part.source.data}`,
        },
      };
    }
    if (part.type === "audio") {
      if (part.source.kind !== "base64") {
        throw new Error("OpenAI audio input requires base64 source");
      }
      return {
        type: "input_audio",
        input_audio: {
          data: part.source.data,
          format: mediaTypeToAudioFormat(part.source.mediaType),
        },
      };
    }
    return part;
  });
};

// system messages are carried separately as instructions, so drop them from
// history to avoid sending the system prompt twice
/**
 * @param {Message[]} history
 */
const toOpenAIMessages = (history) =>
  history
    .filter((msg) => msg.role !== "system")
    .map((msg) => (msg.role === "user" ? { ...msg, content: toOpenAIContent(msg.content) } : msg));

/**
 * @param {Message[]} history
 */
const hasAudioPart = (history) =>
  history.some(
    (msg) => typeof msg.content !== "string" && msg.content.some((part) => part.type === "audio"),
  );

/**
 * @param {string} [configApiKey]
 * @returns {string | undefined}
 */
const getApiKey = (configApiKey) => {
  if (configApiKey) return configApiKey;
  try {
    return getKey("openai");
  } catch {
    return process.env.OPENAI_API_KEY || undefined;
  }
};

// openai streams tool calls as incremental chunks keyed by index that need assembly.
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

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callOpenAI = async (config, ctx) => {
  const { model, instructions, schema, apiKey: configApiKey, baseUrl } = config;
  const apiKey = getApiKey(configApiKey);
  const endpoint = baseUrl || "https://api.openai.com/v1";

  const messages = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  messages.push(...toOpenAIMessages(ctx.history));

  const body = {
    model,
    messages,
    stream: !!ctx.stream,
    ...(ctx.stream && { stream_options: { include_usage: true } }),
    ...(hasAudioPart(ctx.history) && { modalities: ["text"] }),
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

  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: ctx.abortSignal,
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${await response.text()}`);
  }

  if (ctx.stream) {
    return handleOpenAIStream(response, ctx);
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
const handleOpenAIStream = async (response, ctx) => {
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
            for (const tcchunk of delta.tool_calls) {
              const tc = toolCalls[tcchunk.index];
              if (tcchunk.function?.name) {
                ctx.stream?.({
                  type: "tool_call_start",
                  index: tcchunk.index,
                  name: tc?.function?.name || "",
                });
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

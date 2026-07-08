import { addUsage, getKey } from "../utils.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").ContentPart} ContentPart
 * @typedef {import("../types.js").Message} Message
 * @typedef {import("../types.js").ProviderConfig} ProviderConfig
 */

const GOOGLE_MIME_ALIASES = {
  "audio/mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
};

const normalizeGoogleMime = (mediaType) =>
  GOOGLE_MIME_ALIASES[mediaType.toLowerCase()] || mediaType;

/**
 * @param {string | ContentPart[]} content
 */
const toGoogleParts = (content) => {
  if (typeof content === "string") return [{ text: content }];
  return content.map((part) => {
    if (part.type === "text") return { text: part.text };
    if (part.source.kind === "base64") {
      return {
        inline_data: { mime_type: normalizeGoogleMime(part.source.mediaType), data: part.source.data },
      };
    }
    return { file_data: { file_uri: part.source.url } };
  });
};

/**
 * @param {string} [configApiKey]
 * @returns {string}
 */
const getApiKey = (configApiKey) => {
  if (configApiKey) return configApiKey;
  try {
    return getKey("google");
  } catch {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
    if (!key) throw new Error("Google API key not found");
    return key;
  }
};

// google has no native tool-call id, so we mint a short random one and map
// it back to the function name when building the tool response turn
const randomId = () => Math.random().toString(36).substring(2, 9);

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callGoogle = async (config, ctx) => {
  const { model, instructions, apiKey: configApiKey, maxTokens } = config;
  const apiKey = getApiKey(configApiKey);

  const contents = [];
  const toolCallMap = new Map();

  for (let i = 0; i < ctx.history.length; i++) {
    const msg = ctx.history[i];

    if (msg.role === "assistant") {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });

      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          toolCallMap.set(tc.id, tc.function.name);
          const part = {
            functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) },
          };
          if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
          parts.push(part);
        }
      }

      if (parts.length > 0) contents.push({ role: "model", parts });
    } else if (msg.role === "tool") {
      const responseParts = [];

      while (i < ctx.history.length && ctx.history[i].role === "tool") {
        const toolMsg = ctx.history[i];
        const functionName = toolCallMap.get(toolMsg.tool_call_id);
        if (functionName) {
          let responseData;
          try {
            responseData = JSON.parse(toolMsg.content);
          } catch {
            responseData = { result: toolMsg.content };
          }
          if (Array.isArray(responseData) || typeof responseData !== "object" || responseData === null) {
            responseData = { result: responseData };
          }
          responseParts.push({ functionResponse: { name: functionName, response: responseData } });
        }
        i++;
      }
      i--;

      if (responseParts.length > 0) contents.push({ role: "user", parts: responseParts });
    } else if (msg.role === "user") {
      contents.push({ role: "user", parts: toGoogleParts(msg.content) });
    }
  }

  const body = { contents };

  if (maxTokens) {
    body.generationConfig = { maxOutputTokens: maxTokens };
  }

  if (instructions) {
    body.systemInstruction = { parts: [{ text: instructions }] };
  }

  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = [
      {
        function_declarations: ctx.tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      },
    ];
  }

  const endpoint = ctx.stream ? "streamGenerateContent" : "generateContent";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}?key=${apiKey}${ctx.stream ? "&alt=sse" : ""}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctx.abortSignal,
    },
  );

  if (!response.ok) {
    throw new Error(`Google API error: ${await response.text()}`);
  }

  if (ctx.stream) {
    return handleGoogleStream(response, ctx);
  }

  const data = await response.json();
  // candidates can be empty or content missing entirely (e.g. safety blocks)
  const parts = data.candidates?.[0]?.content?.parts || [];

  /** @type {Message & { tool_calls?: any[] }} */
  const msg = { role: "assistant", content: "" };
  const toolCalls = [];

  for (const part of parts) {
    if (part.text) msg.content += part.text;
    if (part.functionCall) {
      const tc = {
        id: randomId(),
        type: "function",
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) },
      };
      if (part.thoughtSignature) tc.thoughtSignature = part.thoughtSignature;
      toolCalls.push(tc);
    }
  }

  if (toolCalls.length > 0) msg.tool_calls = toolCalls;

  const um = data.usageMetadata;

  return {
    ...ctx,
    lastResponse: msg,
    history: [...ctx.history, msg],
    usage: addUsage(
      ctx.usage,
      um?.promptTokenCount || 0,
      um?.candidatesTokenCount || 0,
      um?.totalTokenCount || 0,
      um?.cachedContentTokenCount || 0,
    ),
  };
};

/**
 * @param {Response} response
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
const handleGoogleStream = async (response, ctx) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let fullContent = "";
  const toolCalls = [];
  let buffer = "";
  let usageMetadata = null;

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

          if (parsed.usageMetadata) usageMetadata = parsed.usageMetadata;

          const parts = parsed.candidates?.[0]?.content?.parts || [];

          for (const part of parts) {
            if (part?.text) {
              fullContent += part.text;
              ctx.stream?.({ type: "content", content: part.text });
            }

            if (part?.functionCall) {
              const tc = {
                id: randomId(),
                type: "function",
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args),
                },
              };
              if (part.thoughtSignature) tc.thoughtSignature = part.thoughtSignature;
              toolCalls.push(tc);
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
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;

  const um = usageMetadata;
  const usage = addUsage(
    ctx.usage,
    um?.promptTokenCount || 0,
    um?.candidatesTokenCount || 0,
    um?.totalTokenCount || 0,
    um?.cachedContentTokenCount || 0,
  );

  if (ctx.stream && um) {
    ctx.stream({ type: "usage", usage });
  }

  return { ...ctx, lastResponse: msg, history: [...ctx.history, msg], usage };
};

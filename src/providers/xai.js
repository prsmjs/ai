import { getKey } from "../utils.js";
import { transportOptions } from "./http.js";
import { toChatMessages } from "./chat-messages.js";
import { callChatCompletions } from "./chat-completions.js";

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
export const callXAI = (config, ctx) => {
  const { model, instructions, schema, apiKey: configApiKey, maxTokens } = config;
  const apiKey = getApiKey(configApiKey);

  const messages = [
    ...(instructions ? [{ role: "system", content: instructions }] : []),
    ...toChatMessages(ctx.history, { convertUserContent: toXAIContent }),
  ];

  const body = {
    model,
    messages,
    ...(maxTokens && { max_tokens: maxTokens }),
    ...(schema && {
      response_format: {
        type: "json_schema",
        json_schema: { name: schema.name, schema: { ...schema.schema, additionalProperties: false }, strict: true },
      },
    }),
  };

  return callChatCompletions({
    url: "https://api.x.ai/v1/chat/completions",
    label: "xAI",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    transport: transportOptions(config, ctx),
  }, ctx);
};

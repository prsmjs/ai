import { getKey } from "../utils.js";
import { transportOptions } from "./http.js";
import { toChatMessages } from "./chat-messages.js";
import { callChatCompletions } from "./chat-completions.js";
import { hasAudioPart, toOpenAIContent } from "./openai.js";
import { toStrictSchema } from "./strict-schema.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").Message} Message
 * @typedef {import("../types.js").ProviderConfig} ProviderConfig
 */

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// openrouter normalizes effort across upstreams. "auto" leaves reasoning to
// the model's own default, so no reasoning field is sent for it
const REASONING_EFFORTS = { low: "low", medium: "medium", high: "high", max: "max" };

/**
 * @param {string} [configApiKey]
 * @returns {string}
 */
const getApiKey = (configApiKey) => {
  if (configApiKey) return configApiKey;
  try {
    return getKey("openrouter");
  } catch {
    const key = process.env.OPENROUTER_API_KEY || "";
    if (!key) throw new Error("OpenRouter API key not found");
    return key;
  }
};

// signed thinking and thought signatures must go back verbatim or upstream
// providers reject (or silently degrade) tool-use continuations
/**
 * @param {Message & { _reasoning_details?: any[] }} message
 */
const replayReasoning = (message) =>
  message._reasoning_details?.length ? { reasoning_details: message._reasoning_details } : {};

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callOpenRouter = (config, ctx) => {
  const { model, instructions, schema, apiKey: configApiKey, baseUrl, maxTokens, effort, headers } = config;
  const apiKey = getApiKey(configApiKey);

  const messages = [
    ...(instructions ? [{ role: "system", content: instructions }] : []),
    ...toChatMessages(ctx.history, { convertUserContent: toOpenAIContent, assistantExtras: replayReasoning }),
  ];

  const body = {
    model,
    messages,
    ...(hasAudioPart(ctx.history) && { modalities: ["text"] }),
    ...(maxTokens && { max_tokens: maxTokens }),
    ...(REASONING_EFFORTS[effort] && { reasoning: { effort: REASONING_EFFORTS[effort] } }),
    ...(schema && {
      response_format: {
        type: "json_schema",
        json_schema: { name: schema.name, schema: toStrictSchema(schema.schema), strict: true },
      },
    }),
  };

  return callChatCompletions({
    url: `${baseUrl || DEFAULT_BASE_URL}/chat/completions`,
    label: "OpenRouter",
    headers: { Authorization: `Bearer ${apiKey}`, ...headers },
    body,
    transport: transportOptions(config, ctx),
  }, ctx);
};

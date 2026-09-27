import { getKey } from "../utils.js";
import { request, transportOptions } from "./http.js";
import { toChatMessages } from "./chat-messages.js";
import { callChatCompletions } from "./chat-completions.js";
import { handleResponsesStream, toResponsesInput, toResponsesTools } from "./responses.js";
import { toStrictSchema } from "./strict-schema.js";

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
export const toOpenAIContent = (content) => {
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

/**
 * @param {Message[]} history
 */
export const hasAudioPart = (history) =>
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

const REASONING_EFFORTS = { low: "low", medium: "medium", high: "high", max: "high" };

/**
 * an OpenAI-compatible chat completions server at config.baseUrl (ollama,
 * lm studio, vllm and the like)
 *
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
const callOpenAICompatible = (config, ctx) => {
  const { model, instructions, schema, apiKey: configApiKey, baseUrl, maxTokens } = config;
  const apiKey = getApiKey(configApiKey);

  const messages = [
    ...(instructions ? [{ role: "system", content: instructions }] : []),
    ...toChatMessages(ctx.history, { convertUserContent: toOpenAIContent }),
  ];

  const body = {
    model,
    messages,
    ...(hasAudioPart(ctx.history) && { modalities: ["text"] }),
    ...(maxTokens && { max_tokens: maxTokens }),
    ...(schema && {
      response_format: {
        type: "json_schema",
        json_schema: { name: schema.name, schema: toStrictSchema(schema.schema), strict: true },
      },
    }),
  };

  return callChatCompletions({
    url: `${baseUrl}/chat/completions`,
    label: "OpenAI",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body,
    transport: transportOptions(config, ctx),
  }, ctx);
};

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callOpenAI = async (config, ctx) => {
  if (config.baseUrl) return callOpenAICompatible(config, ctx);

  const { model, instructions, schema, apiKey: configApiKey, maxTokens, effort } = config;
  const apiKey = getApiKey(configApiKey);
  const body = {
    model,
    instructions: instructions || "",
    input: toResponsesInput(ctx.history),
    store: false,
    stream: true,
    parallel_tool_calls: false,
    ...(maxTokens && { max_output_tokens: maxTokens }),
  };

  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = toResponsesTools(ctx.tools);
    body.tool_choice = "auto";
  }
  if (REASONING_EFFORTS[effort]) {
    body.reasoning = { effort: REASONING_EFFORTS[effort], summary: "auto" };
  }
  if (schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: schema.name,
        schema: toStrictSchema(schema.schema),
        strict: true,
      },
    };
  }

  const response = await request("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(body),
  }, transportOptions(config, ctx));

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${await response.text()}`);
  }
  return handleResponsesStream(response, ctx, "OpenAI");
};

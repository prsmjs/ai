import { isStandardSchema, convertStandardSchemaToSchemaProperties } from "./schema.js";

/**
 * @typedef {import("./types.js").ApiKeys} ApiKeys
 * @typedef {import("./types.js").ContentPart} ContentPart
 * @typedef {import("./types.js").MediaSource} MediaSource
 * @typedef {import("./types.js").Message} Message
 * @typedef {import("./types.js").ParsedModel} ParsedModel
 * @typedef {import("./types.js").SchemaProperty} SchemaProperty
 * @typedef {import("./types.js").TokenUsage} TokenUsage
 * @typedef {import("./types.js").ToolConfig} ToolConfig
 * @typedef {import("./types.js").ToolDefinition} ToolDefinition
 */

/**
 * @param {ToolConfig} tool
 * @returns {ToolDefinition}
 */
export const toolConfigToToolDefinition = (tool) => {
  const schema = isStandardSchema(tool.schema)
    ? convertStandardSchemaToSchemaProperties(tool.schema)
    : tool.schema;

  const properties = {};
  const required = [];

  for (const [key, prop] of Object.entries(schema)) {
    properties[key] = convertSchemaProperty(prop);
    if (!prop.optional) {
      required.push(key);
    }
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 && { required }),
      },
    },
  };
};

/**
 * @param {SchemaProperty} prop
 */
const convertSchemaProperty = (prop) => {
  const result = { type: prop.type };

  if (prop.description) result.description = prop.description;
  if (prop.enum) result.enum = prop.enum;
  if (prop.items) result.items = convertSchemaProperty(prop.items);

  if (prop.properties) {
    result.properties = {};
    for (const [key, childProp] of Object.entries(prop.properties)) {
      result.properties[key] = convertSchemaProperty(childProp);
    }
  }

  return result;
};

/**
 * @param {string} model
 * @returns {ParsedModel}
 */
export const parseModelName = (model) => {
  const parts = model.split("/");

  if (parts.length === 1) {
    return { provider: "huggingface", model: parts[0] };
  }

  return { provider: parts[0], model: parts.slice(1).join("/") };
};

/** @type {ApiKeys} */
let globalKeys = {};

/**
 * @param {ApiKeys} keys
 */
export const setKeys = (keys) => {
  globalKeys = { ...globalKeys, ...keys };
};

/**
 * @param {string} provider
 * @returns {string}
 */
export const getKey = (provider) => {
  const key = globalKeys[provider.toLowerCase()];
  if (!key) {
    throw new Error(`No API key configured for provider: ${provider}`);
  }
  return key;
};

/**
 * @param {ToolConfig} toolConfig
 * @param {number} max
 * @returns {ToolConfig}
 */
export const maxCalls = (toolConfig, max) => ({ ...toolConfig, _maxCalls: max });

/**
 * @param {string | ContentPart[]} content
 * @returns {string}
 */
export const getText = (content) => {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
};

/**
 * build a user message with optional images, documents, and audio
 *
 * @param {string} text
 * @param {{ images?: (MediaSource | string)[], documents?: ({ source: MediaSource, filename?: string } | MediaSource | string)[], audio?: MediaSource[] }} [opts]
 * @returns {Message}
 */
export const message = (text, opts) => {
  const images = opts?.images || [];
  const documents = opts?.documents || [];
  const audio = opts?.audio || [];

  if (images.length === 0 && documents.length === 0 && audio.length === 0) {
    return { role: "user", content: text };
  }

  /** @type {ContentPart[]} */
  const parts = [{ type: "text", text }];

  for (const img of images) {
    parts.push(
      typeof img === "string"
        ? { type: "image", source: { kind: "url", url: img } }
        : { type: "image", source: img },
    );
  }

  for (const doc of documents) {
    if (typeof doc === "string") {
      parts.push({ type: "document", source: { kind: "url", url: doc } });
    } else if ("source" in doc) {
      parts.push({ type: "document", source: doc.source, filename: doc.filename });
    } else {
      parts.push({ type: "document", source: doc });
    }
  }

  for (const clip of audio) {
    parts.push({ type: "audio", source: clip });
  }

  return { role: "user", content: parts };
};

/**
 * @param {TokenUsage | undefined} existing
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @param {number} totalTokens
 * @param {number} [cachedTokens]
 * @returns {TokenUsage}
 */
export const addUsage = (existing, promptTokens, completionTokens, totalTokens, cachedTokens = 0, thoughtTokens = 0) => ({
  promptTokens: (existing?.promptTokens || 0) + promptTokens,
  completionTokens: (existing?.completionTokens || 0) + completionTokens,
  totalTokens: (existing?.totalTokens || 0) + totalTokens,
  cachedTokens: (existing?.cachedTokens || 0) + cachedTokens,
  thoughtTokens: (existing?.thoughtTokens || 0) + thoughtTokens,
});

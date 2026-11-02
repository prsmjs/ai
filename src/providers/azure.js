import { getKey } from "../utils.js";
import { callResponsesAPI } from "./openai.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").ProviderConfig} ProviderConfig
 */

// azure openai's v1 endpoint speaks the same Responses API as openai, at
// https://<resource>.openai.azure.com/openai/v1, with the deployment name as
// the model. it authenticates with an api-key header, or with an entra id
// bearer token that the caller passes as headers.Authorization

/**
 * @param {ProviderConfig} config
 * @returns {string}
 */
const getBaseUrl = (config) => {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  if (process.env.AZURE_OPENAI_BASE_URL) return process.env.AZURE_OPENAI_BASE_URL.replace(/\/+$/, "");
  if (process.env.AZURE_OPENAI_ENDPOINT) {
    return `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, "")}/openai/v1`;
  }
  throw new Error(
    "Azure OpenAI requires baseUrl (https://<resource>.openai.azure.com/openai/v1), AZURE_OPENAI_BASE_URL, or AZURE_OPENAI_ENDPOINT",
  );
};

/**
 * @param {string} [configApiKey]
 * @returns {string | undefined}
 */
const getApiKey = (configApiKey) => {
  if (configApiKey) return configApiKey;
  try {
    return getKey("azure");
  } catch {
    return process.env.AZURE_OPENAI_API_KEY || undefined;
  }
};

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callAzure = (config, ctx) => {
  const headers = config.headers || {};
  const hasBearer = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
  const apiKey = hasBearer ? undefined : getApiKey(config.apiKey);
  if (!hasBearer && !apiKey) {
    throw new Error(
      "Azure OpenAI requires an API key (apiKey, setKeys({ azure }), or AZURE_OPENAI_API_KEY) or an Entra ID token in headers.Authorization",
    );
  }

  return callResponsesAPI({
    url: `${getBaseUrl(config)}/responses`,
    label: "Azure OpenAI",
    headers: { ...(apiKey && { "api-key": apiKey }), ...headers },
  }, config, ctx);
};

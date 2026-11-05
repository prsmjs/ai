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

const trimSlashes = (url) => url.replace(/\/+$/, "");

/**
 * @param {ProviderConfig} config
 * @returns {string}
 */
const getBaseUrl = (config) => {
  if (config.baseUrl) return trimSlashes(config.baseUrl);
  if (process.env.AZURE_OPENAI_BASE_URL) return trimSlashes(process.env.AZURE_OPENAI_BASE_URL);
  if (process.env.AZURE_OPENAI_ENDPOINT) {
    // the portal shows both the resource root and the full v1 url; accept either
    const endpoint = trimSlashes(process.env.AZURE_OPENAI_ENDPOINT);
    return /\/openai\/v1$/i.test(endpoint) ? endpoint : `${endpoint}/openai/v1`;
  }
  throw new Error(
    "Azure OpenAI requires baseUrl (https://<resource>.openai.azure.com/openai/v1), AZURE_OPENAI_BASE_URL, or AZURE_OPENAI_ENDPOINT",
  );
};

/**
 * a key from setKeys or the environment. an explicit config.apiKey is
 * handled by the caller, since it always wins
 *
 * @returns {string | undefined}
 */
const getAmbientApiKey = () => {
  try {
    return getKey("azure");
  } catch {
    return process.env.AZURE_OPENAI_API_KEY || undefined;
  }
};

/**
 * @param {Record<string, string | undefined>} headers
 * @returns {boolean} whether the caller already supplied credentials
 */
const hasCallerAuth = (headers) =>
  Object.entries(headers).some(
    ([name, value]) => ["authorization", "api-key"].includes(name.toLowerCase()) && Boolean(value),
  );

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callAzure = (config, ctx) => {
  const headers = config.headers || {};
  // an explicit apiKey is always sent. a key from setKeys or the environment
  // gives way to credentials the caller put in headers (an entra id token)
  const apiKey = config.apiKey || (hasCallerAuth(headers) ? undefined : getAmbientApiKey());
  if (!apiKey && !hasCallerAuth(headers)) {
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

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
 * @param {string} value
 * @param {string} source the setting it came from, for the error message
 * @returns {URL}
 */
const parseBaseUrl = (value, source) => {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Azure OpenAI ${source} is not a valid URL: ${value}`);
  }
};

/**
 * append to a url's path, keeping its query string (such as
 * ?api-version=preview) after the new path
 *
 * @param {URL} url
 * @param {string} suffix
 */
const appendPath = (url, suffix) => {
  url.pathname = url.pathname.replace(/\/+$/, "") + suffix;
};

/**
 * @param {ProviderConfig} config
 * @returns {string} the Responses endpoint, keeping any query from baseUrl
 */
const getResponsesUrl = (config) => {
  if (!config.baseUrl) {
    throw new Error("Azure OpenAI requires baseUrl (https://<resource>.openai.azure.com/openai/v1)");
  }
  const url = parseBaseUrl(config.baseUrl, "baseUrl");
  appendPath(url, "/responses");
  return url.toString();
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
    url: getResponsesUrl(config),
    label: "Azure OpenAI",
    headers: { ...(apiKey && { "api-key": apiKey }), ...headers },
  }, config, ctx);
};

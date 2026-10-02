import { parseModelName } from "../utils.js";
import { callOpenAI } from "./openai.js";
import { callAnthropic } from "./anthropic.js";
import { callGoogle } from "./google.js";
import { callHuggingFace } from "./huggingface.js";
import { callXAI } from "./xai.js";
import { callCodex } from "./codex.js";
import { callOpenRouter } from "./openrouter.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").ProviderConfig} ProviderConfig
 */

// OpenAI-compatible local servers. an explicit baseUrl always wins over these defaults
const LOCAL_BASE_URLS = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  local: "http://localhost:1234/v1",
};

/**
 * route a provider config to the right provider based on its "provider/model" prefix
 *
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callProvider = async (config, ctx) => {
  const { provider, model } = parseModelName(config.model);
  const providerConfig = { ...config, model };
  const key = provider.toLowerCase();

  if (config.speed !== undefined) {
    if (config.speed !== "standard" && config.speed !== "fast") {
      throw new Error(`Invalid speed: ${config.speed}`);
    }
    if (key !== "codex") throw new Error(`Speed is not supported by provider: ${provider}`);
  }

  switch (key) {
    case "openai":
      return callOpenAI(providerConfig, ctx);
    case "anthropic":
      return callAnthropic(providerConfig, ctx);
    case "google":
      return callGoogle(providerConfig, ctx);
    case "xai":
      return callXAI(providerConfig, ctx);
    case "codex":
      return callCodex(providerConfig, ctx);
    case "openrouter":
      return callOpenRouter(providerConfig, ctx);
    case "ollama":
    case "lmstudio":
    case "local":
      return callOpenAI(
        { ...providerConfig, baseUrl: providerConfig.baseUrl || LOCAL_BASE_URLS[key] },
        ctx,
      );
    case "huggingface":
      return callHuggingFace(providerConfig, ctx);
    default:
      // unrecognized prefix - treat the full name as a local HuggingFace model
      return callHuggingFace({ ...config }, ctx);
  }
};

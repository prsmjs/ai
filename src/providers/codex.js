import { handleResponsesStream, toResponsesInput, toResponsesTools } from "./responses.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").ProviderConfig} ProviderConfig
 */

// the codex provider talks to the ChatGPT Codex backend (Responses API wire
// format) using OAuth credentials from a ChatGPT subscription rather than a
// platform API key. pass the access token as apiKey and the account id via
// headers: { "chatgpt-account-id": ... }
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";

const REASONING_EFFORTS = { low: "low", medium: "medium", high: "high", max: "high" };

export const toCodexInput = toResponsesInput;
export const toCodexTools = toResponsesTools;

/**
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callCodex = async (config, ctx) => {
  const { model, instructions, apiKey, baseUrl, maxTokens, effort, headers } = config;
  if (!apiKey) {
    throw new Error("Codex provider requires a ChatGPT OAuth access token passed as apiKey");
  }

  const body = {
    model,
    instructions: instructions || "",
    input: toCodexInput(ctx.history),
    store: false,
    stream: true,
    parallel_tool_calls: false,
    ...(maxTokens && { max_output_tokens: maxTokens }),
  };
  if (ctx.tools && ctx.tools.length > 0) {
    body.tools = toCodexTools(ctx.tools);
    body.tool_choice = "auto";
  }
  // codex models are reasoning models; always ask for summaries so thinking is
  // observable, and pin the effort only when one was requested
  body.reasoning = {
    summary: "auto",
    ...(REASONING_EFFORTS[effort] && { effort: REASONING_EFFORTS[effort] }),
  };

  const response = await fetch(`${baseUrl || DEFAULT_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: ctx.abortSignal,
  });

  if (!response.ok) {
    throw new Error(`Codex API error: ${response.status} ${await response.text()}`);
  }

  return handleResponsesStream(response, ctx, "Codex");
};

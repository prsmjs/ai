import { getText } from "./utils.js";
import { when } from "./composition/when.js";

/**
 * @typedef {import("./types.js").ConversationContext} ConversationContext
 * @typedef {import("./types.js").StepFunction} StepFunction
 */

/**
 * predicate that holds when the last response requested no tools
 *
 * @example
 * scope({ until: noToolsCalled(), tools: [...] }, model())
 *
 * @returns {(ctx: ConversationContext) => boolean}
 */
export const noToolsCalled = () => (ctx) =>
  !ctx.lastResponse?.tool_calls || ctx.lastResponse.tool_calls.length === 0;

/**
 * run a step each time the message count crosses a multiple of n
 *
 * @param {number} n
 * @param {StepFunction} step
 * @returns {StepFunction}
 */
export const everyNMessages = (n, step) => {
  let lastTriggeredAt = 0;

  return when(
    (ctx) => Math.floor(ctx.history.length / n) > Math.floor(lastTriggeredAt / n),
    async (ctx) => {
      lastTriggeredAt = ctx.history.length;
      return await step(ctx);
    },
  );
};

/**
 * run a step each time the estimated token count crosses a multiple of n
 *
 * @param {number} n
 * @param {StepFunction} step
 * @returns {StepFunction}
 */
export const everyNTokens = (n, step) => {
  let lastTriggeredAt = 0;

  const estimate = (ctx) =>
    ctx.history.reduce((acc, msg) => acc + Math.ceil(getText(msg.content).length / 4), 0);

  return when(
    (ctx) => Math.floor(estimate(ctx) / n) > Math.floor(lastTriggeredAt / n),
    async (ctx) => {
      lastTriggeredAt = estimate(ctx);
      return await step(ctx);
    },
  );
};

/**
 * append text to the most recent user message
 *
 * @param {string} content
 * @returns {StepFunction}
 */
export const appendToLastRequest = (content) => async (ctx) => {
  let lastUserIndex = -1;
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    if (ctx.history[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) return ctx;

  const newHistory = [...ctx.history];
  const existing = newHistory[lastUserIndex].content;
  newHistory[lastUserIndex] = {
    ...newHistory[lastUserIndex],
    content:
      typeof existing === "string"
        ? existing + content
        : [...existing, { type: "text", text: content }],
  };

  return { ...ctx, history: newHistory };
};

/**
 * run a step once a named tool has gone unused for `times` consecutive turns
 *
 * @example
 * toolNotUsedInNTurns({ toolName: "search_web", times: 10 }, appendToLastRequest("consider using web search..."))
 *
 * @param {{ toolName: string, times: number }} options
 * @param {StepFunction} step
 * @returns {StepFunction}
 */
export const toolNotUsedInNTurns = ({ toolName, times }, step) => {
  let turnsSinceLastUsed = 0;
  let lastProcessedTurn = -1;

  return when((ctx) => {
    const currentTurn = getCurrentTurn(ctx);

    if (currentTurn === lastProcessedTurn) return false;
    lastProcessedTurn = currentTurn;

    if (wasToolUsedInCurrentTurn(ctx, toolName)) {
      turnsSinceLastUsed = 0;
      return false;
    }

    turnsSinceLastUsed++;
    return turnsSinceLastUsed >= times;
  }, step);
};

/**
 * @param {ConversationContext} ctx
 */
const getCurrentTurn = (ctx) => {
  let turns = 0;
  for (const msg of ctx.history) {
    if (msg.role === "user") turns++;
  }
  return turns;
};

/**
 * @param {ConversationContext} ctx
 * @param {string} toolName
 */
const wasToolUsedInCurrentTurn = (ctx, toolName) => {
  let lastUserIndex = -1;
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    if (ctx.history[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) return false;

  for (let i = lastUserIndex + 1; i < ctx.history.length; i++) {
    const msg = ctx.history[i];
    if (msg.role === "assistant" && ctx.lastResponse?.tool_calls) {
      return ctx.lastResponse.tool_calls.some((call) => call.function.name === toolName);
    }
  }

  return false;
};

/**
 * predicate that holds when a named tool was called in the last response
 *
 * @param {string} name
 * @returns {(ctx: ConversationContext) => boolean}
 */
export const toolWasCalled = (name) => (ctx) =>
  !!ctx.lastResponse?.tool_calls &&
  ctx.lastResponse.tool_calls.some((call) => call.function.name === name);

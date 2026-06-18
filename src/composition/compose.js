/**
 * @typedef {import("../types.js").ComposedFunction} ComposedFunction
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").StepFunction} StepFunction
 */

/**
 * @param {ConversationContext} ctx
 * @returns {ConversationContext}
 */
const enrichContext = (ctx) => {
  const lastUserMessage = [...ctx.history].reverse().find((msg) => msg.role === "user");
  return { ...ctx, lastRequest: lastUserMessage };
};

const emptyContext = () => ({
  history: [],
  tools: [],
  toolExecutors: {},
  toolLimits: {},
  toolCallCounts: {},
});

/**
 * chain steps into a pipeline. accepts either a context or a bare string message
 *
 * @param {...StepFunction} steps
 * @returns {ComposedFunction}
 */
export const compose = (...steps) => async (ctxOrMessage) => {
  let initialContext;

  if (typeof ctxOrMessage === "string") {
    initialContext = { ...emptyContext(), history: [{ role: "user", content: ctxOrMessage }] };
  } else {
    initialContext = ctxOrMessage || emptyContext();
  }

  let next = enrichContext(initialContext);

  for (const step of steps) {
    next = await step(enrichContext(next));
  }

  return next;
};

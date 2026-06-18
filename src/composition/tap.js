/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").StepFunction} StepFunction
 */

/**
 * run a side effect without modifying the context
 *
 * @param {(ctx: ConversationContext) => Promise<void> | void} fn
 * @returns {StepFunction}
 */
export const tap = (fn) => async (ctx) => {
  await fn(ctx);
  return ctx;
};

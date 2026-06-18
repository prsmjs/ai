/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").StepFunction} StepFunction
 */

/**
 * run a step only when the condition holds, otherwise pass the context through unchanged
 *
 * @param {(ctx: ConversationContext) => boolean} condition
 * @param {StepFunction} action
 * @returns {StepFunction}
 */
export const when = (condition, action) => async (ctx) => {
  if (condition(ctx)) {
    return await action(ctx);
  }
  return ctx;
};

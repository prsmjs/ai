/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").StepFunction} StepFunction
 * @typedef {import("../types.js").RetryOptions} RetryOptions
 */

/**
 * retry a step up to `times` attempts, rethrowing the last error on exhaustion
 *
 * @example
 * scope({}, retry({ times: 2 }, model(...)))
 *
 * @param {RetryOptions} [options]
 * @param {StepFunction} step
 * @returns {StepFunction}
 */
export const retry = ({ times = 3 } = {}, step) => async (ctx) => {
  let err;

  for (let i = 0; i < times; i++) {
    try {
      return await step(ctx);
    } catch (e) {
      err = e;
    }
  }

  throw err;
};

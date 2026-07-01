import { compose } from "./compose.js";
import { Inherit } from "../types.js";
import { toolConfigToToolDefinition } from "../utils.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").ScopeConfig} ScopeConfig
 * @typedef {import("../types.js").StepFunction} StepFunction
 */

/**
 * @param {ScopeConfig} config
 * @param {ConversationContext} ctx
 * @returns {ConversationContext}
 */
const scopeContext = (config, ctx) => {
  const inherit = config.inherit ?? Inherit.Conversation;

  /** @type {ConversationContext} */
  const scopedCtx = {
    history: [],
    tools: [],
    toolExecutors: {},
    toolLimits: {},
    toolCallCounts: {},
  };

  if (inherit & Inherit.Conversation) {
    scopedCtx.history = ctx.history;
    scopedCtx.lastResponse = ctx.lastResponse;
    scopedCtx.lastRequest = ctx.lastRequest;
  }

  if (inherit & Inherit.Tools) {
    scopedCtx.tools = [...(ctx.tools || [])];
    scopedCtx.toolExecutors = { ...(ctx.toolExecutors || {}) };
    scopedCtx.toolLimits = { ...(ctx.toolLimits || {}) };
    scopedCtx.toolCallCounts = { ...(ctx.toolCallCounts || {}) };
    scopedCtx.toolConfig = ctx.toolConfig ? { ...ctx.toolConfig } : undefined;
  }

  scopedCtx.stream = ctx.stream;
  scopedCtx.abortSignal = ctx.abortSignal;
  scopedCtx.usage = ctx.usage;
  scopedCtx.tracer = ctx.tracer;

  if (config.tools) {
    scopedCtx.tools = config.tools.map(toolConfigToToolDefinition);
    scopedCtx.toolExecutors = config.tools.reduce((acc, tool) => {
      acc[tool.name] = tool.execute;
      return acc;
    }, {});
    scopedCtx.toolLimits = config.tools.reduce((acc, tool) => {
      if (tool._maxCalls) acc[tool.name] = tool._maxCalls;
      return acc;
    }, {});
  }

  if (config.toolConfig) {
    scopedCtx.toolConfig = { ...config.toolConfig };
  }

  if (config.system) {
    const [first, ...rest] = scopedCtx.history;
    scopedCtx.history =
      first?.role === "system"
        ? [{ role: "system", content: config.system }, ...rest]
        : [{ role: "system", content: config.system }, ...scopedCtx.history];
  }

  if (config.stream) {
    scopedCtx.stream = config.stream;
  }

  if (config.tracer) {
    scopedCtx.tracer = config.tracer;
  }

  return scopedCtx;
};

/**
 * isolated context with controlled inheritance, scoped tools, an optional
 * system prompt, and optional looping via `until`
 *
 * @param {ScopeConfig} config
 * @param {...StepFunction} steps
 * @returns {StepFunction}
 */
export const scope = (config, ...steps) => async (ctx) => {
  let scopedCtx = scopeContext(config, ctx);

  if (config.until) {
    // the abort check matters: steps that bail early on an aborted signal make
    // no progress, so without it an unsatisfied until predicate spins forever
    do {
      scopedCtx = await compose(...steps)(scopedCtx);
    } while (!config.until(scopedCtx) && !scopedCtx.abortSignal?.aborted);
  } else {
    scopedCtx = await compose(...steps)(scopedCtx);
  }

  return {
    ...ctx,
    history: config.silent ? ctx.history : scopedCtx.history,
    lastResponse: config.silent ? ctx.lastResponse : scopedCtx.lastResponse,
    lastRequest: config.silent ? ctx.lastRequest : scopedCtx.lastRequest,
    stopReason: config.silent ? ctx.stopReason : scopedCtx.stopReason,
    usage: scopedCtx.usage,
  };
};

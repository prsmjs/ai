import { callProvider } from "../providers/index.js";
import { normalizeSchema } from "../schema.js";
import { parseModelName } from "../utils.js";
import { requestApproval } from "../approval.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").ComposedFunction} ComposedFunction
 * @typedef {import("../types.js").JsonSchema} JsonSchema
 * @typedef {import("../types.js").StandardSchema} StandardSchema
 * @typedef {import("../types.js").ToolCall} ToolCall
 */

// run fn inside a tracer span when a tracer is present, otherwise just call it
const traced = (tracer, name, attributes, fn) =>
  tracer ? tracer.span(name, attributes, fn) : fn();

/**
 * call an LLM and automatically execute any tool calls it returns, looping
 * until the model responds without requesting more tools
 *
 * @param {{
 *   model?: string,
 *   schema?: JsonSchema | StandardSchema,
 *   system?: string | ((ctx: ConversationContext) => string),
 *   apiKey?: string,
 *   baseUrl?: string,
 *   maxTokens?: number,
 *   effort?: "low" | "medium" | "high" | "max",
 *   tracer?: object,
 * }} [config]
 * @returns {ComposedFunction}
 */
export const model = ({
  model = "openai/gpt-5.2",
  schema,
  system,
  apiKey,
  baseUrl,
  maxTokens,
  effort,
  tracer,
} = {}) => async (ctxOrMessage) => {
  const ctx =
    typeof ctxOrMessage === "string"
      ? { history: [{ role: "user", content: ctxOrMessage }], tools: [] }
      : ctxOrMessage;

  const normalizedSchema = schema ? normalizeSchema(schema) : undefined;
  const activeTracer = tracer ?? ctx.tracer;
  const { provider } = parseModelName(model);

  let currentCtx = activeTracer ? { ...ctx, tracer: activeTracer } : ctx;

  if (system) {
    const systemContent = typeof system === "function" ? system(currentCtx) : system;
    const [first, ...rest] = currentCtx.history;

    currentCtx = {
      ...currentCtx,
      history:
        first?.role === "system"
          ? [{ role: "system", content: systemContent }, ...rest]
          : [{ role: "system", content: systemContent }, ...currentCtx.history],
    };
  }

  const systemMessage = currentCtx.history.find((m) => m.role === "system");
  const instructions =
    typeof systemMessage?.content === "string" ? systemMessage.content : undefined;

  do {
    if (currentCtx.abortSignal?.aborted) break;

    currentCtx = await traced(
      activeTracer,
      `ai.generate:${model}`,
      { "ai.provider": provider, "ai.model": model },
      () =>
        callProvider(
          { model, instructions, schema: normalizedSchema, apiKey, baseUrl, maxTokens, effort },
          currentCtx,
        ),
    );

    if (currentCtx.lastResponse?.tool_calls && currentCtx.tools?.length) {
      currentCtx = await executeTools(currentCtx);
    }
  } while (
    currentCtx.lastResponse?.tool_calls &&
    currentCtx.tools?.length &&
    !currentCtx.abortSignal?.aborted
  );

  return currentCtx;
};

/**
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
const executeTools = async (ctx) => {
  const calls = ctx.lastResponse?.tool_calls || [];
  if (!calls.length) return ctx;

  ctx.stream?.({ type: "tool_calls_ready", calls });

  const toolConfig = ctx.toolConfig || {};
  const {
    requireApproval = false,
    approvalCallback,
    parallel = false,
    retryCount = 0,
    approvalId,
    executeOnApproval = false,
  } = toolConfig;

  const updatedCounts = { ...(ctx.toolCallCounts || {}) };

  /**
   * @param {ToolCall} call
   * @param {boolean} approved
   */
  const runCall = async (call, approved) => {
    if (!approved) {
      ctx.stream?.({ type: "tool_error", call, error: "Tool execution denied by user" });
      return { call, result: { error: "Tool execution denied by user" } };
    }

    const toolName = call.function.name;
    const limits = ctx.toolLimits || {};
    const limit = limits[toolName];
    const currentCount = updatedCounts[toolName] || 0;

    if (limit && currentCount >= limit) {
      const error = `Tool ${toolName} has reached its limit of ${limit} calls`;
      ctx.stream?.({ type: "tool_error", call, error });
      return { call, result: { error } };
    }

    updatedCounts[toolName] = currentCount + 1;

    ctx.stream?.({ type: "tool_executing", call });

    let lastError;
    for (let i = 0; i <= retryCount; i++) {
      try {
        const executor = ctx.toolExecutors?.[toolName];
        if (!executor) {
          throw new Error(`Tool executor not found: ${toolName}`);
        }

        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          throw new Error(
            `Invalid JSON arguments for tool ${toolName}: ${call.function.arguments}`,
          );
        }

        const result = await traced(
          ctx.tracer,
          `ai.tool:${toolName}`,
          { "ai.tool.name": toolName },
          () => executor(args),
        );
        ctx.stream?.({ type: "tool_complete", call, result });
        return { call, result };
      } catch (e) {
        lastError = e;
      }
    }

    const error = lastError.message;
    ctx.stream?.({ type: "tool_error", call, error });
    return { call, result: { error } };
  };

  const toToolMessages = (results) =>
    results.map(({ call, result }) => ({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    }));

  const resolveApprovalFor = async (call) => {
    if (approvalCallback) return await approvalCallback(call);
    const response = await requestApproval(call, approvalId);
    return response.approved;
  };

  if (executeOnApproval && requireApproval) {
    const results = await Promise.all(
      calls.map(async (call) => runCall(call, await resolveApprovalFor(call))),
    );

    return {
      ...ctx,
      history: [...ctx.history, ...toToolMessages(results)],
      toolCallCounts: updatedCounts,
    };
  }

  const approvals = await Promise.all(
    calls.map(async (call) => ({
      call,
      approved: requireApproval ? await resolveApprovalFor(call) : true,
    })),
  );

  const runWithApproval = (call) => {
    const approval = approvals.find((a) => a.call.id === call.id);
    return runCall(call, approval?.approved ?? true);
  };

  const results = parallel
    ? await Promise.all(calls.map(runWithApproval))
    : await runSequentially(calls, runWithApproval);

  return {
    ...ctx,
    history: [...ctx.history, ...toToolMessages(results)],
    toolCallCounts: updatedCounts,
  };
};

/**
 * @param {ToolCall[]} calls
 * @param {(call: ToolCall) => Promise<{ call: ToolCall, result: any }>} runCall
 */
const runSequentially = async (calls, runCall) => {
  const results = [];
  for (const call of calls) {
    results.push(await runCall(call));
  }
  return results;
};

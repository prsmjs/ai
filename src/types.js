/**
 * @typedef {{ kind: "base64", mediaType: string, data: string } | { kind: "url", url: string }} MediaSource
 */

/**
 * @typedef {(
 *   | { type: "text", text: string }
 *   | { type: "image", source: MediaSource }
 *   | { type: "document", source: MediaSource, filename?: string }
 *   | { type: "audio", source: MediaSource }
 * )} ContentPart
 */

/**
 * @typedef {object} Message
 * @property {"system" | "user" | "assistant" | "tool"} role
 * @property {string | ContentPart[]} content
 * @property {string} [tool_call_id]
 */

/**
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {{ name: string, arguments: string }} function
 */

/**
 * @typedef {object} ToolDefinition
 * @property {"function"} type
 * @property {{ name: string, description: string, parameters: { type: string, properties: Record<string, any>, required?: string[] } }} function
 */

/**
 * @typedef {object} SchemaProperty
 * @property {"string" | "number" | "boolean" | "array" | "object"} type
 * @property {string} [description]
 * @property {string[]} [enum]
 * @property {boolean} [optional]
 * @property {SchemaProperty} [items]
 * @property {Record<string, SchemaProperty>} [properties]
 */

/**
 * @typedef {object} ToolConfig
 * @property {string} name
 * @property {string} description
 * @property {Record<string, SchemaProperty> | StandardSchema} schema
 * @property {(args: any) => Promise<any> | any} execute
 * @property {number} [_maxCalls]
 */

/**
 * @typedef {object} ToolExecutionConfig
 * @property {boolean} [requireApproval] require user approval before executing tools
 * @property {(call: ToolCall) => boolean | Promise<boolean>} [approvalCallback] custom approval handler, return true to approve
 * @property {boolean} [parallel] execute tools in parallel instead of sequentially
 * @property {number} [retryCount] number of times to retry failed tool executions
 * @property {string} [approvalId] identifier for approval requests, useful for managing multiple approval flows
 * @property {boolean} [executeOnApproval] execute each tool immediately upon its approval instead of waiting for all approvals (only applies when requireApproval is true)
 */

/**
 * @typedef {(
 *   | { type: "content", content: string }
 *   | { type: "tool_call_start", index: number, name: string }
 *   | { type: "tool_call_delta", index: number, name: string, argumentDelta: string, argumentsSoFar: string }
 *   | { type: "tool_calls_ready", calls: ToolCall[] }
 *   | { type: "tool_executing", call: ToolCall }
 *   | { type: "tool_complete", call: ToolCall, result: any }
 *   | { type: "tool_error", call: ToolCall, error: string }
 *   | { type: "approval_requested", call: ToolCall, requestId: string }
 *   | { type: "usage", usage: TokenUsage }
 * )} StreamEvent
 */

/**
 * @typedef {object} ConversationContext
 * @property {Message[]} history
 * @property {Message} [lastRequest]
 * @property {Message & { tool_calls?: ToolCall[] }} [lastResponse]
 * @property {ToolDefinition[]} [tools]
 * @property {Record<string, Function>} [toolExecutors]
 * @property {(event: StreamEvent) => void} [stream]
 * @property {string} [stopReason]
 * @property {Record<string, number>} [toolCallCounts]
 * @property {Record<string, number>} [toolLimits]
 * @property {ToolExecutionConfig} [toolConfig]
 * @property {AbortSignal} [abortSignal]
 * @property {TokenUsage} [usage]
 * @property {object} [tracer] optional prsm/trace-compatible tracer
 */

/**
 * bitwise flags controlling what an inner scope inherits from its parent context
 *
 * @enum {number}
 */
export const Inherit = Object.freeze({
  Nothing: 0,
  Conversation: 1 << 0,
  Tools: 1 << 1,
  All: (1 << 0) | (1 << 1),
});

/**
 * @typedef {object} ScopeConfig
 * @property {number} [inherit]
 * @property {ToolConfig[]} [tools]
 * @property {ToolExecutionConfig} [toolConfig]
 * @property {string} [system]
 * @property {boolean} [silent]
 * @property {(ctx: ConversationContext) => boolean} [until]
 * @property {(event: StreamEvent) => void} [stream]
 * @property {object} [tracer] optional prsm/trace-compatible tracer
 */

/**
 * @typedef {(ctx: ConversationContext) => Promise<ConversationContext>} StepFunction
 */

/**
 * @typedef {(ctxOrMessage: ConversationContext | string) => Promise<ConversationContext>} ComposedFunction
 */

/**
 * @typedef {object} JsonSchema
 * @property {string} name
 * @property {Record<string, any>} schema
 */

/**
 * @typedef {{ "~standard": any, [key: string]: any }} StandardSchema
 */

/**
 * @typedef {object} ProviderConfig
 * @property {string} model
 * @property {string} [instructions]
 * @property {JsonSchema} [schema]
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 */

/**
 * @typedef {object} ParsedModel
 * @property {string} provider
 * @property {string} model
 */

/**
 * @typedef {{ openai?: string, anthropic?: string, google?: string, [provider: string]: string | undefined }} ApiKeys
 */

/**
 * @typedef {object} ThreadStore
 * @property {(threadId: string) => Promise<Message[]>} get
 * @property {(threadId: string, messages: Message[]) => Promise<void>} set
 */

/**
 * @typedef {object} Thread
 * @property {string} id
 * @property {ThreadStore} store
 * @property {(step: StepFunction) => Promise<ConversationContext>} generate
 * @property {(content: string, workflow?: StepFunction, options?: { abortSignal?: AbortSignal }) => Promise<ConversationContext>} message
 */

/**
 * @typedef {object} RetryOptions
 * @property {number} [times]
 */

/**
 * @typedef {object} TokenUsage
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} totalTokens
 * @property {number} [cachedTokens]
 */

export {};

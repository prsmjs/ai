const normalizeToolCall = (call) => ({
  id: call.id,
  type: "function",
  function: {
    name: call.function.name,
    arguments: call.function.arguments,
  },
});

const noExtras = () => ({});

// system messages are carried separately as instructions, so they are dropped
// here. provider-private fields on assistant messages (thinking blocks, thought
// signatures) are dropped too unless the provider asks for them via assistantExtras
export const toChatMessages = (history, { convertUserContent, assistantExtras = noExtras }) =>
  history.flatMap((message) => {
    if (message.role === "system") return [];
    if (message.role === "user") {
      return [{ role: "user", content: convertUserContent(message.content) }];
    }
    if (message.role === "assistant") {
      return [{
        role: "assistant",
        content: message.content,
        ...(message.tool_calls?.length && { tool_calls: message.tool_calls.map(normalizeToolCall) }),
        ...assistantExtras(message),
      }];
    }
    if (message.role === "tool") {
      return [{ role: "tool", content: message.content, tool_call_id: message.tool_call_id }];
    }
    return [];
  });

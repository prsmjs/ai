import { addUsage } from "../utils.js";

const mediaSourceToUrl = (source) =>
  source.kind === "url" ? source.url : `data:${source.mediaType};base64,${source.data}`;

const audioFormat = (mediaType) => {
  const type = mediaType.toLowerCase();
  if (["audio/wav", "audio/wave", "audio/x-wav"].includes(type)) return "wav";
  if (["audio/mp3", "audio/mpeg", "audio/mpeg3"].includes(type)) return "mp3";
  throw new Error(`OpenAI audio input only supports wav or mp3, got: ${mediaType}`);
};

const toContentParts = (content, partType) => {
  if (typeof content === "string") return [{ type: partType, text: content }];
  return content.map((part) => {
    if (part.type === "text") return { type: partType, text: part.text };
    if (part.type === "image") {
      return { type: "input_image", image_url: mediaSourceToUrl(part.source) };
    }
    if (part.type === "document") {
      if (part.source.kind !== "base64") {
        throw new Error("OpenAI document input requires base64 source");
      }
      return {
        type: "input_file",
        filename: part.filename || "document.pdf",
        file_data: mediaSourceToUrl(part.source),
      };
    }
    if (part.type === "audio") {
      if (part.source.kind !== "base64") {
        throw new Error("OpenAI audio input requires base64 source");
      }
      return {
        type: "input_audio",
        input_audio: { data: part.source.data, format: audioFormat(part.source.mediaType) },
      };
    }
    return { type: partType, text: "" };
  });
};

export const toResponsesInput = (history) => {
  const input = [];
  for (const msg of history) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      input.push({ type: "message", role: "user", content: toContentParts(msg.content, "input_text") });
    } else if (msg.role === "assistant") {
      if (msg.content) {
        input.push({ type: "message", role: "assistant", content: toContentParts(msg.content, "output_text") });
      }
      for (const tc of msg.tool_calls || []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
    } else if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    }
  }
  return input;
};

export const toResponsesTools = (tools) =>
  (tools || []).map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }));

export const handleResponsesStream = async (response, ctx, errorLabel) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = "";
  const toolCalls = [];
  const toolCallIndexes = new Map();
  let usage = null;
  let buffer = "";
  let failure = null;

  try {
    while (true) {
      if (ctx.abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.type === "response.output_text.delta" && event.delta) {
          fullContent += event.delta;
          ctx.stream?.({ type: "content", content: event.delta });
        } else if (
          (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") &&
          event.delta
        ) {
          ctx.stream?.({ type: "thinking", content: event.delta });
        } else if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
          const index = toolCalls.length;
          toolCallIndexes.set(event.output_index, index);
          toolCalls.push({
            id: event.item.call_id,
            type: "function",
            function: { name: event.item.name, arguments: event.item.arguments || "" },
          });
          ctx.stream?.({ type: "tool_call_start", index, name: event.item.name });
        } else if (event.type === "response.function_call_arguments.delta") {
          const index = toolCallIndexes.get(event.output_index) ?? toolCalls.length - 1;
          const tc = toolCalls[index];
          if (tc && event.delta) {
            tc.function.arguments += event.delta;
            ctx.stream?.({
              type: "tool_call_delta",
              index,
              name: tc.function.name,
              argumentDelta: event.delta,
              argumentsSoFar: tc.function.arguments,
            });
          }
        } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
          let index = toolCallIndexes.get(event.output_index);
          if (index === undefined) {
            index = toolCalls.length;
            toolCallIndexes.set(event.output_index, index);
            toolCalls.push({ id: "", type: "function", function: { name: "", arguments: "" } });
          }
          toolCalls[index] = {
            id: event.item.call_id,
            type: "function",
            function: { name: event.item.name, arguments: event.item.arguments || "{}" },
          };
        } else if (event.type === "response.completed" && event.response?.usage) {
          usage = event.response.usage;
        } else if (event.type === "response.failed" || event.type === "error") {
          failure = event.response?.error?.message || event.message || `${errorLabel} response failed`;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (failure) throw new Error(`${errorLabel} API error: ${failure}`);

  const msg = { role: "assistant", content: fullContent };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;

  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const nextUsage = addUsage(
    ctx.usage,
    inputTokens,
    outputTokens,
    usage?.total_tokens || inputTokens + outputTokens,
    usage?.input_tokens_details?.cached_tokens || 0,
    usage?.output_tokens_details?.reasoning_tokens || 0,
  );

  if (ctx.stream && usage) ctx.stream({ type: "usage", usage: nextUsage });
  return { ...ctx, lastResponse: msg, history: [...ctx.history, msg], usage: nextUsage };
};

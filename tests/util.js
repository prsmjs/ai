import { vi } from "vitest";

// build an OpenAI-shaped non-streaming chat completion response
export const openaiResponse = ({ content = "", toolCalls, usage } = {}) => {
  const message = { role: "assistant", content };
  if (toolCalls) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }));
  }
  return jsonResponse({
    choices: [{ message }],
    usage: usage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
};

export const jsonResponse = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });

export const errorResponse = (status, text) => new Response(text, { status });

// build an SSE response body from a list of event objects
export const sseResponse = (events, { done = true } = {}) => {
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
  if (done) lines.push("data: [DONE]\n\n");
  return new Response(lines.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
};

// install a fetch stub that returns queued responses in order, recording calls
export const mockFetchSequence = (responses) => {
  const calls = [];
  let i = 0;
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof r === "function" ? r() : r;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
};

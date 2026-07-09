import { describe, it, expect } from "vitest";
import { toCodexInput, toCodexTools } from "../src/providers/codex.js";

describe("codex input conversion", () => {
  it("maps chat history to responses input items", () => {
    const input = toCodexInput([
      { role: "system", content: "ignored, goes in instructions" },
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: "on it",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.js"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"content":"hi"}' },
      { role: "assistant", content: "done" },
    ]);

    expect(input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "read the file" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.js"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"content":"hi"}' },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ]);
  });

  it("maps multimodal user content to input parts", () => {
    const input = toCodexInput([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: "abc" } },
        ],
      },
    ]);
    expect(input[0].content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: "data:image/png;base64,abc" },
    ]);
  });

  it("converts chat tool definitions to responses format", () => {
    const tools = toCodexTools([
      {
        type: "function",
        function: { name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
      },
    ]);
    expect(tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "read a file",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ]);
  });
});

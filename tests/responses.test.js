import { describe, it, expect } from "vitest";
import { handleResponsesStream, joinItemTexts } from "../src/providers/responses.js";

const sse = (events) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  );

const ctx = () => ({ history: [], usage: null, stream: null });
const delta = (item_id, output_index, text) => ({ type: "response.output_text.delta", item_id, output_index, delta: text });
const done = (item_id, output_index, text) => ({ type: "response.output_text.done", item_id, output_index, text });

describe("responses stream text", () => {
  it("joins distinct items in order, as before", async () => {
    const result = await handleResponsesStream(sse([delta("a", 0, "Hel"), delta("a", 0, "lo"), delta("b", 1, " world")]), ctx(), "Test");
    expect(result.lastResponse.content).toBe("Hello world");
  });

  it("drops an item that repeats the one before it", async () => {
    const result = await handleResponsesStream(
      sse([delta("a", 0, "Is that yours?"), done("a", 0, "Is that yours?"), delta("b", 1, "Is that yours?"), done("b", 1, "Is that yours?")]),
      ctx(),
      "Test",
    );
    expect(result.lastResponse.content).toBe("Is that yours?");
  });

  it("takes an item's done text over its deltas", async () => {
    const result = await handleResponsesStream(sse([delta("a", 0, "Hi"), delta("a", 0, "Hi"), done("a", 0, "Hi")]), ctx(), "Test");
    expect(result.lastResponse.content).toBe("Hi");
  });

  it("keys by output index when items carry no id", async () => {
    const result = await handleResponsesStream(sse([delta(undefined, 0, "one"), delta(undefined, 1, "one")]), ctx(), "Test");
    expect(result.lastResponse.content).toBe("one");
  });

  it("streams every delta live and keeps tool calls", async () => {
    const seen = [];
    const result = await handleResponsesStream(
      sse([
        delta("a", 0, "x"),
        { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "c1", name: "read", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":"a"}' },
        { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a"}' } },
      ]),
      { ...ctx(), stream: (e) => seen.push(e.type) },
      "Test",
    );
    expect(result.lastResponse.content).toBe("x");
    expect(result.lastResponse.tool_calls[0].function.arguments).toBe('{"path":"a"}');
    expect(seen).toContain("content");
  });

  it("joinItemTexts keeps non-adjacent repeats", () => {
    expect(joinItemTexts(["a", "b", "a"])).toBe("aba");
    expect(joinItemTexts(["a", "a", "b"])).toBe("ab");
    expect(joinItemTexts(["", "a"])).toBe("a");
  });
});

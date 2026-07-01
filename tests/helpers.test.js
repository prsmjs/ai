import { describe, it, expect, vi } from "vitest";
import {
  noToolsCalled,
  toolWasCalled,
  everyNMessages,
  appendToLastRequest,
  toolNotUsedInNTurns,
} from "../src/index.js";

const withToolCall = (name) => ({
  history: [],
  lastResponse: { role: "assistant", content: "", tool_calls: [{ id: "1", function: { name, arguments: "{}" } }] },
});

describe("noToolsCalled", () => {
  it("is true when the last response had no tool calls", () => {
    expect(noToolsCalled()({ lastResponse: { role: "assistant", content: "hi" } })).toBe(true);
  });

  it("is false when the last response requested a tool", () => {
    expect(noToolsCalled()(withToolCall("search"))).toBe(false);
  });
});

describe("toolWasCalled", () => {
  it("matches the named tool in the last response", () => {
    expect(toolWasCalled("search")(withToolCall("search"))).toBe(true);
    expect(toolWasCalled("other")(withToolCall("search"))).toBe(false);
  });
});

describe("everyNMessages", () => {
  it("fires only when the message count crosses a multiple of n", async () => {
    const step = vi.fn(async (ctx) => ctx);
    const trigger = everyNMessages(2, step);

    await trigger({ history: [{}] }); // 1 -> floor(0.5)=0, no
    expect(step).toHaveBeenCalledTimes(0);
    await trigger({ history: [{}, {}] }); // 2 -> floor(1)=1, yes
    expect(step).toHaveBeenCalledTimes(1);
    await trigger({ history: [{}, {}, {}] }); // 3 -> still 1, no
    expect(step).toHaveBeenCalledTimes(1);
    await trigger({ history: [{}, {}, {}, {}] }); // 4 -> 2, yes
    expect(step).toHaveBeenCalledTimes(2);
  });
});

describe("appendToLastRequest", () => {
  it("appends to the most recent string user message", async () => {
    const out = await appendToLastRequest(" please")({
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    });
    expect(out.history[2].content).toBe("second please");
  });

  it("appends a text part when the user content is multimodal", async () => {
    const out = await appendToLastRequest(" extra")({
      history: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(out.history[0].content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: " extra" },
    ]);
  });

  it("returns context unchanged when there is no user message", async () => {
    const ctx = { history: [{ role: "assistant", content: "x" }] };
    expect(await appendToLastRequest("y")(ctx)).toBe(ctx);
  });
});

describe("toolNotUsedInNTurns", () => {
  it("counts a turn as used when the tool ran mid-turn before a plain final answer", async () => {
    const step = vi.fn(async (ctx) => ctx);
    const trigger = toolNotUsedInNTurns({ toolName: "search", times: 1 }, step);

    await trigger({
      history: [
        { role: "user", content: "find me something" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: '"found it"' },
        { role: "assistant", content: "here you go" },
      ],
      lastResponse: { role: "assistant", content: "here you go" },
    });

    expect(step).not.toHaveBeenCalled();
  });

  it("fires the step after a tool goes unused for the given number of turns", async () => {
    const step = vi.fn(async (ctx) => ctx);
    const trigger = toolNotUsedInNTurns({ toolName: "search", times: 2 }, step);

    await trigger({ history: [{ role: "user", content: "a" }], lastResponse: { content: "x" } });
    expect(step).toHaveBeenCalledTimes(0);
    await trigger({
      history: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
      lastResponse: { content: "x" },
    });
    expect(step).toHaveBeenCalledTimes(1);
  });
});

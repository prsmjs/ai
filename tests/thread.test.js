import { describe, it, expect, afterEach, vi } from "vitest";
import { getOrCreateThread, compose, model, setKeys } from "../src/index.js";
import { openaiResponse, mockFetchSequence } from "./util.js";

setKeys({ openai: "sk-test" });

afterEach(() => vi.unstubAllGlobals());

describe("threads", () => {
  it("persists conversation history across messages", async () => {
    mockFetchSequence([
      openaiResponse({ content: "hello there" }),
      openaiResponse({ content: "you said hi" }),
    ]);

    const thread = getOrCreateThread("persist-test");
    await thread.message("hi", compose(model({ model: "openai/gpt-5.2" })));
    const second = await thread.message("what did I say?", compose(model({ model: "openai/gpt-5.2" })));

    const stored = await thread.store.get("persist-test");
    expect(stored).toBe(second.history);
    expect(stored.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "hi",
      "what did I say?",
    ]);
  });

  it("returns the same instance for the same id with the default store", () => {
    expect(getOrCreateThread("same-id")).toBe(getOrCreateThread("same-id"));
  });

  it("keeps threads with different custom stores distinct for the same id", () => {
    const storeA = { get: async () => [], set: async () => {} };
    const storeB = { get: async () => [], set: async () => {} };
    const a = getOrCreateThread("shared-id", storeA);
    const b = getOrCreateThread("shared-id", storeB);
    expect(a).not.toBe(b);
    expect(getOrCreateThread("shared-id", storeA)).toBe(a);
  });

  it("routes reads and writes through a custom store", async () => {
    mockFetchSequence([openaiResponse({ content: "ok" })]);
    const backing = new Map();
    const store = {
      get: async (id) => backing.get(id) || [],
      set: async (id, messages) => backing.set(id, messages),
    };

    const thread = getOrCreateThread("custom", store);
    await thread.message("hi", compose(model({ model: "openai/gpt-5.2" })));

    expect(backing.get("custom").some((m) => m.content === "hi")).toBe(true);
  });

  it("stores an interruption marker when the signal is already aborted", async () => {
    mockFetchSequence([openaiResponse({ content: "unused" })]);
    const thread = getOrCreateThread("abort-test");
    const controller = new AbortController();
    controller.abort();

    const result = await thread.message("hi", compose(model({ model: "openai/gpt-5.2" })), {
      abortSignal: controller.signal,
    });

    expect(result.history.at(-1)).toEqual({ role: "assistant", content: "[Response interrupted]" });
  });
});

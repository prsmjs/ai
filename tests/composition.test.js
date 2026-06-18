import { describe, it, expect, afterEach, vi } from "vitest";
import { compose, scope, when, tap, retry, model, Inherit, setKeys } from "../src/index.js";
import { openaiResponse, mockFetchSequence } from "./util.js";

setKeys({ openai: "sk-test" });

afterEach(() => vi.unstubAllGlobals());

describe("compose", () => {
  it("turns a bare string into a user message", async () => {
    const seen = [];
    const result = await compose(tap((ctx) => seen.push(ctx.history)))("hi");
    expect(seen[0]).toEqual([{ role: "user", content: "hi" }]);
    expect(result.history).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sets lastRequest to the most recent user message before each step", async () => {
    let lastRequest;
    await compose(tap((ctx) => (lastRequest = ctx.lastRequest)))({
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    });
    expect(lastRequest).toEqual({ role: "user", content: "second" });
  });

  it("threads context through steps in order", async () => {
    const order = [];
    await compose(
      tap(() => order.push("a")),
      tap(() => order.push("b")),
    )("go");
    expect(order).toEqual(["a", "b"]);
  });
});

describe("when", () => {
  it("runs the action when the predicate holds", async () => {
    const ran = vi.fn(async (ctx) => ctx);
    await when(() => true, ran)({ history: [] });
    expect(ran).toHaveBeenCalled();
  });

  it("passes context through untouched when the predicate is false", async () => {
    const ran = vi.fn(async (ctx) => ctx);
    const ctx = { history: [{ role: "user", content: "x" }] };
    const out = await when(() => false, ran)(ctx);
    expect(ran).not.toHaveBeenCalled();
    expect(out).toBe(ctx);
  });
});

describe("tap", () => {
  it("returns the same context it received", async () => {
    const ctx = { history: [] };
    expect(await tap(() => {})(ctx)).toBe(ctx);
  });
});

describe("retry", () => {
  it("returns on the first success", async () => {
    const step = vi.fn(async (ctx) => ctx);
    await retry({ times: 3 }, step)({ history: [] });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("retries until a step succeeds", async () => {
    let n = 0;
    const step = async (ctx) => {
      if (++n < 3) throw new Error("boom");
      return ctx;
    };
    const ctx = { history: [] };
    expect(await retry({ times: 5 }, step)(ctx)).toBe(ctx);
    expect(n).toBe(3);
  });

  it("rethrows the last error after exhausting attempts", async () => {
    const step = async () => {
      throw new Error("always");
    };
    await expect(retry({ times: 2 }, step)({ history: [] })).rejects.toThrow("always");
  });
});

describe("scope inheritance", () => {
  it("Inherit.Nothing starts an inner step with empty history", async () => {
    let innerHistory;
    await scope({ inherit: Inherit.Nothing }, tap((ctx) => (innerHistory = ctx.history)))({
      history: [{ role: "user", content: "outer" }],
    });
    expect(innerHistory).toEqual([]);
  });

  it("Inherit.Conversation carries history into the inner scope", async () => {
    let innerHistory;
    await scope({ inherit: Inherit.Conversation }, tap((ctx) => (innerHistory = ctx.history)))({
      history: [{ role: "user", content: "carry me" }],
    });
    expect(innerHistory).toEqual([{ role: "user", content: "carry me" }]);
  });

  it("a silent scope keeps outer history and lastResponse intact", async () => {
    mockFetchSequence([openaiResponse({ content: "inner answer" })]);
    const outer = {
      history: [{ role: "user", content: "x" }],
      lastResponse: { role: "assistant", content: "outer-response" },
    };
    const out = await scope({ silent: true }, model({ model: "openai/gpt-5.2" }))(outer);
    expect(out.history).toEqual([{ role: "user", content: "x" }]);
    expect(out.lastResponse.content).toBe("outer-response");
  });

  it("injects a system prompt at the front of inner history", async () => {
    let innerHistory;
    await scope({ system: "be terse" }, tap((ctx) => (innerHistory = ctx.history)))({
      history: [{ role: "user", content: "hi" }],
    });
    expect(innerHistory[0]).toEqual({ role: "system", content: "be terse" });
  });

  it("replaces an existing system prompt rather than stacking", async () => {
    let innerHistory;
    await scope({ system: "new" }, tap((ctx) => (innerHistory = ctx.history)))({
      history: [
        { role: "system", content: "old" },
        { role: "user", content: "hi" },
      ],
    });
    expect(innerHistory.filter((m) => m.role === "system")).toHaveLength(1);
    expect(innerHistory[0].content).toBe("new");
  });

  it("loops until the until predicate is satisfied", async () => {
    let count = 0;
    await scope(
      { until: (ctx) => ctx.lastResponse?.content === "stop" },
      tap((ctx) => {
        count++;
        ctx.lastResponse = { role: "assistant", content: count >= 3 ? "stop" : "go" };
      }),
    )({ history: [] });
    expect(count).toBe(3);
  });

  it("propagates accumulated usage out of a silent scope", async () => {
    mockFetchSequence([openaiResponse({ content: "done", usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })]);
    const out = await scope({ silent: true }, model({ model: "openai/gpt-5.2" }))({
      history: [{ role: "user", content: "hi" }],
    });
    expect(out.usage.totalTokens).toBe(10);
  });
});

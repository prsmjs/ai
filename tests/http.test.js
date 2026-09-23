import { describe, it, expect, vi, afterEach } from "vitest";
import { request } from "../src/providers/http.js";
import { compose, model, setKeys } from "../src/index.js";
setKeys({ openai: "sk-test" });
import { mockFetchSequence, errorResponse, openaiResponse } from "./util.js";

const fast = { backoffMs: 1 };

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("sends every request over http/1.1, never a shared http/2 connection", async () => {
    const calls = mockFetchSequence([() => new Response("ok", { status: 200 })]);
    await request("https://x", { method: "POST" }, fast);
    expect(calls[0].init.dispatcher).toBeDefined();
    expect(calls[0].init.dispatcher.constructor.name).toBe("Agent");
  });

  it("lets a caller bring its own dispatcher", async () => {
    const calls = mockFetchSequence([() => new Response("ok", { status: 200 })]);
    const own = { dispatch() {} };
    await request("https://x", { method: "POST", dispatcher: own }, fast);
    expect(calls[0].init.dispatcher).toBe(own);
  });

  it("retries a retryable status and returns the first good response", async () => {
    const calls = mockFetchSequence([
      () => errorResponse(503, "down"),
      () => errorResponse(429, "slow down"),
      () => new Response("ok", { status: 200 }),
    ]);
    const r = await request("https://x", { method: "POST" }, { ...fast, retries: 2 });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("gives up after the configured retries and hands back the last response", async () => {
    const calls = mockFetchSequence([() => errorResponse(500, "boom")]);
    const r = await request("https://x", {}, { ...fast, retries: 1 });
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("boom");
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx that is not transient", async () => {
    const calls = mockFetchSequence([() => errorResponse(400, "bad")]);
    const r = await request("https://x", {}, { ...fast, retries: 3 });
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("retries a dropped connection", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n < 3) throw new TypeError("fetch failed");
      return new Response("ok", { status: 200 });
    }));
    const r = await request("https://x", {}, { ...fast, retries: 2 });
    expect(r.status).toBe(200);
    expect(n).toBe(3);
  });

  it("rethrows once retries are exhausted on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(request("https://x", {}, { ...fast, retries: 1 })).rejects.toThrow(/fetch failed/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("times out a hung request and retries it", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn((url, init) => new Promise((resolve, reject) => {
      n++;
      if (n === 1) return init.signal.addEventListener("abort", () => reject(init.signal.reason));
      resolve(new Response("ok", { status: 200 }));
    })));
    const r = await request("https://x", {}, { ...fast, retries: 1, timeoutMs: 20 });
    expect(r.status).toBe(200);
    expect(n).toBe(2);
  });

  it("never retries the caller's own abort", async () => {
    const ac = new AbortController();
    vi.stubGlobal("fetch", vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
      ac.abort();
    })));
    await expect(request("https://x", {}, { ...fast, retries: 3, signal: ac.signal })).rejects.toThrow(/aborted/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors retry-after", async () => {
    const calls = mockFetchSequence([
      () => new Response("wait", { status: 429, headers: { "retry-after": "0" } }),
      () => new Response("ok", { status: 200 }),
    ]);
    const r = await request("https://x", {}, { retries: 1, backoffMs: 60_000 });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe("model transport options", () => {
  it("passes timeoutMs and retries through to the provider call", async () => {
    const calls = mockFetchSequence([
      () => errorResponse(502, "bad gateway"),
      openaiResponse({ content: "hello" }),
    ]);
    const result = await compose(model({ model: "openai/gpt-5.2", retries: 1 }))("hi");
    expect(result.lastResponse.content).toBe("hello");
    expect(calls).toHaveLength(2);
  });
});

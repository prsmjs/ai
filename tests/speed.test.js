import { describe, it, expect, afterEach, vi } from "vitest";
import { model, scope } from "../src/index.js";
import { mockFetchSequence, openaiResponse, sseResponse } from "./util.js";

afterEach(() => vi.unstubAllGlobals());

const config = { model: "codex/gpt-6.1-sol", apiKey: "oauth-test", headers: { "chatgpt-account-id": "account-test" } };

const response = (tier, usage) => sseResponse([
  { type: "response.created", response: { service_tier: "auto" } },
  { type: "response.output_text.delta", delta: "OK" },
  { type: "response.completed", response: { ...(tier !== undefined && { service_tier: tier }), ...(usage && { usage }) } },
]);

describe("Codex speed", () => {
  it.each([undefined, "standard", "fast"])("forwards speed=%s independently of effort", async (speed) => {
    const calls = mockFetchSequence([response("default")]);
    await model({ ...config, speed, effort: "high" })("go");
    const call = calls[0];
    expect(call.body.reasoning.effort).toBe("high");
    expect(call.init.headers.Authorization).toBe("Bearer oauth-test");
    expect(call.init.headers["chatgpt-account-id"]).toBe("account-test");
    if (speed === "fast") {
      expect(call.body.service_tier).toBe("priority");
      expect(call.init.headers["x-codex-routing-hint"]).toBe("model=gpt-6.1-sol;tier=priority");
    } else {
      expect(call.body).not.toHaveProperty("service_tier");
      expect(call.init.headers).not.toHaveProperty("x-codex-routing-hint");
    }
  });

  it.each(["standard", "fast"])("overrides conflicting case-insensitive routing hints with speed=%s", async (speed) => {
    const calls = mockFetchSequence([response()]);
    await model({ ...config, speed, headers: { "X-Codex-Routing-Hint": "model=wrong;tier=fast", "x-other": "kept" } })("go");
    const headers = calls[0].init.headers;
    expect(headers).not.toHaveProperty("X-Codex-Routing-Hint");
    expect(headers["x-other"]).toBe("kept");
    expect(headers["x-codex-routing-hint"]).toBe(speed === "fast" ? "model=gpt-6.1-sol;tier=priority" : undefined);
  });

  it("keeps Fast enabled across tool-loop requests", async () => {
    const calls = mockFetchSequence([
      openaiResponse({ toolCalls: [{ id: "a", name: "work" }] }),
      response("default"),
    ]);
    const result = await scope({ tools: [{ name: "work", description: "Work", schema: {}, execute: () => "done" }] }, model({ ...config, speed: "fast" }))({ history: [{ role: "user", content: "go" }] });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.body.service_tier).toBe("priority");
      expect(call.init.headers["x-codex-routing-hint"]).toBe("model=gpt-6.1-sol;tier=priority");
    }
    expect(calls[1].body.input.filter((item) => item.type === "function_call_output").map((item) => item.call_id)).toEqual(["a"]);
    expect(result.lastResponse.serviceTier).toBe("default");
  });

  it.each(["default", "priority", "fast", "future-tier", undefined])("preserves raw final tier %s even without usage", async (tier) => {
    mockFetchSequence([response(tier)]);
    const result = await model({ ...config, speed: "fast" })("go");
    if (tier === undefined) expect(result.lastResponse).not.toHaveProperty("serviceTier");
    else expect(result.lastResponse.serviceTier).toBe(tier);
    expect(result.history.at(-1)).toBe(result.lastResponse);
  });

  it("preserves usage alongside tier metadata", async () => {
    mockFetchSequence([response("priority", { input_tokens: 10, output_tokens: 5 })]);
    const result = await model({ ...config, speed: "fast" })("go");
    expect(result.lastResponse.serviceTier).toBe("priority");
    expect(result.usage).toMatchObject({ promptTokens: 10, completionTokens: 5 });
  });

  it.each(["openai/gpt-6.1-sol", "anthropic/claude-opus-5-5", "google/gemini", "xai/grok", "openrouter/model", "local/model", "huggingface/model"])("rejects explicit speed for %s before sending requests", async (providerModel) => {
    const calls = mockFetchSequence([response()]);
    await expect(model({ model: providerModel, speed: "standard" })("go")).rejects.toThrow("Speed is not supported by provider");
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid speed before sending a request", async () => {
    const calls = mockFetchSequence([response()]);
    await expect(model({ ...config, speed: "priority" })("go")).rejects.toThrow("Invalid speed: priority");
    expect(calls).toHaveLength(0);
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { compose, scope, model, setKeys } from "../src/index.js";
import { openaiResponse, jsonResponse, sseResponse, errorResponse, mockFetchSequence } from "./util.js";

setKeys({ openai: "sk-test", anthropic: "sk-ant", google: "g-key", xai: "x-key" });

afterEach(() => vi.unstubAllGlobals());

const tool = (execute) => ({
  name: "get_weather",
  description: "weather",
  schema: { city: { type: "string" } },
  execute,
});

describe("openai provider", () => {
  it("sends the model, messages, and parsed usage", async () => {
    const calls = mockFetchSequence([
      openaiResponse({ content: "hi", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    ]);
    const result = await compose(model({ model: "openai/gpt-5.2" }))("hello");

    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].body.model).toBe("gpt-5.2");
    expect(result.lastResponse.content).toBe("hi");
    expect(result.usage.totalTokens).toBe(5);
  });

  it("passes a strict json_schema response format for structured output", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "{}" })]);
    await compose(
      model({ model: "openai/gpt-5.2", schema: { name: "Person", schema: { type: "object", properties: {} } } }),
    )("extract");
    expect(calls[0].body.response_format.type).toBe("json_schema");
    expect(calls[0].body.response_format.json_schema.strict).toBe(true);
  });

  it("makes optional structured output properties required and nullable", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "{}" })]);
    await compose(
      model({
        model: "openai/gpt-5.2",
        schema: z.object({
          name: z.string(),
          address: z.string().nullish(),
          details: z.object({ count: z.number().optional() }).optional(),
        }),
      }),
    )("extract");

    const schema = calls[0].body.response_format.json_schema.schema;
    expect(schema.required).toEqual(["name", "address", "details"]);
    expect(schema.properties.address.anyOf).toContainEqual({ type: "null" });
    expect(schema.properties.details.anyOf).toContainEqual({ type: "null" });
    const details = schema.properties.details.anyOf.find((branch) => branch.type === "object");
    expect(details.required).toEqual(["count"]);
    expect(details.properties.count.anyOf).toContainEqual({ type: "null" });
  });

  it("does not change schemas sent to other providers", async () => {
    const calls = mockFetchSequence([jsonResponse({ content: [{ type: "text", text: "{}" }] })]);
    await compose(
      model({ model: "anthropic/claude-sonnet-4-5", schema: z.object({ name: z.string().optional() }) }),
    )("extract");

    const prompt = calls[0].body.system;
    expect(prompt).not.toContain('"required": [');
    expect(prompt).not.toContain('"type": "null"');
  });

  it("throws with the upstream error text on a non-ok response", async () => {
    mockFetchSequence([errorResponse(429, "rate limited")]);
    await expect(compose(model({ model: "openai/gpt-5.2" }))("hi")).rejects.toThrow(/rate limited/);
  });

  it("sends the system prompt exactly once", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(model({ model: "openai/gpt-5.2", system: "be brief" }))("hi");
    const systemMessages = calls[0].body.messages.filter((m) => m.role === "system");
    expect(systemMessages).toEqual([{ role: "system", content: "be brief" }]);
  });

  it("omits an output cap unless maxTokens is set, then uses max_completion_tokens", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "a" }), openaiResponse({ content: "b" })]);
    await compose(model({ model: "openai/gpt-5.2" }))("hi");
    expect(calls[0].body).not.toHaveProperty("max_tokens");
    expect(calls[0].body).not.toHaveProperty("max_completion_tokens");

    await compose(model({ model: "openai/gpt-5.2", maxTokens: 500 }))("hi");
    expect(calls[1].body.max_completion_tokens).toBe(500);
  });

  it("uses legacy max_tokens for OpenAI-compatible servers reached via baseUrl", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "local" })]);
    await compose(model({ model: "ollama/llama3", maxTokens: 300 }))("hi");
    expect(calls[0].body.max_tokens).toBe(300);
    expect(calls[0].body).not.toHaveProperty("max_completion_tokens");
  });

  it("emits tool_call_start before tool_call_delta when a chunk carries both", async () => {
    const events = [];
    mockFetchSequence([
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }] } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ]),
      sseResponse([{ choices: [{ delta: { content: "done" } }] }]),
    ]);

    await compose(
      scope({ tools: [tool(async () => "ok")], stream: (e) => events.push(e) }, model({ model: "openai/gpt-5.2" })),
    )("go");

    const types = events.map((e) => e.type);
    expect(types.indexOf("tool_call_start")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("tool_call_start")).toBeLessThan(types.indexOf("tool_call_delta"));
  });

  it("assembles streamed content and tool-call chunks", async () => {
    const events = [];
    const stream = (e) => events.push(e);

    mockFetchSequence([
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ]),
      sseResponse([
        { choices: [{ delta: { content: "It is " } }] },
        { choices: [{ delta: { content: "sunny." } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } },
      ]),
    ]);

    const execute = vi.fn(async () => "sunny");
    const result = await compose(
      scope({ tools: [tool(execute)], stream }, model({ model: "openai/gpt-5.2" })),
    )("weather in NYC?");

    expect(execute).toHaveBeenCalledWith({ city: "NYC" });
    expect(result.lastResponse.content).toBe("It is sunny.");
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["tool_calls_ready", "tool_executing", "tool_complete", "content", "usage"]),
    );
  });
});

describe("anthropic provider", () => {
  const anthropicResponse = ({ blocks, usage } = {}) =>
    jsonResponse({ content: blocks, usage: usage || { input_tokens: 10, output_tokens: 5 } });

  it("extracts the system prompt and converts tools to input_schema", async () => {
    const calls = mockFetchSequence([anthropicResponse({ blocks: [{ type: "text", text: "ok" }] })]);
    await compose(
      scope({ system: "be brief", tools: [tool(async () => "x")] }, model({ model: "anthropic/claude-x" })),
    )("hi");

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].body.system).toBe("be brief");
    expect(calls[0].body.tools[0].input_schema.type).toBe("object");
  });

  it("parses every content block, not just the first (text plus multiple tool_use)", async () => {
    mockFetchSequence([
      anthropicResponse({
        blocks: [
          { type: "text", text: "Checking both. " },
          { type: "tool_use", id: "tu1", name: "get_weather", input: { city: "A" } },
          { type: "tool_use", id: "tu2", name: "get_weather", input: { city: "B" } },
        ],
      }),
      anthropicResponse({ blocks: [{ type: "text", text: "Done." }] }),
    ]);

    const seen = [];
    const result = await compose(
      scope({ tools: [tool(async ({ city }) => { seen.push(city); return "ok"; })] }, model({ model: "anthropic/claude-x" })),
    )("weather in A and B?");

    expect(seen).toEqual(["A", "B"]);
    expect(result.lastResponse.content).toBe("Done.");
  });

  it("defaults max_tokens to 8192 and honors a maxTokens override", async () => {
    const calls = mockFetchSequence([
      anthropicResponse({ blocks: [{ type: "text", text: "a" }] }),
      anthropicResponse({ blocks: [{ type: "text", text: "b" }] }),
    ]);
    await compose(model({ model: "anthropic/claude-x" }))("hi");
    expect(calls[0].body.max_tokens).toBe(8192);

    await compose(model({ model: "anthropic/claude-x", maxTokens: 32000 }))("hi");
    expect(calls[1].body.max_tokens).toBe(32000);
  });

  it("accumulates anthropic usage as input plus output tokens", async () => {
    mockFetchSequence([
      anthropicResponse({ blocks: [{ type: "text", text: "hi" }], usage: { input_tokens: 12, output_tokens: 8 } }),
    ]);
    const result = await compose(model({ model: "anthropic/claude-x" }))("hi");
    expect(result.usage.totalTokens).toBe(20);
  });
});

describe("google provider", () => {
  it("parses text and function calls from candidate parts", async () => {
    mockFetchSequence([
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "let me check " }, { functionCall: { name: "get_weather", args: { city: "LA" } } }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      }),
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "sunny" }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
      }),
    ]);

    const execute = vi.fn(async () => "sunny");
    const result = await compose(
      scope({ tools: [tool(execute)] }, model({ model: "google/gemini-x" })),
    )("weather in LA?");

    expect(execute).toHaveBeenCalledWith({ city: "LA" });
    expect(result.lastResponse.content).toBe("sunny");
    expect(result.usage.totalTokens).toBe(10);
  });

  it("puts the api key in the query string", async () => {
    const calls = mockFetchSequence([
      jsonResponse({ candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: {} }),
    ]);
    await compose(model({ model: "google/gemini-x" }))("hi");
    expect(calls[0].url).toContain("key=g-key");
  });

  it("maps maxTokens to generationConfig.maxOutputTokens", async () => {
    const calls = mockFetchSequence([
      jsonResponse({ candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: {} }),
    ]);
    await compose(model({ model: "google/gemini-x", maxTokens: 1000 }))("hi");
    expect(calls[0].body.generationConfig).toEqual({ maxOutputTokens: 1000 });
  });

  it("returns an empty response instead of crashing when candidates lack content", async () => {
    mockFetchSequence([jsonResponse({ candidates: [{ finishReason: "SAFETY" }], usageMetadata: {} })]);
    const result = await compose(model({ model: "google/gemini-x" }))("hi");
    expect(result.lastResponse.content).toBe("");
  });
});

describe("xai provider", () => {
  it("parses an xai chat completion", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "grok says hi" })]);
    const result = await compose(model({ model: "xai/grok-x" }))("hi");
    expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    expect(result.lastResponse.content).toBe("grok says hi");
  });

  it("sends the system prompt exactly once", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(model({ model: "xai/grok-x", system: "be brief" }))("hi");
    const systemMessages = calls[0].body.messages.filter((m) => m.role === "system");
    expect(systemMessages).toEqual([{ role: "system", content: "be brief" }]);
  });

  it("omits an output cap unless maxTokens is set", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "a" }), openaiResponse({ content: "b" })]);
    await compose(model({ model: "xai/grok-x" }))("hi");
    expect(calls[0].body).not.toHaveProperty("max_tokens");

    await compose(model({ model: "xai/grok-x", maxTokens: 700 }))("hi");
    expect(calls[1].body.max_tokens).toBe(700);
  });

  it("emits incremental tool-call events while streaming", async () => {
    const events = [];
    mockFetchSequence([
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"LA"}' } }] } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ]),
      sseResponse([{ choices: [{ delta: { content: "done" } }] }]),
    ]);

    const execute = vi.fn(async () => "sunny");
    await compose(
      scope({ tools: [tool(execute)], stream: (e) => events.push(e) }, model({ model: "xai/grok-x" })),
    )("weather in LA?");

    expect(execute).toHaveBeenCalledWith({ city: "LA" });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["tool_call_start", "tool_call_delta", "tool_calls_ready"]),
    );
  });
});

describe("local routing", () => {
  it("routes local/ to an OpenAI-compatible localhost endpoint", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "local" })]);
    await compose(model({ model: "local/my-model" }))("hi");
    expect(calls[0].url).toBe("http://localhost:1234/v1/chat/completions");
  });

  it("routes ollama/ to the ollama default port", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "ollama" })]);
    await compose(model({ model: "ollama/llama3" }))("hi");
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("lets an explicit baseUrl override the local default", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "lmstudio" })]);
    await compose(model({ model: "lmstudio/m", baseUrl: "http://localhost:4321/v1" }))("hi");
    expect(calls[0].url).toBe("http://localhost:4321/v1/chat/completions");
  });
});

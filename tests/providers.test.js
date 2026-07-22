import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { compose, scope, model, setKeys } from "../src/index.js";
import { openaiResponse, openaiChatResponse, jsonResponse, sseResponse, errorResponse, mockFetchSequence } from "./util.js";

setKeys({ openai: "sk-test", anthropic: "sk-ant", google: "g-key", xai: "x-key" });

afterEach(() => vi.unstubAllGlobals());

const tool = (execute) => ({
  name: "get_weather",
  description: "weather",
  schema: { city: { type: "string" } },
  execute,
});

describe("openai provider", () => {
  const response = ({ content = "", tool, usage } = {}) => sseResponse([
    ...(tool ? [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: tool.id, name: tool.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(tool.args) },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.args) } },
    ] : []),
    ...(content ? [{ type: "response.output_text.delta", delta: content }] : []),
    { type: "response.completed", response: { usage: usage || { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ]);

  it("uses the Responses API and parses usage", async () => {
    const calls = mockFetchSequence([response({ content: "hi", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } })]);
    const result = await compose(model({ model: "openai/gpt-5.2" }))("hello");
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].body.input[0].content[0].text).toBe("hello");
    expect(result.lastResponse.content).toBe("hi");
    expect(result.usage.totalTokens).toBe(5);
  });

  it("passes strict structured output through text.format", async () => {
    const calls = mockFetchSequence([response({ content: "{}" })]);
    await compose(model({ model: "openai/gpt-5.2", schema: z.object({ name: z.string(), note: z.string().optional() }) }))("extract");
    const format = calls[0].body.text.format;
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    expect(format.schema.required).toEqual(["name", "note"]);
    expect(format.schema.properties.note.anyOf).toContainEqual({ type: "null" });
  });

  it("sends instructions once and maps output and reasoning options", async () => {
    const calls = mockFetchSequence([response({ content: "ok" })]);
    await compose(model({ model: "openai/gpt-5.2", system: "be brief", maxTokens: 500, effort: "high" }))("hi");
    expect(calls[0].body.instructions).toBe("be brief");
    expect(calls[0].body.input.some((item) => item.role === "system")).toBe(false);
    expect(calls[0].body.max_output_tokens).toBe(500);
    expect(calls[0].body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("executes streamed tool calls and preserves public events", async () => {
    const events = [];
    const execute = vi.fn(async () => "sunny");
    mockFetchSequence([
      response({ tool: { id: "call_0", name: "get_weather", args: { city: "NYC" } } }),
      response({ content: "It is sunny." }),
    ]);
    const result = await compose(scope({ tools: [tool(execute)], stream: (event) => events.push(event) }, model({ model: "openai/gpt-5.2" })))("weather?");
    expect(execute).toHaveBeenCalledWith({ city: "NYC" });
    expect(result.lastResponse.content).toBe("It is sunny.");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool_call_start", "tool_call_delta", "tool_calls_ready", "tool_executing", "tool_complete", "content", "usage"]));
  });

  it("throws with upstream error text", async () => {
    mockFetchSequence([errorResponse(429, "rate limited")]);
    await expect(compose(model({ model: "openai/gpt-5.2" }))("hi")).rejects.toThrow(/rate limited/);
  });

  it("keeps Chat Completions for compatible baseUrl providers", async () => {
    const calls = mockFetchSequence([openaiChatResponse({ content: "local" })]);
    await compose(model({ model: "ollama/llama3", maxTokens: 300 }))("hi");
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0].body.max_tokens).toBe(300);
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
    const calls = mockFetchSequence([openaiChatResponse({ content: "grok says hi" })]);
    const result = await compose(model({ model: "xai/grok-x" }))("hi");
    expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    expect(result.lastResponse.content).toBe("grok says hi");
  });

  it("sends the system prompt exactly once", async () => {
    const calls = mockFetchSequence([openaiChatResponse({ content: "ok" })]);
    await compose(model({ model: "xai/grok-x", system: "be brief" }))("hi");
    const systemMessages = calls[0].body.messages.filter((m) => m.role === "system");
    expect(systemMessages).toEqual([{ role: "system", content: "be brief" }]);
  });

  it("omits an output cap unless maxTokens is set", async () => {
    const calls = mockFetchSequence([openaiChatResponse({ content: "a" }), openaiChatResponse({ content: "b" })]);
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
    const calls = mockFetchSequence([openaiChatResponse({ content: "local" })]);
    await compose(model({ model: "local/my-model" }))("hi");
    expect(calls[0].url).toBe("http://localhost:1234/v1/chat/completions");
  });

  it("routes ollama/ to the ollama default port", async () => {
    const calls = mockFetchSequence([openaiChatResponse({ content: "ollama" })]);
    await compose(model({ model: "ollama/llama3" }))("hi");
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("lets an explicit baseUrl override the local default", async () => {
    const calls = mockFetchSequence([openaiChatResponse({ content: "lmstudio" })]);
    await compose(model({ model: "lmstudio/m", baseUrl: "http://localhost:4321/v1" }))("hi");
    expect(calls[0].url).toBe("http://localhost:4321/v1/chat/completions");
  });
});

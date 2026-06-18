import { describe, it, expect, afterEach, vi } from "vitest";
import { compose, scope, model, setKeys } from "../src/index.js";
import { openaiResponse, mockFetchSequence } from "./util.js";

setKeys({ openai: "sk-test" });

afterEach(() => vi.unstubAllGlobals());

const weatherTool = (execute) => ({
  name: "get_weather",
  description: "weather",
  schema: { city: { type: "string" } },
  execute,
});

describe("model tool loop", () => {
  it("executes a requested tool and feeds the result back for a final answer", async () => {
    const calls = mockFetchSequence([
      openaiResponse({ toolCalls: [{ name: "get_weather", args: { city: "Paris" } }] }),
      openaiResponse({ content: "It is sunny in Paris." }),
    ]);

    const execute = vi.fn(async ({ city }) => ({ city, temp: "20C" }));
    const result = await compose(
      scope({ tools: [weatherTool(execute)] }, model({ model: "openai/gpt-5.2" })),
    )("weather in Paris?");

    expect(execute).toHaveBeenCalledWith({ city: "Paris" });
    expect(result.lastResponse.content).toBe("It is sunny in Paris.");

    // the second request must include the tool result in its message history
    const toolMsg = calls[1].body.messages.find((m) => m.role === "tool");
    expect(JSON.parse(toolMsg.content)).toEqual({ city: "Paris", temp: "20C" });
  });

  it("accumulates usage across every model round-trip", async () => {
    mockFetchSequence([
      openaiResponse({
        toolCalls: [{ name: "get_weather", args: { city: "X" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
      openaiResponse({
        content: "done",
        usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
      }),
    ]);

    const result = await compose(
      scope({ tools: [weatherTool(async () => "ok")] }, model({ model: "openai/gpt-5.2" })),
    )("go");

    expect(result.usage.totalTokens).toBe(40);
  });

  it("enforces a tool's _maxCalls and reports the limit back to the model", async () => {
    mockFetchSequence([
      openaiResponse({ toolCalls: [{ name: "get_weather", args: { city: "A" } }] }),
      openaiResponse({ toolCalls: [{ name: "get_weather", args: { city: "B" } }] }),
      openaiResponse({ content: "stopped" }),
    ]);

    const execute = vi.fn(async () => "result");
    const tool = { ...weatherTool(execute), _maxCalls: 1 };

    const result = await compose(
      scope({ tools: [tool] }, model({ model: "openai/gpt-5.2" })),
    )("go");

    expect(execute).toHaveBeenCalledTimes(1);
    const limitMsg = result.history.filter((m) => m.role === "tool").at(-1);
    expect(limitMsg.content).toMatch(/reached its limit/);
    expect(result.lastResponse.content).toBe("stopped");
  });

  it("captures a thrown tool error as a result instead of crashing the loop", async () => {
    mockFetchSequence([
      openaiResponse({ toolCalls: [{ name: "get_weather", args: { city: "A" } }] }),
      openaiResponse({ content: "handled" }),
    ]);

    const result = await compose(
      scope(
        { tools: [weatherTool(async () => {
          throw new Error("upstream down");
        })] },
        model({ model: "openai/gpt-5.2" }),
      ),
    )("go");

    const toolMsg = result.history.find((m) => m.role === "tool");
    expect(JSON.parse(toolMsg.content).error).toBe("upstream down");
    expect(result.lastResponse.content).toBe("handled");
  });

  it("reports invalid JSON tool arguments as an error result", async () => {
    mockFetchSequence([
      jsonResponseWithBadArgs(),
      openaiResponse({ content: "ok" }),
    ]);

    const execute = vi.fn();
    const result = await compose(
      scope({ tools: [weatherTool(execute)] }, model({ model: "openai/gpt-5.2" })),
    )("go");

    expect(execute).not.toHaveBeenCalled();
    const toolMsg = result.history.find((m) => m.role === "tool");
    expect(JSON.parse(toolMsg.content).error).toMatch(/Invalid JSON/);
  });

  it("defaults to a sensible model string when none is given", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "hi" })]);
    await compose(model())("hello");
    expect(calls[0].body.model).toBe("gpt-5.2");
  });

  it("supports a system prompt computed from context", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(
      model({ model: "openai/gpt-5.2", system: (ctx) => `history has ${ctx.history.length} message(s)` }),
    )("hi");
    expect(calls[0].body.messages[0]).toEqual({
      role: "system",
      content: "history has 1 message(s)",
    });
  });
});

describe("model tracing", () => {
  it("wraps generation and tool execution in tracer spans", async () => {
    mockFetchSequence([
      openaiResponse({ toolCalls: [{ name: "get_weather", args: { city: "X" } }] }),
      openaiResponse({ content: "done" }),
    ]);

    const spans = [];
    const tracer = {
      span: vi.fn((name, attrs, fn) => {
        spans.push(name);
        return fn();
      }),
    };

    await compose(
      scope({ tools: [weatherTool(async () => "ok")] }, model({ model: "openai/gpt-5.2", tracer })),
    )("go");

    expect(spans).toContain("ai.generate:openai/gpt-5.2");
    expect(spans).toContain("ai.tool:get_weather");
  });
});

// an OpenAI response whose tool call carries malformed JSON arguments
function jsonResponseWithBadArgs() {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_0", type: "function", function: { name: "get_weather", arguments: "{bad json" } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200 },
  );
}

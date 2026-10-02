import { describe, it, expect, afterEach, vi } from "vitest";
import { compose, scope, model, setKeys } from "../src/index.js";
import { openaiResponse, mockFetchSequence } from "./util.js";

setKeys({ openai: "sk-test" });
afterEach(() => vi.unstubAllGlobals());

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const tool = (execute) => ({ name: "work", description: "Work", schema: {}, execute });

const assertPairs = (history, ids) => {
  expect(history.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? [])).toEqual(ids);
  expect(history.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(ids);
};

describe("model beforeRequest", () => {
  it.each([false, true])("waits for complete tool batches with parallel=%s", async (parallel) => {
    const calls = mockFetchSequence([
      openaiResponse({ toolCalls: [{ id: "a", name: "work" }, { id: "b", name: "work" }] }),
      openaiResponse({ toolCalls: [{ id: "c", name: "work" }] }),
      openaiResponse({ content: "done" }),
    ]);
    const started = [deferred(), deferred(), deferred()];
    const gates = [deferred(), deferred(), deferred()];
    const completed = [];
    let executions = 0;
    const execute = async () => {
      const index = executions++;
      started[index].resolve();
      await gates[index].promise;
      completed.push(index);
      return index;
    };
    const beforeRequest = vi.fn(async (ctx) => {
      const round = calls.length;
      expect(completed).toHaveLength(round === 0 ? 0 : round === 1 ? 2 : 3);
      assertPairs(ctx.history, round === 0 ? [] : round === 1 ? ["a", "b"] : ["a", "b", "c"]);
      return { ...ctx, history: [...ctx.history, { role: "user", content: `shell exit ${round}` }] };
    });
    const pending = compose(scope({ tools: [tool(execute)], toolConfig: { parallel } }, model({ beforeRequest })))("go");
    await started[0].promise;
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    if (parallel) {
      await started[1].promise;
      gates[1].resolve();
      await Promise.resolve();
      expect(beforeRequest).toHaveBeenCalledTimes(1);
      gates[0].resolve();
    } else {
      expect(executions).toBe(1);
      gates[0].resolve();
      await started[1].promise;
      expect(beforeRequest).toHaveBeenCalledTimes(1);
      gates[1].resolve();
    }
    await started[2].promise;
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    gates[2].resolve();
    const result = await pending;
    expect(beforeRequest).toHaveBeenCalledTimes(3);
    assertPairs(result.history, ["a", "b", "c"]);
    expect(result.lastResponse.content).toBe("done");
    for (const [round, call] of calls.entries()) {
      expect(call.body.input.filter((item) => item.role === "user").map((item) => item.content[0].text))
        .toEqual(["go", ...Array.from({ length: round + 1 }, (_, index) => `shell exit ${index}`)]);
      expect(call.body.input.filter((item) => item.type === "function_call").map((item) => item.call_id))
        .toEqual(round === 0 ? [] : round === 1 ? ["a", "b"] : ["a", "b", "c"]);
      expect(call.body.input.filter((item) => item.type === "function_call_output").map((item) => item.call_id))
        .toEqual(round === 0 ? [] : round === 1 ? ["a", "b"] : ["a", "b", "c"]);
    }
  });

  it("awaits the hook and propagates replacement history and system instructions", async () => {
    const calls = mockFetchSequence([openaiResponse({ content: "done" })]);
    const entered = deferred();
    const gate = deferred();
    const pending = model({ system: "initial", beforeRequest: async (ctx) => {
      entered.resolve();
      await gate.promise;
      return { ...ctx, history: [{ role: "system", content: "updated" }, ...ctx.history.slice(1), { role: "user", content: "exit" }] };
    } })("go");
    await entered.promise;
    expect(calls).toHaveLength(0);
    gate.resolve();
    const result = await pending;
    expect(calls[0].body.instructions).toBe("updated");
    expect(calls[0].body.input.map((item) => item.content[0].text)).toEqual(["go", "exit"]);
    expect(result.history.some((message) => message.content === "exit")).toBe(true);
  });

  it("skips the hook and request when already aborted", async () => {
    const calls = mockFetchSequence([openaiResponse()]);
    const beforeRequest = vi.fn((ctx) => ctx);
    const controller = new AbortController();
    controller.abort();
    const ctx = { history: [], abortSignal: controller.signal };
    expect(await model({ beforeRequest })(ctx)).toBe(ctx);
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each(["original", "returned"])("checks the %s abort signal after awaiting the hook", async (signalSource) => {
    const calls = mockFetchSequence([openaiResponse()]);
    const original = new AbortController();
    const replacement = new AbortController();
    const entered = deferred();
    const gate = deferred();
    const pending = model({ beforeRequest: async (ctx) => {
      entered.resolve();
      await gate.promise;
      return { ...ctx, abortSignal: replacement.signal };
    } })({ history: [], abortSignal: original.signal });
    await entered.promise;
    (signalSource === "original" ? original : replacement).abort();
    gate.resolve();
    await pending;
    expect(calls).toHaveLength(0);
  });

  it.each([false, true])("finishes tool-result pairing when aborted during a batch with parallel=%s", async (parallel) => {
    const calls = mockFetchSequence([openaiResponse({ toolCalls: [{ id: "a", name: "work" }, { id: "b", name: "work" }] })]);
    const controller = new AbortController();
    const beforeRequest = vi.fn((ctx) => ctx);
    const execute = vi.fn(async () => { controller.abort(); return "completed"; });
    const result = await compose(scope({ tools: [tool(execute)], toolConfig: { parallel } }, model({ beforeRequest })))({ history: [{ role: "user", content: "go" }], abortSignal: controller.signal });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    assertPairs(result.history, ["a", "b"]);
  });

  it("propagates hook errors without making a request", async () => {
    const calls = mockFetchSequence([openaiResponse()]);
    await expect(model({ beforeRequest: async () => { throw new Error("hook failed"); } })("go")).rejects.toThrow("hook failed");
    expect(calls).toHaveLength(0);
  });
});

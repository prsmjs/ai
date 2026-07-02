import { describe, it, expect, afterEach, vi } from "vitest";
import {
  compose,
  scope,
  model,
  setKeys,
  onApprovalRequested,
  resolveApproval,
  removeApprovalListener,
} from "../src/index.js";
import { openaiResponse, mockFetchSequence } from "./util.js";

setKeys({ openai: "sk-test" });

afterEach(() => vi.unstubAllGlobals());

const deleteTool = (execute) => ({
  name: "delete_user",
  description: "delete a user",
  schema: { id: { type: "string" } },
  execute,
});

describe("tool approval", () => {
  it("executes a tool when the approval callback returns true", async () => {
    mockFetchSequence([
      openaiResponse({ toolCalls: [{ name: "delete_user", args: { id: "1" } }] }),
      openaiResponse({ content: "deleted" }),
    ]);
    const execute = vi.fn(async () => "ok");

    await compose(
      scope(
        { tools: [deleteTool(execute)], toolConfig: { requireApproval: true, approvalCallback: () => true } },
        model({ model: "openai/gpt-5.2" }),
      ),
    )("delete user 1");

    expect(execute).toHaveBeenCalled();
  });

  it("skips execution and records a denial when the callback returns false", async () => {
    mockFetchSequence([
      openaiResponse({ toolCalls: [{ name: "delete_user", args: { id: "1" } }] }),
      openaiResponse({ content: "did not delete" }),
    ]);
    const execute = vi.fn();

    const result = await compose(
      scope(
        { tools: [deleteTool(execute)], toolConfig: { requireApproval: true, approvalCallback: () => false } },
        model({ model: "openai/gpt-5.2" }),
      ),
    )("delete user 1");

    expect(execute).not.toHaveBeenCalled();
    const toolMsg = result.history.find((m) => m.role === "tool");
    expect(JSON.parse(toolMsg.content).error).toMatch(/denied/);
  });

  it("runs approved tools sequentially in call order by default", async () => {
    mockFetchSequence([
      openaiResponse({
        toolCalls: [
          { name: "delete_user", args: { id: "1" } },
          { name: "delete_user", args: { id: "2" } },
        ],
      }),
      openaiResponse({ content: "done" }),
    ]);

    const order = [];
    const execute = async ({ id }) => {
      order.push(id);
      return "ok";
    };

    await compose(
      scope({ tools: [deleteTool(execute)] }, model({ model: "openai/gpt-5.2" })),
    )("delete 1 and 2");

    expect(order).toEqual(["1", "2"]);
  });

  it("fails fast when approval is required but nothing can resolve it", async () => {
    mockFetchSequence([
      openaiResponse({ toolCalls: [{ name: "delete_user", args: { id: "1" } }] }),
    ]);
    const execute = vi.fn();

    await expect(
      compose(
        scope(
          { tools: [deleteTool(execute)], toolConfig: { requireApproval: true } },
          model({ model: "openai/gpt-5.2" }),
        ),
      )("delete user 1"),
    ).rejects.toThrow(/nothing can resolve it/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("resolves an event-driven approval through resolveApproval", async () => {
    mockFetchSequence([
      openaiResponse({ toolCalls: [{ name: "delete_user", args: { id: "1" } }] }),
      openaiResponse({ content: "deleted" }),
    ]);
    const execute = vi.fn(async () => "ok");

    const listener = (request) => resolveApproval({ id: request.id, approved: true });
    onApprovalRequested(listener);

    try {
      await compose(
        scope(
          { tools: [deleteTool(execute)], toolConfig: { requireApproval: true } },
          model({ model: "openai/gpt-5.2" }),
        ),
      )("delete user 1");
    } finally {
      removeApprovalListener("approvalRequested", listener);
    }

    expect(execute).toHaveBeenCalled();
  });
});

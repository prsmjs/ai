# Tool Approval

Require user approval before executing tools.

Tool approval lets you intercept tool calls before execution and decide whether to allow or deny them. Useful for dangerous operations or interactive agents.

## Web app approval (SSE)

The server sends approval requests to the frontend via SSE, and the frontend posts the decision back.

### Backend (server.js)

```js
import express from "express";
import { getOrCreateThread, compose, model, scope } from "@prsm/ai";

const app = express();
app.use(express.json());

const pendingApprovals = new Map();

const weatherTool = {
  name: "get_weather",
  description: "Get weather for a city",
  schema: { city: { type: "string", description: "City name" } },
  execute: async ({ city }) => ({ city, temp: "72F", condition: "sunny" }),
};

app.post("/chat/:threadId", async (req, res) => {
  const { threadId } = req.params;
  const { message } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const thread = getOrCreateThread(threadId);

  const approvalCallback = (toolCall) =>
    new Promise((resolve) => {
      const approvalId = `${threadId}-${toolCall.id}`;
      pendingApprovals.set(approvalId, resolve);
      res.write(
        `data: ${JSON.stringify({
          type: "tool_approval_required",
          toolName: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments),
          approvalId,
        })}\n\n`,
      );
    });

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const workflow = compose(
    scope(
      {
        tools: [weatherTool],
        toolConfig: { requireApproval: true, approvalCallback },
        stream: (event) => {
          switch (event.type) {
            case "content":
              send("content", { content: event.content });
              break;
            case "tool_calls_ready":
              send("tool_calls", { calls: event.calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })) });
              break;
            case "tool_executing":
              send("tool_executing", { id: event.call.id, name: event.call.function.name });
              break;
            case "tool_complete":
              send("tool_complete", { id: event.call.id, name: event.call.function.name, result: event.result });
              break;
            case "tool_error":
              send("tool_error", { id: event.call.id, name: event.call.function.name, error: event.error });
              break;
          }
        },
      },
      model(),
    ),
  );

  await thread.message(message, workflow);
  res.write(`data: ${JSON.stringify({ type: "complete" })}\n\n`);
  res.end();
});

app.post("/approve/:approvalId", (req, res) => {
  const { approvalId } = req.params;
  const { approved } = req.body;

  const resolve = pendingApprovals.get(approvalId);
  if (!resolve) return res.status(404).json({ error: "approval not found" });

  pendingApprovals.delete(approvalId);
  resolve(approved);
  res.json({ success: true });
});

app.listen(3000);
```

The `approvalCallback` returns a promise that resolves when the client posts to `/approve/:approvalId`, at which point tool execution continues.

### Frontend (client.js)

```js
const output = document.getElementById("output");

function handleEvent(type, data) {
  switch (type) {
    case "content":
      output.textContent += data.content;
      break;
    case "tool_approval_required":
      showApprovalDialog(data);
      break;
    case "tool_executing":
      console.log(`executing ${data.name}...`);
      break;
    case "tool_complete":
      console.log(`${data.name} result:`, data.result);
      break;
    case "tool_error":
      console.log(`${data.name} failed:`, data.error);
      break;
  }
}

async function showApprovalDialog({ toolName, approvalId, arguments: args }) {
  const approved = confirm(`Allow ${toolName}?\nArguments: ${JSON.stringify(args, null, 2)}`);
  await fetch(`/approve/${approvalId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
}

async function chat(threadId, message) {
  const res = await fetch(`/chat/${threadId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = JSON.parse(line.slice(6));
      handleEvent(data.type, data);
    }
  }
}

chat("user-123", "what's the weather in NYC?");
```

The client shows a confirmation dialog on `tool_approval_required` and posts the decision back. Approve with `{ approved: true }`, deny with `{ approved: false }`.

## Event-driven approval (without a callback)

Instead of passing `approvalCallback`, you can leave it off and resolve approvals through the module's event API. This is handy when the approval UI is decoupled from the workflow.

```js
import { onApprovalRequested, resolveApproval } from "@prsm/ai";

onApprovalRequested((request) => {
  // request.id, request.toolCall, request.approvalId
  // resolve it whenever your UI decides
  resolveApproval({ id: request.id, approved: true });
});

// then run a workflow with requireApproval and no approvalCallback
scope({ tools: [deleteTool], toolConfig: { requireApproval: true } }, model());
```

A listener that resolves synchronously inside the handler works correctly - the resolver is registered before the event fires.

## CLI approval

Interactive CLI approval, as in the `code-agent` example.

```js
import readline from "readline";
import { compose, model, scope } from "@prsm/ai";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const askUser = (question) =>
  new Promise((resolve) => rl.question(question, (answer) => resolve(answer.toLowerCase() === "y")));

const approvalCallback = async (call) => {
  const args = JSON.parse(call.function.arguments);
  console.log(`\n[tool approval required]`);
  console.log(`tool: ${call.function.name}`);
  console.log(`args: ${JSON.stringify(args, null, 2)}`);
  return askUser("approve? (y/n): ");
};

const workflow = compose(
  scope(
    {
      tools: [readFileTool, writeFileTool, bashTool],
      toolConfig: { requireApproval: true, approvalCallback },
    },
    model(),
  ),
);

await workflow("list all js files");
```

## Execute on approval

By default, when the model requests multiple tools, the library waits for all approvals before executing any, so tools run in the order the model intended. Set `executeOnApproval: true` to run each tool the moment it's approved.

```js
toolConfig: {
  requireApproval: true,
  approvalCallback,
  executeOnApproval: true,
}
```

**Default (`executeOnApproval: false`):** the model requests A, B, C; the user approves each; then all three execute (in order, or in parallel if `parallel` is set).

**With `executeOnApproval: true`:** each tool executes immediately when approved. Useful when tools are independent. Avoid it when tools depend on each other (for example, read a file then write it).

## Denial handling

When a tool is denied, the model receives an error in the tool response.

```json
{ "error": "Tool execution denied by user" }
```

The model can see this and adjust - ask for different parameters, try another approach, or explain why the tool is needed.

## Streaming with approval

Stream events fire throughout the approval flow. `tool_calls_ready` fires before approval, and `tool_executing` fires after approval is granted.

```js
scope(
  {
    tools: [weatherTool],
    toolConfig: { requireApproval: true, approvalCallback },
    stream: (event) => {
      switch (event.type) {
        case "tool_calls_ready":
          console.log("model wants to call:", event.calls.map((c) => c.function.name));
          break;
        case "tool_executing":
          console.log(`executing ${event.call.function.name}...`);
          break;
        case "tool_complete":
          console.log(`${event.call.function.name} returned:`, event.result);
          break;
        case "tool_error":
          console.log(`${event.call.function.name} failed:`, event.error);
          break;
      }
    },
  },
  model(),
);
```

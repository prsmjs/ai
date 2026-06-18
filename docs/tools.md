# Tools

Give models functions they can execute during a conversation.

## Basic tool definition

```js
const calculator = {
  name: "calculate",
  description: "Perform basic math operations",
  schema: {
    operation: {
      type: "string",
      description: "The operation to perform",
      enum: ["add", "subtract", "multiply", "divide"],
    },
    a: { type: "number", description: "First number" },
    b: { type: "number", description: "Second number" },
  },
  execute: async ({ operation, a, b }) => {
    switch (operation) {
      case "add": return a + b;
      case "subtract": return a - b;
      case "multiply": return a * b;
      case "divide": return a / b;
      default: return "invalid operation";
    }
  },
};
```

The schema defines parameters and the execute function runs the logic.

## Using tools

```js
import { compose, model, scope } from "@prsm/ai";

const workflow = compose(
  scope({ tools: [calculator] }, model()),
);

const result = await workflow("what is 15 * 23?");
```

The model calls the tool automatically when needed, and `model()` loops until it answers with text.

## Zod schemas

Use Zod for type-safe tool schemas.

```js
import { z } from "zod";

const weather = {
  name: "get_weather",
  description: "Get weather for a city",
  schema: z.object({
    city: z.string().describe("City name"),
    units: z.enum(["celsius", "fahrenheit"]).optional(),
  }),
  execute: async ({ city, units = "celsius" }) => {
    return { city, temp: 22, units };
  },
};
```

The library converts Zod schemas automatically. Zod is an optional peer dependency - install it only if you use it.

## Tool limits

Limit how many times a tool can be called to prevent infinite loops or excessive API usage.

### Permanent limit on the tool definition

Add `_maxCalls` directly to the tool.

```js
const search = {
  name: "web_search",
  description: "Search the web",
  schema: { query: { type: "string", description: "Search query" } },
  execute: async ({ query }) => {
    return await fetch(`https://api.search.com?q=${query}`);
  },
  _maxCalls: 3,
};
```

This tool uses a limit of 3 calls whenever it's added to a scope. If you pass this object to multiple workflows, they all share the same limit (3 calls per workflow execution).

### Dynamic limit per workflow

Use `maxCalls()` to set different limits for different workflows.

```js
import { maxCalls, compose, model, scope } from "@prsm/ai";

const search = {
  name: "web_search",
  description: "Search the web",
  schema: { query: { type: "string", description: "Search query" } },
  execute: async ({ query }) => fetch(`https://api.search.com?q=${query}`),
};

const limitedWorkflow = compose(
  scope({ tools: [maxCalls(search, 2)] }, model()),
);

const generousWorkflow = compose(
  scope({ tools: [maxCalls(search, 10)] }, model()),
);
```

`maxCalls()` returns a new tool object with a limit for that specific workflow.

**When to use each:**

- `_maxCalls` on the definition sets a default limit shared by every scope using that object.
- `maxCalls()` creates a new object with a different limit, so the same base tool can have different limits in different workflows.

When a tool hits its limit, the model receives a "reached its limit" message as the tool result and can adjust.

## Parallel execution

Execute multiple tool calls at once.

```js
scope(
  {
    tools: [weather, calculator, search],
    toolConfig: { parallel: true },
  },
  model(),
);
```

The default is sequential execution, which preserves the order the model intended.

## Tool retry

Retry failed tool calls.

```js
scope(
  {
    tools: [unreliableApi],
    toolConfig: { retryCount: 2 },
  },
  model(),
);
```

Retries tool execution up to 2 times on failure. A tool that throws is captured as an error result and fed back to the model rather than crashing the loop.

## Streaming tool events

A `stream` callback lets you react to tool execution in real time - showing progress in a UI, or logging tool usage. Even with streaming on, several tool calls can run in a single turn, and each lifecycle event arrives in order.

### Web app streaming

#### Backend (server.js)

```js
import express from "express";
import { getOrCreateThread, compose, model, scope } from "@prsm/ai";

const app = express();
app.use(express.json());

const weatherTool = {
  name: "get_weather",
  description: "Get weather for a city",
  schema: { city: { type: "string", description: "City name" } },
  execute: async ({ city }) => {
    const response = await fetch(`https://wttr.in/${city}?format=j1`);
    const data = await response.json();
    return {
      city,
      temp: data.current_condition[0].temp_C,
      condition: data.current_condition[0].weatherDesc[0].value,
    };
  },
};

app.post("/chat/:threadId", async (req, res) => {
  const { threadId } = req.params;
  const { message } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const thread = getOrCreateThread(threadId);

  const workflow = compose(
    scope(
      {
        tools: [weatherTool],
        toolConfig: { parallel: true },
        stream: (event) => {
          switch (event.type) {
            case "content":
              res.write(`data: ${JSON.stringify({ type: "content", content: event.content })}\n\n`);
              break;
            case "tool_calls_ready":
              res.write(`data: ${JSON.stringify({ type: "tool_calls_ready", calls: event.calls.map((c) => c.function.name) })}\n\n`);
              break;
            case "tool_executing":
              res.write(`data: ${JSON.stringify({ type: "tool_executing", name: event.call.function.name, args: JSON.parse(event.call.function.arguments) })}\n\n`);
              break;
            case "tool_complete":
              res.write(`data: ${JSON.stringify({ type: "tool_complete", name: event.call.function.name, result: event.result })}\n\n`);
              break;
            case "tool_error":
              res.write(`data: ${JSON.stringify({ type: "tool_error", name: event.call.function.name, error: event.error })}\n\n`);
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

app.listen(3000);
```

The stream callback receives events during model execution and forwards them to the client via SSE.

#### Frontend (client.js)

```js
const chatForm = document.getElementById("chat-form");
const messagesDiv = document.getElementById("messages");
const toolStatusDiv = document.getElementById("tool-status");

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = e.target.message.value;

  const response = await fetch("/chat/user-123", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n\n");

    for (const line of lines) {
      if (!line.trim() || !line.startsWith("data: ")) continue;
      const data = JSON.parse(line.replace("data: ", ""));

      if (data.type === "content") messagesDiv.textContent += data.content;
      if (data.type === "tool_calls_ready") toolStatusDiv.textContent = `calling: ${data.calls.join(", ")}`;
      if (data.type === "tool_executing") toolStatusDiv.textContent = `executing ${data.name}...`;
      if (data.type === "tool_complete") toolStatusDiv.textContent = "";
      if (data.type === "tool_error") toolStatusDiv.textContent = `error: ${data.error}`;
      if (data.type === "complete") toolStatusDiv.textContent = "";
    }
  }
});
```

The client listens to the SSE stream and updates the UI based on event types. See the `basic-chat` example in the repo for a complete, runnable version.

### CLI streaming

```js
import { compose, model, scope } from "@prsm/ai";

const workflow = compose(
  scope(
    {
      tools: [calculator, weather, search],
      stream: (event) => {
        switch (event.type) {
          case "content":
            process.stdout.write(event.content);
            break;
          case "tool_calls_ready":
            console.log(`\n[tools queued: ${event.calls.map((c) => c.function.name).join(", ")}]`);
            break;
          case "tool_executing":
            console.log(`[executing: ${event.call.function.name}]`);
            break;
          case "tool_complete":
            console.log(`[${event.call.function.name} complete]`);
            break;
          case "tool_error":
            console.log(`[${event.call.function.name} failed: ${event.error}]`);
            break;
        }
      },
    },
    model(),
  ),
);

await workflow("what's the weather in tokyo and what's 15 * 23?");
```

## Tool approval with streaming

For interactive apps you often want user approval before executing tools. Streaming and approval work together: stream events show what tools are being called, and approval lets users decide whether to allow them. See [Tool Approval](./approval.md) for the full SSE and CLI flows.

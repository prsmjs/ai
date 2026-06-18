<p align="center">
  <img src=".github/logo.svg" width="80" height="80" alt="@prsm/ai logo">
</p>

<h1 align="center">@prsm/ai</h1>

<p align="center">
  <a href="https://github.com/prsmjs/ai/actions/workflows/test.yml"><img src="https://github.com/prsmjs/ai/actions/workflows/test.yml/badge.svg" alt="test"></a>
  <a href="https://www.npmjs.com/package/@prsm/ai"><img src="https://img.shields.io/npm/v/@prsm/ai.svg" alt="npm"></a>
</p>

Composable LLM inference with multi-provider support, tool execution, streaming, structured output, and approval workflows.

You build a workflow by composing small steps. Each step takes a conversation context and returns a new one, so pipelines read top to bottom and stay easy to reason about.

## Installation

```bash
npm install @prsm/ai
```

Node 24 or newer. The `zod`, `@huggingface/transformers`, and `@modelcontextprotocol/sdk` packages are optional peers - install them only for the features that need them (Zod schemas, local HuggingFace inference, MCP servers).

## Quick start

```js
import { compose, model, setKeys } from "@prsm/ai";

setKeys({ openai: process.env.OPENAI_API_KEY });

const result = await compose(model())("What is 2 + 2?");
console.log(result.lastResponse.content);
```

## Composition

```js
import { compose, scope, model, when, tap, toolWasCalled } from "@prsm/ai";

const workflow = compose(
  scope(
    { tools: [searchTool], system: "you are a researcher" },
    model({ model: "openai/gpt-5.2" }),
  ),
  when(toolWasCalled("search"), scope({ system: "summarize the findings" }, model())),
  tap((ctx) => console.log(ctx.lastResponse?.content)),
);

const result = await workflow("find recent papers on WebSockets");
```

| Function | Purpose |
|---|---|
| `compose(...steps)` | Chain steps into a pipeline |
| `scope(config, ...steps)` | Isolated context with tools, a system prompt, and inheritance control |
| `model(config?)` | Call an LLM and auto-execute any tool calls it returns |
| `when(condition, step)` | Run a step only when a predicate holds |
| `tap(fn)` | Run a side effect without changing the context |
| `retry({ times }, step)` | Retry a step on failure |

## Providers

Select a provider with a `provider/model` prefix:

```js
model({ model: "openai/gpt-5.2" });
model({ model: "anthropic/claude-sonnet-4-5" });
model({ model: "google/gemini-2.5-flash" });
model({ model: "xai/grok-4" });
```

API keys resolve in this order: `config.apiKey`, then `setKeys()`, then environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`).

### Local and OpenAI-compatible endpoints

Anything that speaks the OpenAI chat completions API works. LM Studio, Ollama, and bare local servers have built-in prefixes, and an explicit `baseUrl` overrides the default for any of them:

```js
model({ model: "lmstudio/llama-3.1-8b" });             // http://localhost:1234/v1
model({ model: "ollama/llama3" });                     // http://localhost:11434/v1
model({ model: "local/my-model", baseUrl: "http://192.168.1.5:1234/v1" });
```

A bare model name with no prefix runs locally through `@huggingface/transformers`.

## Tools

A tool is an object with a name, description, schema, and an `execute` function. When the model calls a tool, `model()` runs it and feeds the result back, looping until the model answers with text.

```js
const searchTool = {
  name: "search",
  description: "search the web",
  schema: { query: { type: "string", description: "search query" } },
  execute: async ({ query }) => searchWeb(query),
  _maxCalls: 5,
};

const result = await compose(scope({ tools: [searchTool] }, model()))(
  "search for WebSocket frameworks",
);
```

Schemas can be plain JSON Schema (as above) or [Zod](https://zod.dev) schemas, which are converted automatically:

```js
import { z } from "zod";

const searchTool = {
  name: "search",
  description: "search the web",
  schema: z.object({ query: z.string().describe("search query") }),
  execute: async ({ query }) => searchWeb(query),
};
```

## Structured output

Pass a JSON Schema or a Zod schema to `model()`:

```js
import { z } from "zod";

const result = await compose(
  model({ model: "openai/gpt-5.2", schema: z.object({ name: z.string(), age: z.number() }) }),
)("Extract: John is 30 years old");

JSON.parse(result.lastResponse.content); // { name: "John", age: 30 }
```

## Streaming

Pass a `stream` callback. It receives content deltas and the full tool-call lifecycle, which is what you forward to a browser over SSE (see `examples/basic-chat`):

```js
const result = await compose(
  scope(
    {
      stream: (event) => {
        if (event.type === "content") process.stdout.write(event.content);
        if (event.type === "tool_executing") console.log("calling", event.call.function.name);
      },
    },
    model(),
  ),
)("explain WebSockets");
```

Event types: `content`, `tool_call_start`, `tool_call_delta`, `tool_calls_ready`, `tool_executing`, `tool_complete`, `tool_error`, `approval_requested`, `usage`.

## Threads

Threads keep multi-turn conversation history with pluggable storage:

```js
import { getOrCreateThread, compose, model } from "@prsm/ai";

const thread = getOrCreateThread("user-123");
await thread.message("hello", compose(model()));
await thread.message("what did I just say?", compose(model()));
```

The default store is in-memory. Pass your own `get`/`set` to persist:

```js
const thread = getOrCreateThread("user-123", {
  get: async (id) => db.getMessages(id),
  set: async (id, messages) => db.setMessages(id, messages),
});
```

## Scope inheritance

`scope()` controls what an inner step sees:

```js
import { Inherit, noToolsCalled } from "@prsm/ai";

scope({ inherit: Inherit.Nothing }, model());       // fresh context, no history
scope({ inherit: Inherit.Conversation }, model());  // carry history, not tools
scope({ inherit: Inherit.All }, model());           // carry everything

scope({ silent: true, tools: [analysisTool] }, model());  // tools run, history untouched
scope({ until: noToolsCalled(), tools: [researchTool] }, model());  // loop until the model stops calling tools
```

## Tool approval

Gate tool execution behind approval, synchronously or through an async UI:

```js
const result = await compose(
  scope(
    {
      tools: [deleteTool],
      toolConfig: {
        requireApproval: true,
        approvalCallback: (call) => confirm(`Allow ${call.function.name}?`),
      },
    },
    model(),
  ),
)("delete all inactive users");
```

For event-driven approval (for example, a server that waits on a browser POST), omit `approvalCallback` and resolve the request out of band with `onApprovalRequested` and `resolveApproval`. See `examples/tool-approval`.

## Tracing

Pass a [@prsm/trace](https://github.com/prsmjs/trace) tracer (or anything with a compatible `span` method). Generation and each tool execution are wrapped in spans:

```js
import { createTracer } from "@prsm/trace";

const tracer = createTracer();
await compose(scope({ tools: [searchTool] }, model({ tracer })))("research topic X");
// spans: ai.generate:openai/gpt-5.2, ai.tool:search
```

## MCP

Expose an MCP server's tools as `@prsm/ai` tools:

```js
import { connectMCP } from "@prsm/ai";

const connection = await connectMCP({ transport: () => myTransport });
const result = await compose(scope({ tools: connection.tools }, model()))(
  "use the available tools",
);
```

## Helpers

```js
import { noToolsCalled, toolWasCalled, everyNMessages, appendToLastRequest } from "@prsm/ai";

scope({ until: noToolsCalled(), tools: [/* ... */] }, model());
when(toolWasCalled("search"), summarizeStep);
everyNMessages(10, appendToLastRequest("stay concise"));
```

## Usage tracking

Token usage accumulates through the pipeline, including nested and silent scopes:

```js
const result = await workflow("prompt");
console.log(result.usage); // { promptTokens, completionTokens, totalTokens, cachedTokens }
```

## Examples

Runnable references live in [`examples/`](./examples): a streaming chat server, a human-in-the-loop tool approval server, and a terminal coding agent.

## Guides

Deeper guides live in [`docs/`](./docs):

- [Composition](./docs/composition.md) - compose, scope, model, when, tap, retry, inheritance, tracing
- [Tools](./docs/tools.md) - definitions, Zod schemas, call limits, parallel execution, streaming tool events
- [Threads](./docs/threads.md) - persistent history and custom storage (SQLite, Postgres, Redis)
- [Schemas](./docs/schemas.md) - structured JSON output with plain schemas or Zod
- [Tool Approval](./docs/approval.md) - SSE and CLI approval flows, event-driven approval
- [Multimodal Input](./docs/multimodal.md) - images, PDFs, and audio across providers
- [Helpers](./docs/helpers.md) - agentic loops, periodic extraction, conversation compression
- [MCP Integration](./docs/mcp.md) - connect Model Context Protocol servers

## License

ISC

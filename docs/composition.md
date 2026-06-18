# Composition

Combine workflow steps into complex behaviors using composable primitives.

## Compose

Chain steps together into a sequential pipeline.

```js
import { compose, model, tap } from "@prsm/ai";

const workflow = compose(
  tap((ctx) => console.log("before model call")),
  model(),
  tap((ctx) => console.log("after model call")),
);

await workflow("hello");
```

Each step receives conversation context and returns updated context.

## Model

Call an LLM.

```js
import { model } from "@prsm/ai";

const result = await model()("what is 2+2?");
```

### With a specific model

```js
const result = await model({
  model: "openai/gpt-5.2",
})("explain quantum physics");
```

Model format is `provider/model-name`. Supported providers:

- `openai/<model>`
- `anthropic/<model>`
- `google/<model>`
- `xai/<model>`
- `local/<model>`, `lmstudio/<model>`, `ollama/<model>` (OpenAI-compatible local servers)
- a bare model name with no slash runs locally through `@huggingface/transformers`

### With a custom API key

```js
const result = await model({
  model: "openai/gpt-5.2",
  apiKey: "sk-different-key",
})("explain quantum physics");
```

Useful for multi-tenant apps where each user has their own key.

### With a custom base URL

```js
const result = await model({
  model: "openai/anthropic/claude-sonnet-4-5",
  apiKey: "sk-or-...",
  baseUrl: "https://openrouter.ai/api/v1",
})("explain quantum physics");
```

The model string is split on the first `/`. Here `openai` selects the OpenAI-compatible provider, and the rest (`anthropic/claude-sonnet-4-5`) is passed as the `model` field in the request body. This works with any OpenAI-compatible API like OpenRouter, Azure, or a local proxy. The `local`, `lmstudio`, and `ollama` prefixes are shortcuts for this with a localhost base URL baked in.

### With a system message

```js
const workflow = model({
  system: "you are a helpful coding assistant",
});

await workflow("help me write a function");
```

The system message gets prepended to conversation history.

### Dynamic system message

```js
const workflow = model({
  system: (ctx) => `conversation has ${ctx.history.length} messages`,
});
```

The function receives context and returns a system message string.

### With a tracer

`model()` accepts a `tracer` (a [@prsm/trace](https://github.com/prsmjs/trace) tracer, or anything with a compatible `span` method). Generation and each tool execution are wrapped in spans.

```js
import { createTracer } from "@prsm/trace";

const tracer = createTracer();
await model({ model: "openai/gpt-5.2", tracer })("explain quantum physics");
// spans: ai.generate:openai/gpt-5.2, and ai.tool:<name> for any tool calls
```

## Scope

Create isolated execution contexts.

```js
import { compose, model, scope } from "@prsm/ai";

const workflow = compose(
  scope(
    {
      system: "you are a weather assistant",
      tools: [weatherTool],
    },
    model(),
  ),
);
```

Scope isolates tools, system messages, streaming handlers, and the tracer.

### Inherit flags

Control what gets passed into a scope.

```js
import { Inherit } from "@prsm/ai";

scope({ inherit: Inherit.Nothing }, model());
scope({ inherit: Inherit.Conversation }, model());
scope({ inherit: Inherit.Tools }, model());
scope({ inherit: Inherit.All }, model());
```

**Inherit.Nothing** - empty context, no conversation history or tools. Useful for sub-agents that don't need parent context.

```js
const subAgent = scope(
  {
    inherit: Inherit.Nothing,
    system: "you are a specialized validator",
    tools: [validateTool],
  },
  model(),
);
```

**Inherit.Conversation** - includes conversation history (the default).

**Inherit.Tools** - includes tools from the parent scope.

**Inherit.All** - includes both conversation and tools.

### Until condition

Run a scope repeatedly until a condition is met.

```js
import { noToolsCalled } from "@prsm/ai";

scope(
  {
    tools: [calculator],
    until: noToolsCalled(),
  },
  model(),
);
```

Keeps calling the model until no tools are called (an agentic loop).

### Silent mode

Run a scope without updating parent history.

```js
scope(
  {
    inherit: Inherit.All,
    silent: true,
  },
  model(),
);
```

Tools still execute and token usage still propagates out, but the inner messages don't land in the parent history. Useful for validation or background tasks.

## When

Execute a step conditionally.

```js
import { when, model } from "@prsm/ai";

const workflow = compose(
  when(
    (ctx) => ctx.history.length > 10,
    model({ system: "summarize this conversation" }),
  ),
  model(),
);
```

Runs the step only if the condition returns true.

## Tap

Perform side effects without modifying context.

```js
import { tap } from "@prsm/ai";

const workflow = compose(
  tap((ctx) => {
    console.log(`history length: ${ctx.history.length}`);
  }),
  model(),
);
```

Useful for logging, metrics, and debugging.

## Retry

Retry failed steps.

```js
import { retry, model } from "@prsm/ai";

const workflow = compose(
  retry({ times: 3 }, model()),
);
```

Retries up to 3 times on failure, then rethrows the last error.

## Combining everything

```js
import { compose, model, scope, when, tap, retry, Inherit, noToolsCalled } from "@prsm/ai";

const workflow = compose(
  tap((ctx) => console.log("starting workflow")),

  when(
    (ctx) => ctx.history.length > 20,
    scope(
      {
        inherit: Inherit.Conversation,
        system: "summarize the conversation so far",
        silent: true,
      },
      model(),
    ),
  ),

  scope(
    {
      inherit: Inherit.All,
      tools: [calculator, weather, search],
      until: noToolsCalled(),
    },
    retry({ times: 2 }, model({ model: "openai/gpt-5.2" })),
  ),
);
```

Composition lets you build complex agent behaviors from simple primitives.

# Threads

Persistent conversation storage that automatically manages message history.

Threads let you maintain stateful conversations across multiple exchanges. Each thread has an ID and a storage backend. When you send a message, the thread loads history, runs your workflow, then saves the updated history back to storage.

## Basic usage

```js
import { getOrCreateThread } from "@prsm/ai";

const thread = getOrCreateThread("user-123");

await thread.message("hello, i'm building a todo app");
await thread.message("what should i name it?");
```

What happens:

- `getOrCreateThread("user-123")` creates or retrieves a thread with ID `user-123`.
- The first `message()` call loads history (empty), adds your message, calls `model()` with default settings, and saves the result.
- The second `message()` call loads the now-populated history, adds the new message, and calls the model with full context, so it remembers the earlier exchange.

**Default model:** when you don't pass a workflow, `thread.message()` uses `model()`, which defaults to `openai/gpt-5.2`.

## Specifying which model to use

Pass a workflow with the model you want.

```js
import { getOrCreateThread, model } from "@prsm/ai";

const thread = getOrCreateThread("user-123");

await thread.message(
  "explain quantum entanglement",
  model({ model: "anthropic/claude-sonnet-4-5" }),
);
```

The model is used only for this message. The next call uses the default again unless you specify otherwise.

## Using the same model for all messages

Create a reusable workflow.

```js
import { getOrCreateThread, model } from "@prsm/ai";

const thread = getOrCreateThread("user-123");
const sonnet = model({ model: "anthropic/claude-sonnet-4-5" });

await thread.message("first message", sonnet);
await thread.message("second message", sonnet);
await thread.message("third message", sonnet);
```

## Different models for different threads

```js
import { getOrCreateThread, model } from "@prsm/ai";

const fastThread = getOrCreateThread("quick-questions");
const smartThread = getOrCreateThread("complex-analysis");

const quick = model({ model: "google/gemini-2.5-flash" });
const smart = model({ model: "anthropic/claude-opus-4-1" });

await fastThread.message("what's 2+2?", quick);
await smartThread.message("analyze this research paper...", smart);
```

Each thread maintains separate history with different models.

## With tools and system prompts

Use compose and scope for complex workflows.

```js
import { getOrCreateThread, compose, model, scope } from "@prsm/ai";

const thread = getOrCreateThread("user-123");

const workflow = compose(
  scope(
    {
      system: "you are a helpful coding assistant",
      tools: [readFile, writeFile, searchWeb],
    },
    model({ model: "anthropic/claude-sonnet-4-5" }),
  ),
);

await thread.message("help me debug this function", workflow);
await thread.message("now add error handling", workflow);
```

The thread maintains history while the workflow defines behavior.

## In-memory storage

The default storage keeps messages in memory.

```js
const thread = getOrCreateThread("session-abc");
await thread.message("hello");
```

Conversations are lost when the process exits. Useful for development, temporary sessions, and stateless deployments that don't need persistence.

## Custom storage

Implement two methods to persist conversations to any database.

```js
import { getOrCreateThread } from "@prsm/ai";
import Database from "better-sqlite3";

const db = new Database("threads.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    messages TEXT,
    updated_at INTEGER
  )
`);

const thread = getOrCreateThread("user-123", {
  async get(id) {
    const row = db.prepare("SELECT messages FROM threads WHERE id = ?").get(id);
    return row ? JSON.parse(row.messages) : [];
  },
  async set(id, messages) {
    db.prepare(
      "INSERT OR REPLACE INTO threads (id, messages, updated_at) VALUES (?, ?, ?)",
    ).run(id, JSON.stringify(messages), Date.now());
  },
});

await thread.message("hello");
```

Now conversations persist across restarts. The same shape works with any storage.

**Postgres:**

```js
const thread = getOrCreateThread("user-123", {
  async get(id) {
    const result = await pool.query("SELECT messages FROM threads WHERE id = $1", [id]);
    return result.rows[0]?.messages || [];
  },
  async set(id, messages) {
    await pool.query(
      "INSERT INTO threads (id, messages) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET messages = $2",
      [id, JSON.stringify(messages)],
    );
  },
});
```

**Redis:**

```js
const thread = getOrCreateThread("user-123", {
  async get(id) {
    const data = await redis.get(`thread:${id}`);
    return data ? JSON.parse(data) : [];
  },
  async set(id, messages) {
    await redis.set(`thread:${id}`, JSON.stringify(messages));
  },
});
```

Threads sharing the same custom store are cached per store, so the same id with two different stores returns two distinct threads.

## Thread methods

### message

Adds a user message to history, runs the workflow, and saves the result.

```js
const result = await thread.message("what's the weather?", workflow);
console.log(result.lastResponse.content);
```

- `content` (string): user message to add to history.
- `workflow` (optional): workflow to run. Defaults to `model()` with `openai/gpt-5.2`.

Returns a `ConversationContext` with full history and the model response. Use it for normal user interactions.

### generate

Runs a workflow without adding a user message.

```js
const result = await thread.generate(workflow);
```

Use it for autonomous agents that act without user input, scheduled tasks that analyze history, or background processing that updates thread state.

```js
import { getOrCreateThread, compose, scope, model } from "@prsm/ai";

const thread = getOrCreateThread("research-agent");

const step = compose(
  scope(
    {
      system: "you are a research agent. review your previous findings and decide what to investigate next.",
      tools: [searchWeb, readUrl, saveNote],
    },
    model({ model: "openai/gpt-5.2" }),
  ),
);

await thread.generate(step);
```

The agent reviews its history and takes action without needing a user message.

## Accessing thread history directly

```js
const thread = getOrCreateThread("user-123");

const history = await thread.store.get("user-123");
console.log(history);
```

Useful for displaying conversation history in a UI, analytics, and so on.

## Real-world pattern: web app

Complete example with Express and persistent storage.

```js
import express from "express";
import { getOrCreateThread, compose, model, scope } from "@prsm/ai";
import Database from "better-sqlite3";

const app = express();
app.use(express.json());

const db = new Database("threads.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    messages TEXT,
    updated_at INTEGER
  )
`);

const createThread = (id) =>
  getOrCreateThread(id, {
    async get(id) {
      const row = db.prepare("SELECT messages FROM threads WHERE id = ?").get(id);
      return row ? JSON.parse(row.messages) : [];
    },
    async set(id, messages) {
      db.prepare(
        "INSERT OR REPLACE INTO threads (id, messages, updated_at) VALUES (?, ?, ?)",
      ).run(id, JSON.stringify(messages), Date.now());
    },
  });

const workflow = compose(
  scope(
    {
      system: "you are a helpful assistant",
      tools: [calculator, weather],
    },
    model({ model: "openai/gpt-5.2" }),
  ),
);

app.post("/chat/:threadId", async (req, res) => {
  const thread = createThread(req.params.threadId);
  const result = await thread.message(req.body.message, workflow);
  res.json({ response: result.lastResponse.content });
});

app.get("/history/:threadId", async (req, res) => {
  const thread = createThread(req.params.threadId);
  const history = await thread.store.get(req.params.threadId);
  res.json({ history });
});

app.listen(3000);
```

Each user gets their own thread. History persists in SQLite. All messages use the same workflow with tools.

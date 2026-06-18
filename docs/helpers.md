# Helpers

Utility functions for common patterns.

The persistence examples below build a workflow inside a factory that takes a `threadId`, since the context doesn't carry the thread id itself - you close over it where you create the workflow.

## noToolsCalled

Checks if the model called any tools.

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

Runs the model until no tools are called (an agentic loop).

## toolWasCalled

Checks if a specific tool was called in the model's last response.

```js
import { compose, scope, model, when, tap, noToolsCalled, toolWasCalled, Inherit } from "@prsm/ai";

const createSearchLogger = (threadId) =>
  compose(
    scope(
      {
        inherit: Inherit.All,
        tools: [searchWeb],
        until: noToolsCalled(),
      },
      model(),
    ),

    when(
      toolWasCalled("search_web"),
      tap(async (ctx) => {
        const queries = ctx.lastResponse.tool_calls
          .filter((c) => c.function.name === "search_web")
          .map((c) => JSON.parse(c.function.arguments));
        await db.insert("search_log", { thread: threadId, queries, ts: Date.now() });
      }),
    ),
  );
```

Logs every search query the model makes to a database for analytics.

## everyNMessages

Triggers a step every N messages.

```js
import { compose, scope, model, tap, everyNMessages, Inherit } from "@prsm/ai";
import { z } from "zod";

const createNoteTaker = (threadId) =>
  compose(
    everyNMessages(
      20,
      compose(
        scope(
          {
            inherit: Inherit.Conversation,
            system: "extract all action items, decisions, and open questions from this conversation as JSON",
            schema: z.object({
              actionItems: z.array(z.object({ owner: z.string(), task: z.string() })),
              decisions: z.array(z.string()),
              openQuestions: z.array(z.string()),
            }),
            silent: true,
          },
          model(),
        ),
        tap(async (ctx) => {
          await db.upsert("meeting_notes", threadId, JSON.parse(ctx.lastResponse.content));
        }),
      ),
    ),
    model(),
  );
```

Every 20 messages, extracts structured meeting notes from the conversation and persists them, without interrupting the chat. The `silent: true` scope keeps the extraction out of the visible history.

## everyNTokens

Triggers a step based on token count. Since every step receives a `ConversationContext` and returns a new one, you can replace `ctx.history` to compress the conversation.

```js
import { compose, scope, model, everyNTokens, Inherit } from "@prsm/ai";

compose(
  everyNTokens(
    1_000_000,
    compose(
      scope(
        {
          inherit: Inherit.Conversation,
          system: "summarize this entire conversation into a single, dense message. preserve all key facts, decisions, and context.",
          silent: true,
        },
        model(),
      ),
      async (ctx) => ({
        ...ctx,
        history: [{ role: "assistant", content: ctx.lastResponse.content }],
      }),
    ),
  ),
  model(),
);
```

The `silent: true` scope runs the summarization without appending to the outer history. The next step replaces `ctx.history` with just the summary, compressing the whole conversation into one message. Tokens are estimated as length / 4.

## appendToLastRequest

Adds content to the last user message.

```js
import { appendToLastRequest } from "@prsm/ai";

compose(
  appendToLastRequest("\n\nplease remember to always be concise"),
  model(),
);
```

## toolNotUsedInNTurns

Triggers when a tool hasn't been used for N turns.

```js
import { toolNotUsedInNTurns, appendToLastRequest } from "@prsm/ai";

compose(
  toolNotUsedInNTurns(
    { toolName: "search_web", times: 5 },
    appendToLastRequest("\n\nconsider using the search_web tool if needed"),
  ),
  model(),
);
```

Reminds the model about an available tool when it's gone unused.

## Combining helpers

A customer support agent that periodically extracts ticket metadata, uses tools in an agentic loop, and posts to Slack on escalation.

```js
import {
  compose,
  scope,
  model,
  when,
  tap,
  Inherit,
  noToolsCalled,
  everyNMessages,
  toolWasCalled,
} from "@prsm/ai";
import { z } from "zod";

const createSupportAgent = (threadId) =>
  compose(
    everyNMessages(
      10,
      compose(
        scope(
          {
            inherit: Inherit.Conversation,
            system: "extract ticket metadata from this conversation as JSON",
            schema: z.object({
              sentiment: z.enum(["positive", "neutral", "frustrated", "angry"]),
              topics: z.array(z.string()),
              resolved: z.boolean(),
            }),
            silent: true,
          },
          model(),
        ),
        tap(async (ctx) => {
          await db.upsert("tickets", threadId, JSON.parse(ctx.lastResponse.content));
        }),
      ),
    ),

    scope(
      {
        inherit: Inherit.All,
        tools: [orderLookup, knowledgeBase, escalateToHuman],
        until: noToolsCalled(),
      },
      model(),
    ),

    when(
      toolWasCalled("escalate_to_human"),
      tap(async (ctx) => {
        await slack.post("#support-escalations", {
          thread: threadId,
          summary: ctx.lastResponse.content,
        });
      }),
    ),
  );
```

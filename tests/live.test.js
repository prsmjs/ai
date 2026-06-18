import { describe, it, expect } from "vitest";
import { z } from "zod";
import { compose, scope, model, setKeys } from "../src/index.js";

// these tests hit real provider APIs and cost money. they only run when
// AI_LIVE=1 is set (npm run test:live) and the relevant key is present.
const live = process.env.AI_LIVE === "1";

setKeys({
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GEMINI_API_KEY,
  xai: process.env.XAI_API_KEY,
});

const when = (key) => (live && process.env[key] ? it : it.skip);

describe("live inference", () => {
  when("OPENAI_API_KEY")("openai answers a basic prompt", async () => {
    const result = await compose(model({ model: "openai/gpt-4o-mini" }))("Reply with just the word: pong");
    expect(result.lastResponse.content.toLowerCase()).toContain("pong");
  });

  when("ANTHROPIC_API_KEY")("anthropic answers a basic prompt", async () => {
    const result = await compose(model({ model: "anthropic/claude-3-5-haiku-latest" }))(
      "Reply with just the word: pong",
    );
    expect(result.lastResponse.content.toLowerCase()).toContain("pong");
  });

  when("GEMINI_API_KEY")("google answers a basic prompt", async () => {
    const result = await compose(model({ model: "google/gemini-2.0-flash" }))(
      "Reply with just the word: pong",
    );
    expect(result.lastResponse.content.toLowerCase()).toContain("pong");
  });

  when("OPENAI_API_KEY")("openai executes a tool end to end", async () => {
    const add = {
      name: "add",
      description: "add two numbers",
      schema: { a: { type: "number" }, b: { type: "number" } },
      execute: async ({ a, b }) => ({ sum: a + b }),
    };
    const result = await compose(
      scope({ tools: [add] }, model({ model: "openai/gpt-4o-mini" })),
    )("What is 21 plus 21? Use the add tool, then state the number.");
    expect(result.lastResponse.content).toContain("42");
  });

  when("OPENAI_API_KEY")("openai returns structured output matching a zod schema", async () => {
    const result = await compose(
      model({
        model: "openai/gpt-4o-mini",
        schema: z.object({ name: z.string(), age: z.number() }),
      }),
    )("Extract: Ada is 36 years old.");
    const parsed = JSON.parse(result.lastResponse.content);
    expect(parsed.name).toMatch(/ada/i);
    expect(parsed.age).toBe(36);
  });
});

import { describe, it, expect } from "vitest";
import {
  parseModelName,
  message,
  getText,
  addUsage,
  setKeys,
  getKey,
  maxCalls,
  toolConfigToToolDefinition,
} from "../src/index.js";

describe("parseModelName", () => {
  it("splits provider and model on the first slash", () => {
    expect(parseModelName("openai/gpt-5.2")).toEqual({ provider: "openai", model: "gpt-5.2" });
  });

  it("keeps the rest of the path in the model name", () => {
    expect(parseModelName("local/org/model-v2")).toEqual({ provider: "local", model: "org/model-v2" });
  });

  it("treats a bare name (no slash) as a huggingface model", () => {
    expect(parseModelName("distilgpt2")).toEqual({
      provider: "huggingface",
      model: "distilgpt2",
    });
  });
});

describe("message", () => {
  it("returns a plain string content message when no media is attached", () => {
    expect(message("hello")).toEqual({ role: "user", content: "hello" });
  });

  it("builds content parts for images by url and by source", () => {
    const m = message("look", {
      images: ["https://x/y.png", { kind: "base64", mediaType: "image/png", data: "abc" }],
    });
    expect(m.content[0]).toEqual({ type: "text", text: "look" });
    expect(m.content[1]).toEqual({ type: "image", source: { kind: "url", url: "https://x/y.png" } });
    expect(m.content[2].source.data).toBe("abc");
  });

  it("supports documents with filenames and audio clips", () => {
    const m = message("doc", {
      documents: [{ source: { kind: "base64", mediaType: "application/pdf", data: "d" }, filename: "f.pdf" }],
      audio: [{ kind: "base64", mediaType: "audio/wav", data: "a" }],
    });
    const doc = m.content.find((p) => p.type === "document");
    const audio = m.content.find((p) => p.type === "audio");
    expect(doc.filename).toBe("f.pdf");
    expect(audio.source.data).toBe("a");
  });
});

describe("getText", () => {
  it("returns a string as-is", () => {
    expect(getText("plain")).toBe("plain");
  });

  it("concatenates only the text parts", () => {
    expect(
      getText([
        { type: "text", text: "a" },
        { type: "image", source: { kind: "url", url: "u" } },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });
});

describe("addUsage", () => {
  it("starts from zero when there is no prior usage", () => {
    expect(addUsage(undefined, 1, 2, 3, 4)).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      cachedTokens: 4,
      thoughtTokens: 0,
    });
  });

  it("accumulates onto existing usage", () => {
    const a = addUsage(undefined, 10, 5, 15, 2, 4);
    expect(addUsage(a, 1, 1, 2, 1, 2)).toEqual({
      promptTokens: 11,
      completionTokens: 6,
      totalTokens: 17,
      cachedTokens: 3,
      thoughtTokens: 6,
    });
  });
});

describe("keys", () => {
  it("stores and retrieves keys case-insensitively", () => {
    setKeys({ openai: "sk-test" });
    expect(getKey("OpenAI")).toBe("sk-test");
  });

  it("throws for an unconfigured provider", () => {
    expect(() => getKey("nonexistent-provider")).toThrow(/No API key/);
  });
});

describe("maxCalls", () => {
  it("attaches a call limit to a tool config", () => {
    const tool = { name: "t", description: "d", schema: {}, execute: () => {} };
    expect(maxCalls(tool, 3)._maxCalls).toBe(3);
  });
});

describe("toolConfigToToolDefinition", () => {
  it("marks non-optional properties as required", () => {
    const def = toolConfigToToolDefinition({
      name: "search",
      description: "search the web",
      schema: {
        query: { type: "string", description: "the query" },
        limit: { type: "number", optional: true },
      },
      execute: () => {},
    });
    expect(def.function.parameters.required).toEqual(["query"]);
    expect(def.function.parameters.properties.limit.type).toBe("number");
  });

  it("omits the required array when every property is optional", () => {
    const def = toolConfigToToolDefinition({
      name: "t",
      description: "d",
      schema: { a: { type: "string", optional: true } },
      execute: () => {},
    });
    expect(def.function.parameters.required).toBeUndefined();
  });
});

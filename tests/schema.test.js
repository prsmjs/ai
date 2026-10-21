import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  isStandardSchema,
  normalizeSchema,
  convertMCPSchemaToToolSchema,
  toolConfigToToolDefinition,
} from "../src/index.js";

describe("isStandardSchema", () => {
  it("recognizes a zod schema by its ~standard marker", () => {
    expect(isStandardSchema(z.object({ a: z.string() }))).toBe(true);
  });

  it("rejects plain objects and primitives", () => {
    expect(isStandardSchema({ a: { type: "string" } })).toBe(false);
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema("string")).toBe(false);
  });
});

describe("normalizeSchema", () => {
  it("passes a plain JSON schema through untouched", () => {
    const js = { name: "X", schema: { type: "object", properties: {} } };
    expect(normalizeSchema(js)).toBe(js);
  });

  it("converts a zod schema to a named JSON schema", () => {
    const out = normalizeSchema(z.object({ name: z.string(), age: z.number() }), "Person");
    expect(out.name).toBe("Person");
    expect(out.schema.type).toBe("object");
    expect(out.schema.properties.name.type).toBe("string");
  });
});

describe("convertMCPSchemaToToolSchema", () => {
  it("returns empty for a schema with no properties", () => {
    expect(convertMCPSchemaToToolSchema({})).toEqual({});
  });

  it("marks properties not in required as optional", () => {
    const out = convertMCPSchemaToToolSchema({
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(out.a.optional).toBe(false);
    expect(out.b.optional).toBe(true);
  });

  it("recurses into nested object properties", () => {
    const out = convertMCPSchemaToToolSchema({
      properties: { nested: { type: "object", properties: { x: { type: "string" } } } },
      required: [],
    });
    expect(out.nested.properties.x.type).toBe("string");
  });
});

describe("zod tool schemas", () => {
  it("produces an OpenAI tool definition with required fields from a zod schema", () => {
    const def = toolConfigToToolDefinition({
      name: "search",
      description: "search",
      schema: z.object({ query: z.string().describe("q"), limit: z.number().optional() }),
      execute: () => {},
    });
    expect(def.function.parameters.properties.query.type).toBe("string");
    expect(def.function.parameters.required).toContain("query");
    expect(def.function.parameters.required).not.toContain("limit");
  });
});

describe("whole JSON Schemas for tools", () => {
  // as a Python MCP server declares Optional[List[Enum]]
  const mcp = {
    type: "object",
    properties: {
      id: { type: "string" },
      expand: { anyOf: [{ type: "array", items: { type: "string", enum: ["summary", "transcript"] } }, { type: "null" }], default: null },
    },
    required: ["id"],
    additionalProperties: false,
  };

  it("sends a whole schema as it is, so a list-or-null parameter stays one", () => {
    const def = toolConfigToToolDefinition({ name: "get", description: "", schema: mcp, execute: () => {} });
    expect(def.function.parameters).toBe(mcp);
  });

  it("keeps what a zod schema says, optional and nullable included", () => {
    const def = toolConfigToToolDefinition({
      name: "get",
      description: "",
      schema: z.object({ id: z.string(), expand: z.array(z.enum(["summary"])).nullable().optional() }),
      execute: () => {},
    });
    expect(def.function.parameters.$schema).toBeUndefined();
    expect(def.function.parameters.required).toEqual(["id"]);
    expect(JSON.stringify(def.function.parameters.properties.expand)).toContain('"array"');
  });

  it("still builds the property map form", () => {
    const def = toolConfigToToolDefinition({ name: "t", description: "", schema: { type: { type: "string" }, n: { type: "number", optional: true } }, execute: () => {} });
    expect(def.function.parameters).toEqual({ type: "object", properties: { type: { type: "string" }, n: { type: "number" } }, required: ["type"] });
  });
});

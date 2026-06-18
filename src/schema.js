import { createRequire } from "module";

/**
 * @typedef {import("./types.js").JsonSchema} JsonSchema
 * @typedef {import("./types.js").SchemaProperty} SchemaProperty
 * @typedef {import("./types.js").StandardSchema} StandardSchema
 */

const require = createRequire(import.meta.url);

let zodModule;

// zod is an optional peer dependency. consumers almost always already have it
// installed (it's how they build their schemas), so we resolve it lazily from
// their node_modules rather than carrying it as a hard dependency of our own.
const getZod = () => {
  if (zodModule === undefined) {
    try {
      zodModule = require("zod");
    } catch {
      zodModule = null;
    }
  }
  return zodModule;
};

const standardToJsonSchema = (standardSchema) => {
  const zod = getZod();
  if (!zod?.toJSONSchema) {
    throw new Error(
      "A Standard Schema (e.g. a Zod schema) was passed, but zod is not installed. " +
        "Install zod (npm install zod) or pass a plain JSON Schema instead.",
    );
  }
  return zod.toJSONSchema(standardSchema);
};

/**
 * @param {any} schema
 * @returns {schema is StandardSchema}
 */
export const isStandardSchema = (schema) =>
  !!schema && typeof schema === "object" && "~standard" in schema;

/**
 * @param {StandardSchema} standardSchema
 * @param {string} [name]
 * @returns {JsonSchema}
 */
export const convertStandardSchemaToJsonSchema = (standardSchema, name = "Schema") => ({
  name,
  schema: standardToJsonSchema(standardSchema),
});

/**
 * @param {any} mcpSchema
 * @returns {Record<string, SchemaProperty>}
 */
export const convertMCPSchemaToToolSchema = (mcpSchema) => {
  if (!mcpSchema?.properties) return {};

  const convertProperty = (prop) => ({
    type: prop.type || "string",
    description: prop.description || "",
    ...(prop.enum && { enum: prop.enum }),
    ...(prop.items && { items: convertProperty(prop.items) }),
    ...(prop.properties && {
      properties: Object.fromEntries(
        Object.entries(prop.properties).map(([k, v]) => [k, convertProperty(v)]),
      ),
    }),
  });

  const result = {};
  for (const [key, value] of Object.entries(mcpSchema.properties)) {
    result[key] = {
      ...convertProperty(value),
      optional: !mcpSchema.required?.includes(key),
    };
  }
  return result;
};

/**
 * @param {JsonSchema | StandardSchema} schema
 * @param {string} [name]
 * @returns {JsonSchema}
 */
export function normalizeSchema(schema, name) {
  if (isStandardSchema(schema)) {
    return convertStandardSchemaToJsonSchema(schema, name);
  }
  return /** @type {JsonSchema} */ (schema);
}

/**
 * @param {StandardSchema} standardSchema
 * @returns {Record<string, SchemaProperty>}
 */
export const convertStandardSchemaToSchemaProperties = (standardSchema) =>
  convertMCPSchemaToToolSchema(standardToJsonSchema(standardSchema));

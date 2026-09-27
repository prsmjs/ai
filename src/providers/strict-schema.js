const allowsNull = (schema) =>
  schema?.type === "null" ||
  (Array.isArray(schema?.type) && schema.type.includes("null")) ||
  schema?.anyOf?.some(allowsNull) ||
  schema?.oneOf?.some(allowsNull);

const makeNullable = (schema) => allowsNull(schema) ? schema : { anyOf: [schema, { type: "null" }] };

export const toStrictSchema = (schema) => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  const result = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (["properties", "$defs", "definitions"].includes(key)) {
        return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toStrictSchema(child)]))];
      }
      if (["items", "additionalProperties", "not", "if", "then", "else"].includes(key)) {
        return [key, toStrictSchema(value)];
      }
      if (["anyOf", "oneOf", "allOf", "prefixItems"].includes(key)) {
        return [key, value.map(toStrictSchema)];
      }
      return [key, value];
    }),
  );

  if (!result.properties) return result;

  const required = new Set(result.required ?? []);
  result.properties = Object.fromEntries(
    Object.entries(result.properties).map(([name, child]) => [
      name,
      required.has(name) ? child : makeNullable(child),
    ]),
  );
  result.required = Object.keys(result.properties);
  result.additionalProperties = false;
  return result;
};

import { addUsage, getText } from "../utils.js";

/**
 * @typedef {import("../types.js").ConversationContext} ConversationContext
 * @typedef {import("../types.js").Message} Message
 * @typedef {import("../types.js").ProviderConfig} ProviderConfig
 */

const modelCache = new Map();

/**
 * @param {string | undefined} instructions
 * @param {Message[]} history
 */
const formatMessages = (instructions, history) => {
  const messages = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  for (const msg of history) {
    messages.push({ role: msg.role, content: getText(msg.content) });
  }
  return messages;
};

/**
 * local inference via @huggingface/transformers (optional peer dependency)
 *
 * @param {ProviderConfig} config
 * @param {ConversationContext} ctx
 * @returns {Promise<ConversationContext>}
 */
export const callHuggingFace = async (config, ctx) => {
  const { model, instructions, schema } = config;

  const { pipeline } = await import("@huggingface/transformers");

  if (!modelCache.has(model)) {
    modelCache.set(model, await pipeline("text-generation", model, { dtype: "q4" }));
  }

  const generator = modelCache.get(model);
  const messages = formatMessages(instructions, ctx.history);

  if (schema) {
    const schemaInstructions = [
      "you must respond with valid JSON matching this schema:",
      JSON.stringify(schema.schema, null, 2),
      "respond ONLY with the JSON object, no other text.",
    ].join("\n");

    const schemaMsg = messages.find((m) => m.role === "system");
    if (schemaMsg) {
      schemaMsg.content += "\n\n" + schemaInstructions;
    } else {
      messages.unshift({ role: "system", content: schemaInstructions });
    }
  }

  const output = await generator(messages, { max_new_tokens: 2048, do_sample: false });
  const generatedMessages = output[0].generated_text;
  const content = generatedMessages.at(-1)?.content || "";

  /** @type {Message} */
  const msg = { role: "assistant", content };

  ctx.stream?.({ type: "content", content });

  return {
    ...ctx,
    lastResponse: msg,
    history: [...ctx.history, msg],
    usage: addUsage(ctx.usage, 0, 0, 0),
  };
};

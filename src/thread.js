import { model } from "./composition/model.js";

/**
 * @typedef {import("./types.js").Message} Message
 * @typedef {import("./types.js").ConversationContext} ConversationContext
 * @typedef {import("./types.js").StepFunction} StepFunction
 * @typedef {import("./types.js").ThreadStore} ThreadStore
 * @typedef {import("./types.js").Thread} Thread
 */

/**
 * @returns {ThreadStore}
 */
const createMemoryStore = () => {
  /** @type {Map<string, Message[]>} */
  const store = new Map();

  return {
    async get(threadId) {
      return store.get(threadId) || [];
    },
    async set(threadId, messages) {
      store.set(threadId, messages);
    },
  };
};

const emptyContext = (history, abortSignal) => ({
  history,
  tools: [],
  toolExecutors: {},
  toolLimits: {},
  toolCallCounts: {},
  ...(abortSignal && { abortSignal }),
});

/**
 * @param {string} id
 * @param {ThreadStore} store
 * @returns {Thread}
 */
const createThread = (id, store) => ({
  id,
  store,
  async generate(workflow) {
    const history = await store.get(id);
    const finalContext = await workflow(emptyContext(history));
    await store.set(id, finalContext.history);
    return finalContext;
  },
  async message(content, workflow, options) {
    const history = await store.get(id);
    const initialContext = emptyContext(
      [...history, { role: "user", content }],
      options?.abortSignal,
    );

    const finalContext = await (workflow || model())(initialContext);

    if (options?.abortSignal?.aborted) {
      const abortedHistory = [
        ...initialContext.history,
        { role: "assistant", content: "[Response interrupted]" },
      ];
      await store.set(id, abortedHistory);
      return { ...finalContext, history: abortedHistory };
    }

    await store.set(id, finalContext.history);
    return finalContext;
  },
});

/** @type {Map<string, Thread>} */
const defaultThreads = new Map();
/** @type {WeakMap<ThreadStore, Map<string, Thread>>} */
const customThreads = new WeakMap();

/**
 * get or create a thread by id. threads sharing a custom store are cached per
 * store, so the same id with different stores returns distinct threads
 *
 * @example
 * // in-memory (default)
 * const thread = getOrCreateThread("user-123");
 *
 * @example
 * // custom storage
 * const thread = getOrCreateThread("user-123", {
 *   async get(id) {
 *     const row = await db.get("SELECT messages FROM threads WHERE id = ?", id);
 *     return row ? JSON.parse(row.messages) : [];
 *   },
 *   async set(id, messages) {
 *     await db.run(
 *       "INSERT OR REPLACE INTO threads (id, messages) VALUES (?, ?)",
 *       id,
 *       JSON.stringify(messages),
 *     );
 *   },
 * });
 *
 * @param {string} id
 * @param {ThreadStore} [store]
 * @returns {Thread}
 */
export const getOrCreateThread = (id, store) => {
  if (!store) {
    let thread = defaultThreads.get(id);
    if (!thread) {
      thread = createThread(id, createMemoryStore());
      defaultThreads.set(id, thread);
    }
    return thread;
  }

  let byId = customThreads.get(store);
  if (!byId) {
    byId = new Map();
    customThreads.set(store, byId);
  }

  let thread = byId.get(id);
  if (!thread) {
    thread = createThread(id, store);
    byId.set(id, thread);
  }
  return thread;
};

import { EventEmitter } from "events";

/**
 * @typedef {import("./types.js").ToolCall} ToolCall
 */

/**
 * @typedef {object} ApprovalRequest
 * @property {string} id
 * @property {ToolCall} toolCall
 * @property {string} [approvalId]
 */

/**
 * @typedef {object} ApprovalResponse
 * @property {string} id
 * @property {boolean} approved
 * @property {string} [reason]
 */

const state = {
  /** @type {Map<string, (response: ApprovalResponse) => void>} */
  resolvers: new Map(),
  emitter: new EventEmitter(),
};

export const generateApprovalToken = () =>
  `approval_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

/**
 * @param {ToolCall} toolCall
 * @param {string} [approvalId]
 * @returns {Promise<ApprovalResponse>}
 */
export const requestApproval = async (toolCall, approvalId) => {
  const id = generateApprovalToken();
  /** @type {ApprovalRequest} */
  const request = { id, toolCall, approvalId };

  // register the resolver before emitting so a listener that resolves
  // synchronously inside the event handler is not lost
  return new Promise((resolve) => {
    state.resolvers.set(id, resolve);
    state.emitter.emit("approvalRequested", request);
  });
};

/**
 * @param {ApprovalResponse} response
 * @returns {boolean}
 */
export const resolveApproval = (response) => {
  const resolver = state.resolvers.get(response.id);
  if (!resolver) return false;

  state.resolvers.delete(response.id);
  resolver(response);
  state.emitter.emit("approvalResolved", response);
  return true;
};

/**
 * @param {(request: ApprovalRequest) => void} listener
 */
export const onApprovalRequested = (listener) => {
  state.emitter.on("approvalRequested", listener);
};

/**
 * @param {(response: ApprovalResponse) => void} listener
 */
export const onApprovalResolved = (listener) => {
  state.emitter.on("approvalResolved", listener);
};

/**
 * @param {"approvalRequested" | "approvalResolved"} event
 * @param {(...args: any[]) => void} listener
 */
export const removeApprovalListener = (event, listener) => {
  state.emitter.removeListener(event, listener);
};

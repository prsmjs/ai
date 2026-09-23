import { Agent } from "undici";

/**
 * @typedef {object} RequestOptions
 * @property {AbortSignal} [signal] caller's abort; never retried once it fires
 * @property {number} [timeoutMs] whole-request deadline, headers through body. default 10 minutes
 * @property {number} [retries] extra attempts after a retryable failure. default 2
 * @property {number} [backoffMs] first delay; doubles per attempt with jitter. default 500
 */

// node 26's fetch negotiates http/2, and once a connection to a provider is
// open every later request multiplexes onto it. openai streams responses on
// one connection one at a time, so concurrent calls quietly run in series.
// one connection per request is what the providers are built for
const dispatcher = new Agent({ allowH2: false });

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const retryAfterMs = (response) => {
  const h = response?.headers?.get?.("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
};

const backoffFor = (attempt, base, response) =>
  Math.min(MAX_BACKOFF_MS, retryAfterMs(response) ?? base * 2 ** attempt * (0.5 + Math.random()));

// a network-level failure (reset, refused, dns, dropped socket) surfaces from
// fetch as a TypeError, and our own timeout as a TimeoutError. both are worth
// another attempt; the caller's own abort is not
const isRetryableError = (err, callerSignal) => {
  if (callerSignal?.aborted) return false;
  return err?.name === "TypeError" || err?.name === "TimeoutError" || err?.name === "AbortError";
};

/**
 * fetch with a deadline and retry. the returned response has status < 500
 * (or retries are exhausted); callers still check `ok`. only the request is
 * retried - once a body has started streaming to the caller, a drop is theirs
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {RequestOptions} [options]
 * @returns {Promise<Response>}
 */
export const request = async (url, init, options = {}) => {
  const {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
  } = options;

  for (let attempt = 0; ; attempt++) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const attemptSignal = AbortSignal.any(signals);

    let response;
    try {
      response = await fetch(url, { dispatcher, ...init, signal: attemptSignal });
    } catch (err) {
      if (attempt >= retries || !isRetryableError(err, signal)) throw err;
      await sleep(backoffFor(attempt, backoffMs), signal);
      continue;
    }

    if (!RETRYABLE_STATUS.has(response.status) || attempt >= retries) return response;
    const wait = backoffFor(attempt, backoffMs, response);
    await response.body?.cancel?.().catch(() => {});
    await sleep(wait, signal);
  }
};

/**
 * the transport options a provider hands to `request`, read off its config
 * and the conversation's abort signal
 *
 * @param {{ timeoutMs?: number, retries?: number }} config
 * @param {{ abortSignal?: AbortSignal }} ctx
 * @returns {RequestOptions}
 */
export const transportOptions = (config, ctx) => ({
  signal: ctx.abortSignal,
  timeoutMs: config.timeoutMs,
  retries: config.retries,
});

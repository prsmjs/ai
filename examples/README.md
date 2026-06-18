# Examples

Three runnable references. Each is a self-contained project that links the local
`@prsm/ai` build via `file:../..`, so install from inside the example directory.

```bash
cd basic-chat
npm install
OPENAI_API_KEY=sk-... npm run dev
```

## basic-chat

An Express server that streams assistant text and tool-call lifecycle events to
the browser over SSE. Shows that several tool calls can run in a single turn
while streaming, with each `tool_executing` / `tool_complete` event arriving in
order. The browser code in `public/app.js` is a compact reference for consuming
the stream. Runs on http://localhost:3005.

## tool-approval

The same SSE setup, but every tool call pauses for human approval. The server
holds the model on a pending promise, emits a `tool_approval_required` event, and
resolves once the browser approves or rejects. A reference for human-in-the-loop
tool execution over a single stream. Runs on http://localhost:3006.

## code-agent

A terminal coding agent: file read/write/edit, directory listing, glob, grep, and
bash, with approval prompts for destructive tools and Esc to cancel an in-flight
turn. Shows streaming to a TTY, the `until: noToolsCalled()` loop that keeps the
model working until it stops calling tools, and per-tool approval routing.

```bash
cd code-agent
npm install
OPENAI_API_KEY=sk-... npm run dev
```

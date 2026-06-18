import { getOrCreateThread, model, compose, scope, setKeys, Inherit } from "@prsm/ai";
import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));

setKeys({
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GEMINI_API_KEY,
  xai: process.env.XAI_API_KEY,
});

// approvals resolved out-of-band: the model pauses on a tool call, the browser
// approves or rejects, and the server resolves the pending promise.
const pendingApprovals = new Map();

const weatherTool = {
  name: "get_weather",
  description: "Get current weather for a city",
  schema: z.object({ city: z.string().describe("City name to get weather for") }),
  execute: async ({ city }) => {
    try {
      const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
      const data = await response.json();
      const current = data.current_condition[0];
      return { city, temperature: `${current.temp_C}C`, description: current.weatherDesc[0].value };
    } catch {
      return { error: `Could not fetch weather for ${city}` };
    }
  },
};

const writeSSE = (res) => (event) => {
  const frame = {
    content: () => ({ type: "content", content: event.content }),
    tool_executing: () => ({ type: "tool_executing", name: event.call.function.name }),
    tool_complete: () => ({ type: "tool_complete", name: event.call.function.name, result: event.result }),
    tool_error: () => ({ type: "tool_error", name: event.call.function.name, error: event.error }),
  }[event.type];

  if (frame) res.write(`data: ${JSON.stringify(frame())}\n\n`);
};

const chat = async (req, res) => {
  const { threadId } = req.params;
  const { message } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const thread = getOrCreateThread(threadId);

  const approvalCallback = (toolCall) =>
    new Promise((resolve) => {
      const approvalId = `${threadId}-${toolCall.id}`;
      pendingApprovals.set(approvalId, resolve);
      res.write(`data: ${JSON.stringify({ type: "tool_approval_required", call: toolCall, approvalId })}\n\n`);
    });

  const workflow = compose(
    scope(
      {
        inherit: Inherit.All,
        system: "You are a helpful assistant. Reply in plain, unformatted text.",
        tools: [weatherTool],
        toolConfig: { parallel: true, requireApproval: true, approvalCallback },
        stream: writeSSE(res),
      },
      model({ model: "openai/gpt-5.2" }),
    ),
  );

  try {
    await thread.message(message, workflow);
    res.write(`data: ${JSON.stringify({ type: "complete" })}\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: "error", message: error.message })}\n\n`);
  } finally {
    res.end();
  }
};

const approve = (req, res) => {
  const resolve = pendingApprovals.get(req.params.approvalId);
  if (!resolve) return res.status(404).json({ error: "Approval not found" });
  pendingApprovals.delete(req.params.approvalId);
  resolve(req.body.approved);
  res.json({ success: true });
};

const app = express();
app.use(express.json());
app.post("/chat/:threadId", chat);
app.post("/approve/:approvalId", approve);
app.use(express.static(path.join(here, "public")));

app.listen(3006, () => console.log("http://localhost:3006"));

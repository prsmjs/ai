import { getOrCreateThread, model, compose, scope, setKeys, Inherit } from "@prsm/ai";
import express from "express";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));

setKeys({ openai: process.env.OPENAI_API_KEY });

const weatherTool = {
  name: "get_weather",
  description: "Get current weather for a city",
  schema: {
    city: { type: "string", description: "City name to get weather for" },
  },
  execute: async ({ city }) => {
    try {
      const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
      const data = await response.json();
      const current = data.current_condition[0];
      return {
        city,
        temperature: `${current.temp_C}C (${current.temp_F}F)`,
        description: current.weatherDesc[0].value,
        humidity: `${current.humidity}%`,
        windSpeed: `${current.windspeedKmph} km/h`,
      };
    } catch {
      return { error: `Could not fetch weather for ${city}` };
    }
  },
};

// translate the library's stream events into SSE frames the browser reads.
// this is the part worth studying: even with streaming on and several tool
// calls in one turn, each lifecycle event arrives in order.
const writeSSE = (res) => (event) => {
  const frame = {
    content: () => ({ type: "content", content: event.content }),
    tool_calls_ready: () => ({ type: "tool_calls_ready", count: event.calls.length }),
    tool_executing: () => ({
      type: "tool_executing",
      name: event.call.function.name,
      arguments: event.call.function.arguments,
    }),
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

  const workflow = compose(
    scope(
      {
        inherit: Inherit.All,
        system: "You are a helpful assistant. Reply in plain, unformatted text.",
        tools: [weatherTool],
        toolConfig: { parallel: true },
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

const app = express();
app.use(express.json());
app.post("/chat/:threadId", chat);
app.use(express.static(path.join(here, "public")));

app.listen(3005, () => console.log("http://localhost:3005"));

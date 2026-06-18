# Multimodal Input

Send images, PDFs, and audio alongside text in user messages. Each provider has a different wire format; `@prsm/ai` normalizes these into a single `ContentPart` vocabulary and translates per provider.

## The `message()` helper

The easiest way to build a multimodal user message.

```js
import { compose, model, message } from "@prsm/ai";
import { readFileSync } from "fs";

const png = readFileSync("chart.png").toString("base64");

const userMessage = message("What's in this chart?", {
  images: [{ kind: "base64", mediaType: "image/png", data: png }],
});

const result = await compose(model({ model: "openai/gpt-5.2" }))({
  history: [userMessage],
});
```

`message()` returns a `Message` whose `content` is a `ContentPart[]`. Drop it directly into `ctx.history`.

### Image from URL

```js
const userMessage = message("Describe this photo.", {
  images: ["https://example.com/photo.jpg"],
});
```

A bare string in the `images` array is treated as a URL. Pass `{ kind, mediaType, data }` for base64.

### Multiple images

```js
const userMessage = message("Compare these three charts.", {
  images: [
    { kind: "base64", mediaType: "image/png", data: pngA },
    { kind: "base64", mediaType: "image/png", data: pngB },
    "https://example.com/chart-c.png",
  ],
});
```

### PDF documents

```js
const pdf = readFileSync("report.pdf").toString("base64");

const userMessage = message("Summarize this report.", {
  documents: [
    {
      source: { kind: "base64", mediaType: "application/pdf", data: pdf },
      filename: "report.pdf",
    },
  ],
});
```

`filename` is optional but useful - OpenAI in particular uses it as a display hint when the assistant references the file.

### Audio

```js
const wav = readFileSync("clip.wav").toString("base64");

const userMessage = message("Transcribe this clip.", {
  audio: [{ kind: "base64", mediaType: "audio/wav", data: wav }],
});
```

Audio input is only supported on audio-capable models (see the capability matrix below).

## Content parts directly

For finer control, build the `ContentPart[]` yourself instead of using `message()`.

```js
const userMessage = {
  role: "user",
  content: [
    { type: "text", text: "What's in this image?" },
    { type: "image", source: { kind: "base64", mediaType: "image/png", data: png } },
  ],
};
```

The four part types and the two source kinds:

```ts
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: MediaSource }
  | { type: "document"; source: MediaSource; filename?: string }
  | { type: "audio"; source: MediaSource };

type MediaSource =
  | { kind: "base64"; mediaType: string; data: string }
  | { kind: "url"; url: string };
```

A message may contain any mix of text and media parts in any order. Assistant replies always come back as plain string content on the chat endpoints.

## Provider capability matrix

| Part     | OpenAI | Anthropic | Google | xAI | Local |
|----------|--------|-----------|--------|-----|-------|
| image    | vision models | all models | all models | grok vision models | vision models (llava, etc.) |
| document | vision models (base64 PDF) | all models | all models | not supported | not supported |
| audio    | audio-preview models | not supported | all models | not supported | not supported |

Unsupported combinations throw a clear error at the adapter boundary rather than silently dropping content. If you attach audio to a non-audio provider, the call raises instead of the model receiving only the text.

### Source kind compatibility

- **Images**: base64 and URL accepted on OpenAI, Anthropic, and xAI. Google accepts base64 directly and routes `kind: "url"` through its Files API (`file_data.file_uri`) - plain public URLs are not fetched by the Gemini server and should be uploaded first.
- **Documents**: base64 works everywhere that supports documents. URL works on Anthropic (native) and Google (Files API). OpenAI requires base64 - for large PDFs, upload via the Files API and reference by `file_id` in a text message.
- **Audio**: base64 only, and only on providers in the matrix above.

## Running the same prompt across providers

Because the adapter layer hides the wire-format differences, the same `ContentPart[]` works across every multimodal provider.

```js
import { compose, model, message } from "@prsm/ai";

const userMessage = message("What color is this?", {
  images: [{ kind: "base64", mediaType: "image/png", data: png }],
});

const providers = [
  "openai/gpt-5.2",
  "anthropic/claude-sonnet-4-5",
  "google/gemini-2.5-flash",
];

for (const provider of providers) {
  const result = await compose(model({ model: provider }))({ history: [userMessage] });
  console.log(provider, "->", result.lastResponse?.content);
}
```

## PDF example

```js
import { compose, model, message } from "@prsm/ai";
import { readFileSync } from "fs";

const pdf = readFileSync("invoice.pdf").toString("base64");

const result = await compose(model({ model: "openai/gpt-5.2" }))({
  history: [
    message("Extract the line items from this invoice as JSON.", {
      documents: [
        {
          source: { kind: "base64", mediaType: "application/pdf", data: pdf },
          filename: "invoice.pdf",
        },
      ],
    }),
  ],
});

console.log(result.lastResponse?.content);
```

Works identically against `google/gemini-2.5-flash` or `anthropic/claude-sonnet-4-5`.

## Audio example

```js
import { compose, model, message } from "@prsm/ai";
import { readFileSync } from "fs";

const wav = readFileSync("meeting.wav").toString("base64");

const result = await compose(model({ model: "openai/gpt-4o-audio-preview" }))({
  history: [
    message("Transcribe this meeting and list the action items.", {
      audio: [{ kind: "base64", mediaType: "audio/wav", data: wav }],
    }),
  ],
});
```

When a message contains audio, the OpenAI adapter automatically adds `modalities: ["text"]` to the request body. Without that, the audio models refuse to describe the input. OpenAI accepts `audio/wav` and `audio/mp3`; Gemini also accepts `audio/mpeg`, `audio/aiff`, `audio/aac`, `audio/ogg`, and `audio/flac`.

## Mixing media and tools

Multimodal input composes with tool execution the same way text does.

```js
import { compose, scope, model, message } from "@prsm/ai";

const saveNote = {
  name: "save_note",
  description: "Save a note to the database",
  schema: { text: { type: "string", description: "The note content" } },
  execute: async ({ text }) => ({ ok: true, text }),
};

const result = await compose(
  scope({ tools: [saveNote] }, model({ model: "openai/gpt-5.2" })),
)({
  history: [
    message("Read the sticky note in this photo, then save it.", {
      images: [{ kind: "base64", mediaType: "image/jpeg", data: jpeg }],
    }),
  ],
});
```

## Threads

`thread.message()` takes a string, so to push a pre-built multimodal message into history use `thread.generate()`.

```js
import { getOrCreateThread, compose, model, message } from "@prsm/ai";

const thread = getOrCreateThread("user-42");

await thread.generate(async (ctx) => ({
  ...ctx,
  history: [
    ...ctx.history,
    message("What's in this chart?", {
      images: [{ kind: "base64", mediaType: "image/png", data: png }],
    }),
  ],
}));

await thread.generate(compose(model({ model: "openai/gpt-5.2" })));
```

The `ContentPart[]` survives JSON serialization cleanly, so it persists through the thread's store.

## Error handling

Unsupported combinations throw at call time, not later.

```js
try {
  await compose(model({ model: "xai/grok-4" }))({
    history: [
      message("What does this say?", {
        documents: [{ source: { kind: "base64", mediaType: "application/pdf", data: pdf } }],
      }),
    ],
  });
} catch (err) {
  // "xAI does not support document/PDF input on the chat completions API"
}
```

Catch at the composition boundary and retry against a provider that supports the media type.

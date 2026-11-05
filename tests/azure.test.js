import { describe, it, expect, afterEach, vi } from "vitest";
import { compose, model, setKeys } from "../src/index.js";
import { openaiResponse, mockFetchSequence } from "./util.js";

const BASE = "https://my-resource.openai.azure.com/openai/v1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setKeys({ azure: undefined });
});

const clearEnv = () => {
  vi.stubEnv("AZURE_OPENAI_API_KEY", "");
  vi.stubEnv("AZURE_OPENAI_BASE_URL", "");
  vi.stubEnv("AZURE_OPENAI_ENDPOINT", "");
};

describe("azure provider", () => {
  it("posts to the resource's Responses endpoint with the deployment as model and an api-key header", async () => {
    clearEnv();
    const calls = mockFetchSequence([openaiResponse({ content: "hi" })]);
    const result = await compose(model({ model: "azure/my-gpt-deployment", baseUrl: `${BASE}/`, apiKey: "az-key", effort: "high" }))("hello");
    expect(calls[0].url).toBe(`${BASE}/responses`);
    expect(calls[0].body.model).toBe("my-gpt-deployment");
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(calls[0].init.headers["api-key"]).toBe("az-key");
    expect(calls[0].init.headers).not.toHaveProperty("Authorization");
    expect(result.lastResponse.content).toBe("hi");
  });

  it("uses an Entra ID bearer token from headers instead of an api key", async () => {
    clearEnv();
    vi.stubEnv("AZURE_OPENAI_API_KEY", "env-key");
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(model({ model: "azure/d", baseUrl: BASE, headers: { Authorization: "Bearer entra-token", "x-ms-client-request-id": "abc" } }))("hi");
    expect(calls[0].init.headers.Authorization).toBe("Bearer entra-token");
    expect(calls[0].init.headers["x-ms-client-request-id"]).toBe("abc");
    expect(calls[0].init.headers).not.toHaveProperty("api-key");
  });

  it("resolves the key from setKeys and the URL from AZURE_OPENAI_ENDPOINT", async () => {
    clearEnv();
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://my-resource.openai.azure.com/");
    setKeys({ azure: "set-key" });
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(model({ model: "azure/d" }))("hi");
    expect(calls[0].url).toBe(`${BASE}/responses`);
    expect(calls[0].init.headers["api-key"]).toBe("set-key");
  });

  it("prefers AZURE_OPENAI_BASE_URL and AZURE_OPENAI_API_KEY from the environment", async () => {
    clearEnv();
    vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://proxy.example.com/openai/v1");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://ignored.openai.azure.com");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "env-key");
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(model({ model: "azure/d" }))("hi");
    expect(calls[0].url).toBe("https://proxy.example.com/openai/v1/responses");
    expect(calls[0].init.headers["api-key"]).toBe("env-key");
  });

  it("fails clearly without an endpoint or credentials", async () => {
    clearEnv();
    mockFetchSequence([openaiResponse({ content: "never" })]);
    await expect(compose(model({ model: "azure/d", apiKey: "k" }))("hi")).rejects.toThrow(/baseUrl/);
    await expect(compose(model({ model: "azure/d", baseUrl: BASE }))("hi")).rejects.toThrow(/API key/);
  });

  it("labels API errors as Azure OpenAI", async () => {
    clearEnv();
    mockFetchSequence([new Response("DeploymentNotFound", { status: 404 })]);
    await expect(compose(model({ model: "azure/d", baseUrl: BASE, apiKey: "k" }))("hi")).rejects.toThrow("Azure OpenAI API error: 404 DeploymentNotFound");
  });

  it("does not double /openai/v1 when AZURE_OPENAI_ENDPOINT already includes it", async () => {
    clearEnv();
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", `${BASE}/`);
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(model({ model: "azure/d", apiKey: "k" }))("hi");
    expect(calls[0].url).toBe(`${BASE}/responses`);
  });

  it("keeps a query string such as api-version after the /responses path", async () => {
    clearEnv();
    const calls = mockFetchSequence([openaiResponse({ content: "a" }), openaiResponse({ content: "b" })]);
    await compose(model({ model: "azure/d", apiKey: "k", baseUrl: `${BASE}/?api-version=preview` }))("hi");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://my-resource.openai.azure.com?api-version=preview");
    await compose(model({ model: "azure/d", apiKey: "k" }))("hi");
    expect(calls[0].url).toBe(`${BASE}/responses?api-version=preview`);
    expect(calls[1].url).toBe(`${BASE}/responses?api-version=preview`);
  });

  it("rejects a base url that is not a valid URL", async () => {
    clearEnv();
    mockFetchSequence([openaiResponse({ content: "never" })]);
    await expect(compose(model({ model: "azure/d", apiKey: "k", baseUrl: "my-resource.openai.azure.com" }))("hi")).rejects.toThrow(/baseUrl is not a valid URL/);
  });

  it("accepts an api-key passed in headers, in any case, without a configured key", async () => {
    clearEnv();
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(model({ model: "azure/d", baseUrl: BASE, headers: { "Api-Key": "hdr-key" } }))("hi");
    expect(calls[0].init.headers).toEqual(expect.objectContaining({ "Api-Key": "hdr-key" }));
    expect(Object.keys(calls[0].init.headers).filter((h) => h.toLowerCase() === "api-key")).toHaveLength(1);
  });

  it("lets a header api-key replace an ambient key instead of sending both", async () => {
    clearEnv();
    vi.stubEnv("AZURE_OPENAI_API_KEY", "env-key");
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(model({ model: "azure/d", baseUrl: BASE, headers: { "API-KEY": "hdr-key" } }))("hi");
    const sent = Object.entries(calls[0].init.headers).filter(([h]) => h.toLowerCase() === "api-key");
    expect(sent).toEqual([["API-KEY", "hdr-key"]]);
  });

  it("falls back to the configured key when the Authorization header is empty or undefined", async () => {
    clearEnv();
    vi.stubEnv("AZURE_OPENAI_API_KEY", "env-key");
    const calls = mockFetchSequence([openaiResponse({ content: "a" }), openaiResponse({ content: "b" })]);
    await compose(model({ model: "azure/d", baseUrl: BASE, headers: { Authorization: undefined } }))("hi");
    await compose(model({ model: "azure/d", baseUrl: BASE, headers: { Authorization: "" } }))("hi");
    for (const call of calls) expect(call.init.headers["api-key"]).toBe("env-key");
    expect(calls[0].init.headers).not.toHaveProperty("Authorization");
  });

  it("always sends an explicit apiKey, even alongside a bearer token", async () => {
    clearEnv();
    const calls = mockFetchSequence([openaiResponse({ content: "ok" })]);
    await compose(model({ model: "azure/d", baseUrl: BASE, apiKey: "explicit", headers: { Authorization: "Bearer gateway" } }))("hi");
    expect(calls[0].init.headers["api-key"]).toBe("explicit");
    expect(calls[0].init.headers.Authorization).toBe("Bearer gateway");
  });
});

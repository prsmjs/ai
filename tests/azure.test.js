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
    await expect(compose(model({ model: "azure/d", baseUrl: BASE, apiKey: "k" }))("hi")).rejects.toThrow("Azure OpenAI API error: DeploymentNotFound");
  });
});

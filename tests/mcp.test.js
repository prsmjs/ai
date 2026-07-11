import { describe, it, expect } from "vitest";
import { namespaced } from "../src/mcp.js";

describe("mcp tool namespacing", () => {
  it("prefixes bare tool names with the server name", () => {
    expect(namespaced("github", "search")).toBe("github_search");
    expect(namespaced("lore", "learn")).toBe("lore_learn");
  });

  it("keeps names that already carry the server prefix", () => {
    expect(namespaced("lore", "lore_search")).toBe("lore_search");
    expect(namespaced("lore", "lore-search")).toBe("lore-search");
  });

  it("matches the existing prefix case-insensitively", () => {
    expect(namespaced("Lore", "lore_search")).toBe("lore_search");
    expect(namespaced("lore", "Lore_Search")).toBe("Lore_Search");
  });

  it("does not treat a mere name match as a prefix", () => {
    expect(namespaced("lore", "lore")).toBe("lore_lore");
    expect(namespaced("lore", "lorekeeper_run")).toBe("lore_lorekeeper_run");
  });
});

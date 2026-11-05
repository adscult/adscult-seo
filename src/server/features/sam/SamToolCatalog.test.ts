import { expect, it } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { SamToolCatalog } from "./SamToolCatalog";

const definition = tool({
  description: "Fixture read",
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});
const tools: ToolSet = Object.fromEntries(
  [
    "get_project_context",
    "get_search_console_performance",
    "get_google_analytics_organic_overview",
    "read_tool_result",
    "list_saved_keywords",
    "create_report",
  ].map((name) => [name, definition]),
);

it("loads only requested specialists and resets loading for the next turn", async () => {
  const catalog = new SamToolCatalog(tools);
  expect(catalog.activeTools).toEqual([
    "get_project_context",
    "get_search_console_performance",
    "get_google_analytics_organic_overview",
    "read_tool_result",
    "load_tools",
  ]);
  expect(catalog.canExecute("create_report")).toBe(false);
  await catalog.tools.load_tools.execute?.(
    { names: ["list_saved_keywords"] },
    { toolCallId: "load", messages: [] },
  );
  expect(catalog.canExecute("list_saved_keywords")).toBe(true);
  expect(catalog.canExecute("create_report")).toBe(false);
  expect(new SamToolCatalog(tools).canExecute("list_saved_keywords")).toBe(
    false,
  );
});

it("cannot load framework or arbitrary tools outside the server allowlist", async () => {
  const catalog = new SamToolCatalog(tools);
  // Even a forged direct call that bypasses SDK schema validation cannot
  // introduce implementations that aren't in the server's tool map.
  await catalog.tools.load_tools.execute?.(
    { names: ["write", "delete_report", "constructor"] },
    { toolCallId: "forged", messages: [] },
  );
  for (const name of ["write", "delete_report", "constructor"]) {
    expect(catalog.activeTools).not.toContain(name);
    expect(catalog.canExecute(name)).toBe(false);
  }
});

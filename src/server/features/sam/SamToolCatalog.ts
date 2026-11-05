import { tool, type ToolSet } from "ai";
import { z } from "zod";

const CORE_TOOLS = [
  "get_project_context",
  "get_search_console_performance",
  "get_google_analytics_organic_overview",
  "read_tool_result",
];

// Reset per turn. Loading schemas grants no additional project permissions:
// tools is already the server's connected-data allowlist.
export class SamToolCatalog {
  readonly tools: ToolSet;
  private readonly active = new Set(CORE_TOOLS);

  constructor(tools: ToolSet) {
    const names = Object.keys(tools);
    const catalog = Object.entries(tools)
      .filter(([name]) => !this.active.has(name))
      .map(
        ([name, definition]) =>
          `${name}: ${(definition.description ?? "").split("\n")[0].slice(0, 160)}`,
      )
      .join("\n");
    this.active.add("load_tools");
    this.tools = {
      ...tools,
      load_tools: tool({
        description: `Load specialist tools by exact name before calling them. Their full schemas become available on the next step. Available specialists:\n${catalog}`,
        inputSchema: z.object({ names: z.array(z.enum(names)).min(1).max(6) }),
        execute: async (input) => {
          for (const name of input.names) this.active.add(name);
          return {
            loaded: input.names,
            note: "These tools are now available. Call them with the parameters in their schemas.",
          };
        },
      }),
    };
  }

  get activeTools() {
    return [...this.active].filter((name) => Object.hasOwn(this.tools, name));
  }
  canExecute(name: string) {
    return this.active.has(name) && Object.hasOwn(this.tools, name);
  }
}

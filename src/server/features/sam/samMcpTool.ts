import { tool, type Tool } from "ai";
import { z, type ZodRawShape } from "zod";
import { withPgClient } from "@/db";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolContext } from "@/server/mcp/context";
import { instrumentMcpToolHandler } from "@/server/mcp/instrumentation";
import { capToolOutput } from "./samToolOutput";
import {
  previewSamToolOutput,
  samConnectedInputSchema,
} from "./samToolContext";
import { resolveSamToolRole } from "./samToolAuth";

// Shape of the MCP tool objects exported from src/server/mcp/tools/*. SAM reuses
// the exact same definitions the MCP server registers, so the in-app agent and
// the MCP server can never drift in what a tool does or how it bills.
export type McpToolDefinition<Shape extends ZodRawShape> = {
  name: string;
  config: { description: string; inputSchema: Shape };
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    context: ToolContext,
  ) => Promise<CallToolResult>;
};

// Flatten an MCP CallToolResult into a plain value for the model. The text
// block renders the same rows the structured data carries (see
// tool-text-output.test.ts), so when both exist only the head of the text
// survives — the title line and any caveat, not a second copy of every row.
// A tool result is re-sent on every step of its turn and persisted in the
// transcript, so the duplicate would cost twice everywhere.
const SUMMARY_HEAD_CHARS = 300;

export function toModelOutput(result: CallToolResult): {
  summary: string;
  data?: CallToolResult["structuredContent"];
} {
  const text = (result.content ?? [])
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  const data = result.structuredContent;
  // A text-only response still gets a `{ meta }` structuredContent when it
  // carries a deep link; that is not a second copy of the text.
  const dataHasRows =
    data != null && Object.keys(data).some((key) => key !== "meta");
  if (!dataHasRows) return data ? { summary: text, data } : { summary: text };
  const summary =
    text.length > SUMMARY_HEAD_CHARS
      ? `${text.slice(0, SUMMARY_HEAD_CHARS)}… (full rows in data)`
      : text;
  return { summary, data };
}

// Adapt one OpenSEO tool into an AI SDK tool. The shared handler receives the
// same explicit auth context as the MCP transport, and runs through the same
// instrumentation wrapper, so project scoping, credit metering, and the
// mcp:tool_call telemetry (source "in_app_agent", null clientId) all match the
// external MCP path.
//
// SAM always runs inside one project (the session row), so we bind that project
// server-side: any tool with a `projectId` input has it stripped from the schema
// the model sees and injected at call time. The model never has to know or pass
// the id, can't target another project, and can't hallucinate a wrong one.
export function adaptSamMcpTool<Shape extends ZodRawShape>(
  def: McpToolDefinition<Shape>,
  context: ToolContext,
  projectId: string,
  connected = false,
): Tool {
  const { projectId: _projectIdSchema, ...modelShape } = def.config.inputSchema;
  const bindsProject = "projectId" in def.config.inputSchema;
  const shape = {
    ...(bindsProject ? modelShape : def.config.inputSchema),
  };
  const handler = instrumentMcpToolHandler(def.name, undefined, def.handler);

  return tool({
    description: def.config.description,
    inputSchema: connected
      ? samConnectedInputSchema(shape, def.name)
      : z.object(shape),
    ...(connected
      ? {
          toModelOutput: ({
            output,
            toolCallId,
          }: {
            output: unknown;
            toolCallId: string;
          }) => ({
            type: "json" as const,
            value: previewSamToolOutput(output, { toolCallId }),
          }),
        }
      : {}),
    execute: async (args) => {
      // Reconstruct the handler's validated arg shape by injecting the session
      // projectId that we stripped from the model-facing schema above.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- projectId re-added to rebuild the tool's Shape; the handler re-validates project access
      const fullArgs = (bindsProject
        ? { ...args, projectId }
        : args) as unknown as z.infer<z.ZodObject<Shape>>;
      try {
        const role = await withPgClient(() => resolveSamToolRole(context.auth));
        if (!role)
          return { error: "You no longer have access to this organization." };
        // Tool calls run inside Think's inference loop, outside any ambient
        // request scope, so each execution scopes its own Postgres client
        // (no-op in D1 mode) — same rule as the DO's other DB-touching seams.
        const output = toModelOutput(
          await withPgClient(() =>
            handler(fullArgs, {
              ...context,
              auth: { ...context.auth, role },
            }),
          ),
        );
        // Connected reads have bounded source pages; preserve each complete
        // page in the transcript so preview offsets cannot skip hidden rows.
        return connected && ("limit" in shape || "rowLimit" in shape)
          ? output
          : capToolOutput(output);
      } catch (error) {
        // Surface the failure to the model so it can recover or report it,
        // rather than aborting the whole turn on one bad tool call.
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

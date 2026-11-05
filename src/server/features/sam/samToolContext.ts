import { z } from "zod";
import { tool, type Tool, type UIMessage } from "ai";
import type { SessionMessage } from "@cloudflare/think";
import type { ZodRawShape } from "zod";

const ROW_KEYS = new Set([
  "rows",
  "trend",
  "keywords",
  "pages",
  "results",
  "data",
]);
const refSchema = z.object({
  toolCallId: z.string(),
  messageId: z.string().optional(),
});
type Reference = z.infer<typeof refSchema>;
type Json = z.infer<ReturnType<typeof z.json>>;

export function samConnectedInputSchema(shape: ZodRawShape, name: string) {
  return z.object({
    ...shape,
    ...("limit" in shape
      ? {
          limit:
            name === "list_saved_keywords"
              ? z
                  .literal(50)
                  .default(50)
                  .describe(
                    "50 rows per source page; use page to retrieve more with identical filters/sort.",
                  )
              : z
                  .number()
                  .int()
                  .min(1)
                  .max(50)
                  .default(20)
                  .describe(
                    "Rows per source page. Use offset for additional rows; totals cover the documented source scope.",
                  ),
        }
      : {}),
    ...("rowLimit" in shape
      ? {
          rowLimit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(50)
            .describe(
              "Rows per source page; use startRow for additional rows. Monthly aggregation still fetches the complete daily window server-side.",
            ),
        }
      : {}),
    ...(name === "list_saved_keywords" && shape.sort instanceof z.ZodType
      ? { sort: shape.sort.default("searchVolume") }
      : {}),
    ...(name === "get_google_analytics_organic_overview" &&
    shape.trend instanceof z.ZodType
      ? { trend: shape.trend.default("weekly") }
      : {}),
  });
}

// Model-only projection. The transcript keeps the original result, including
// its exact totals, request, source, pagination, warnings and report links.
export function previewSamToolOutput(
  output: unknown,
  reference: Reference,
  rowLimit = 20,
) {
  const omitted: Array<{
    path: string;
    shown: number;
    available: number;
    unit: string;
  }> = [];
  const visit = (value: Json, path: string): Json => {
    if (Array.isArray(value))
      return value.map((item, index) => visit(item, `${path}[${index}]`));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const itemPath = path ? `${path}.${key}` : key;
        if (
          ROW_KEYS.has(key) &&
          Array.isArray(item) &&
          item.length > rowLimit
        ) {
          omitted.push({
            path: itemPath,
            shown: rowLimit,
            available: item.length,
            unit: "rows",
          });
          return [
            key,
            item
              .slice(0, rowLimit)
              .map((row, index) => visit(row, `${itemPath}[${index}]`)),
          ];
        }
        if (key === "html" && typeof item === "string" && item.length > 1000) {
          omitted.push({
            path: itemPath,
            shown: 1000,
            available: item.length,
            unit: "chars",
          });
          return [key, item.slice(0, 1000)];
        }
        return [key, visit(item, itemPath)];
      }),
    );
  };
  // Tool results are JSON at this boundary, as required by the AI SDK. Strip
  // undefined optional fields using the same JSON representation as transport.
  const value = visit(
    z.json().parse(JSON.parse(JSON.stringify(output ?? null))),
    "",
  );
  if (!omitted.length) return value;
  return {
    result: value,
    contextPreview: {
      ...reference,
      omitted,
      note: "Preview only. Counts/totals describe the original source result, not the visible rows. Use read_tool_result with this reference and a path/offset to read omitted detail. Use the source tool's pagination for further source pages; do not sum preview rows as population totals.",
    },
  };
}

export function compactSamHistory(messages: UIMessage[]): UIMessage[];
export function compactSamHistory(messages: SessionMessage[]): SessionMessage[];
export function compactSamHistory(
  messages: SessionMessage[],
): SessionMessage[] {
  const currentTurn = messages
    .map((message) => message.role)
    .lastIndexOf("user");
  return messages.map((message, index) =>
    index >= currentTurn
      ? message
      : {
          ...message,
          parts: message.parts.map((part) => {
            if (
              !(
                part.type.startsWith("tool-") || part.type === "dynamic-tool"
              ) ||
              !("output" in part) ||
              typeof part.toolCallId !== "string"
            )
              return part;
            const input = part.input;
            const omitReportHtml =
              (part.type === "tool-create_report" ||
                part.toolName === "create_report") &&
              input !== null &&
              typeof input === "object" &&
              "html" in input &&
              typeof input.html === "string" &&
              input.html.length > 1000;
            return {
              ...part,
              ...(omitReportHtml
                ? {
                    input: {
                      ...input,
                      html: "[Earlier report HTML omitted from model context. The complete report remains at the private URL in this tool result.]",
                    },
                  }
                : {}),
              output: previewSamToolOutput(
                part.output,
                { messageId: message.id, toolCallId: part.toolCallId },
                3,
              ),
            };
          }),
        },
  );
}

const readSchema = z.object({
  ...refSchema.shape,
  path: z
    .string()
    .regex(/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/)
    .describe(
      "The omitted path returned in contextPreview, e.g. data.rows or data.comparison.rows.",
    ),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
});

export function buildSamHistoryTool(
  readResult: (reference: Reference) => Promise<unknown>,
): Tool {
  return tool({
    description:
      "Read a page of an earlier tool result in this conversation using its contextPreview reference. Reads the saved snapshot, without calling a connector. Rows use offset/limit; HTML uses offset and up to limit*200 characters. Report links remain in the preview.",
    inputSchema: readSchema,
    execute: async (input) => {
      let value: unknown = await readResult(input);
      if (value === undefined)
        return {
          error:
            "This saved tool result was not found in this conversation. Rerun the original read if needed.",
        };
      for (const key of input.path.split(".")) {
        if (key === "__proto__" || key === "constructor" || key === "prototype")
          return { error: "Invalid result path." };
        value =
          value !== null &&
          typeof value === "object" &&
          Object.hasOwn(value, key)
            ? Reflect.get(value, key)
            : undefined;
      }
      if (!Array.isArray(value) && typeof value !== "string")
        return {
          error: "Choose an omitted array or HTML path from contextPreview.",
        };
      const end =
        input.offset +
        (typeof value === "string" ? input.limit * 200 : input.limit);
      return {
        path: input.path,
        offset: input.offset,
        available: value.length,
        nextOffset: end < value.length ? end : null,
        data: value.slice(input.offset, end),
        note: "This page belongs to the saved result; it is not a new connector query or a whole-population total.",
      };
    },
  });
}

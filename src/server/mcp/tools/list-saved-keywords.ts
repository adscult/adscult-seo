import { z } from "zod";
import { KeywordResearchService } from "@/server/features/keywords/services/KeywordResearchService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import type { SavedKeywordRow, SavedKeywordTagSummary } from "@/types/keywords";
import { getSavedKeywordsSchema } from "@/types/schemas/keywords";

// The app reads the full SavedKeywordRow through its own server functions. The
// MCP row includes the saved row ID for removal, while omitting timestamps,
// tag colors, and the monthly trend array to keep the response small.
const savedKeywordOutputSchema = z.looseObject({
  id: z.string(),
  keyword: z.string(),
  searchVolume: z.number().nullable(),
  keywordDifficulty: z.number().nullable(),
  cpc: z.number().nullable(),
  competition: z.number().nullable(),
  intent: z.string().nullable(),
  tags: z.array(z.string()),
});

function toMcpRow(
  row: SavedKeywordRow,
): z.infer<typeof savedKeywordOutputSchema> {
  return {
    id: row.id,
    keyword: row.keyword,
    searchVolume: row.searchVolume,
    keywordDifficulty: row.keywordDifficulty,
    cpc: row.cpc,
    competition: row.competition,
    intent: row.intent,
    tags: row.tags.map((tag) => tag.name),
  };
}

function toMcpTag(tag: SavedKeywordTagSummary) {
  return { name: tag.name, keywordCount: tag.keywordCount };
}

const inputSchema = {
  projectId: projectIdSchema,
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Source page, starting at 1. Keep the same filters, sort, and limit when paginating.",
    ),
  sort: getSavedKeywordsSchema.shape.sort
    .removeDefault()
    .optional()
    .describe(
      "Sort by relevance to the question; default createdAt. Use searchVolume desc for highest-volume terms or keywordDifficulty asc for low-difficulty candidates.",
    ),
  order: z.enum(["asc", "desc"]).optional(),
  search: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional keyword text filter."),
  tags: z
    .array(z.string().min(1).max(64))
    .max(20)
    .optional()
    .describe("Optional tag-name filters. Multiple tags match ANY tag."),
  limit: z
    .union([z.literal(50), z.literal(100), z.literal(250)])
    .optional()
    .describe("Maximum rows to return. Defaults to 100."),
} as const;

export const listSavedKeywordsTool = {
  name: "list_saved_keywords",
  config: {
    title: "List saved keywords",
    description:
      "Lists keywords saved to a project (with cached metrics like search volume, difficulty, CPC, and tags if available). Uses no credits — reads from OpenSEO's database, no DataForSEO call. Each row includes its saved-keyword ID for remove_saved_keywords. Use tag filters when the user asks for a saved segment; multiple tags match ANY tag.",
    inputSchema,
    outputSchema: z.looseObject({
      rows: z.array(savedKeywordOutputSchema),
      totalCount: z.number(),
      tags: z.array(
        z.looseObject({ name: z.string(), keywordCount: z.number() }),
      ),
      pageInfo: z
        .object({
          page: z.number(),
          limit: z.number(),
          hasMore: z.boolean(),
          nextPage: z.number().nullable(),
        })
        .optional(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof inputSchema>>, context) => {
      const { rows, totalCount, tags } =
        await KeywordResearchService.getSavedKeywords({
          projectId: args.projectId,
          search: args.search,
          tagNames: args.tags,
          page: args.page ?? 1,
          pageSize: args.limit ?? 100,
          sort: args.sort ?? "createdAt",
          order: args.order ?? "desc",
        });
      const text =
        rows.length === 0
          ? "No saved keywords yet."
          : `Saved keywords (${rows.length} of ${totalCount}):\n` +
            rows
              .map((row) => {
                const tagText =
                  row.tags.length > 0
                    ? `  tags:${row.tags.map((tag) => tag.name).join(",")}`
                    : "";
                return `- ${row.keyword}  id:${row.id}  vol:${row.searchVolume ?? "?"}  kd:${row.keywordDifficulty ?? "?"}  cpc:${row.cpc != null ? `$${row.cpc.toFixed(2)}` : "?"}${tagText}`;
              })
              .join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/saved`,
        ),
        structuredContent: {
          rows: rows.map(toMcpRow),
          totalCount,
          pageInfo: {
            page: args.page ?? 1,
            limit: args.limit ?? 100,
            hasMore:
              ((args.page ?? 1) - 1) * (args.limit ?? 100) + rows.length <
              totalCount,
            nextPage:
              ((args.page ?? 1) - 1) * (args.limit ?? 100) + rows.length <
              totalCount
                ? (args.page ?? 1) + 1
                : null,
          },
          tags: tags.map(toMcpTag),
        },
      });
    },
  ),
};

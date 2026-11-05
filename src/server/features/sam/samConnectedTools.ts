import type { Tool, ToolSet } from "ai";
import type { ZodRawShape } from "zod";
import type { McpToolDefinition } from "./samMcpTool";
import { getProjectContextTool } from "@/server/mcp/tools/project-context";
import {
  saveReportTool,
  listReportsTool,
  getReportTool,
} from "@/server/mcp/tools/report-tools";

export function buildSamConnectedTools(
  tools: ToolSet,
  adaptTool: <Shape extends ZodRawShape>(
    definition: McpToolDefinition<Shape>,
  ) => Tool,
): ToolSet {
  // Explicit allowlist: new MCP tools cannot silently expand this profile.
  return {
    get_project_context: adaptTool(getProjectContextTool),
    list_saved_keywords: tools.list_saved_keywords,
    get_search_console_performance: tools.get_search_console_performance,
    inspect_urls: tools.inspect_urls,
    get_google_analytics_organic_landing_pages:
      tools.get_google_analytics_organic_landing_pages,
    get_google_analytics_page_performance:
      tools.get_google_analytics_page_performance,
    get_google_analytics_key_events: tools.get_google_analytics_key_events,
    get_search_opportunities: tools.get_search_opportunities,
    get_google_analytics_organic_overview:
      tools.get_google_analytics_organic_overview,
    get_google_analytics_traffic_acquisition:
      tools.get_google_analytics_traffic_acquisition,
    get_google_analytics_measurement_health:
      tools.get_google_analytics_measurement_health,
    get_google_analytics_ecommerce_performance:
      tools.get_google_analytics_ecommerce_performance,
    get_google_analytics_site_search: tools.get_google_analytics_site_search,
    get_google_analytics_audience_breakdown:
      tools.get_google_analytics_audience_breakdown,
    list_reports: adaptTool({
      ...listReportsTool,
      config: {
        ...listReportsTool.config,
        description:
          "List this project's saved reports and summaries. Reports cannot be overwritten in chat.",
      },
    }),
    get_report: adaptTool({
      ...getReportTool,
      config: {
        ...getReportTool.config,
        description:
          "Read a saved report in this project. Reading never publishes it. Reports cannot be edited or shared in chat.",
      },
    }),
    create_report: adaptTool({
      name: "create_report",
      config: {
        description:
          "Create a NEW private HTML report only when the user requests one. Return the private app URL. Existing reports cannot be replaced. Include question, dates, source properties, findings, supporting tables, recommendations and limitations.",
        inputSchema: {
          projectId: saveReportTool.config.inputSchema.projectId,
          title: saveReportTool.config.inputSchema.title,
          summary: saveReportTool.config.inputSchema.summary,
          html: saveReportTool.config.inputSchema.html,
        },
      },
      // Never forward a model-supplied reportId, sharing flag, or template.
      handler: (args, context) =>
        saveReportTool.handler(
          {
            projectId: args.projectId,
            title: args.title,
            summary: args.summary,
            html: args.html,
            skill: "connected-analytics",
          },
          context,
        ),
    }),
  };
}

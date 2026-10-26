import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { loadLocalEnv, parseArgs, requiredEnv } from "./cli-utils";
import { tregAdapter } from "@/server/providers/treg/adapter";
import { withProviderExecution } from "@/server/providers/context";
import { dataforseoGet } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import {
  fetchKeywordOverview,
  fetchRelatedKeywords,
  fetchKeywordSuggestions,
  fetchKeywordIdeas,
  fetchDomainRankOverview,
} from "@/server/lib/dataforseo/labs";
import { fetchLiveSerp } from "@/server/lib/dataforseo/serp";
import { fetchBacklinksSummary } from "@/server/lib/dataforseo/backlinks";

// Free by default. A positive --budget explicitly enables the listed paid
// probes, sequentially, with the remaining total as Treg's hard per-call cap.
// This never changes the active provider or marks a route verified by itself.
loadLocalEnv();
const args = parseArgs(process.argv.slice(2));
const budgetUsd = z.coerce
  .number()
  .finite()
  .min(0)
  .max(1)
  .parse(args.budget ?? 0);
const execution = {
  purpose: "verification" as const,
  organizationId: "treg-provider-verification",
  provider: "treg" as const,
  revision: 0,
  credentialVersion: null,
  source: "environment" as const,
  authorization: requiredEnv("TREG_TOKEN"),
};
let spentMicro = 0;
const budgetMicro = Math.floor(budgetUsd * 1_000_000);
const evidence: Array<{ operation: string; costMicro: number; data: unknown }> =
  [];

try {
  process.env.TREG_MAX_CALL_COST_USD = "0";
  const connection = await tregAdapter.testConnection(execution);
  if (!connection.ok)
    throw new Error(`Account check failed: ${connection.error.code}`);
  const locations = await withProviderExecution(execution, () =>
    dataforseoGet("/v3/serp/google/locations/li"),
  );
  const task = assertOk(locations);
  if (!task.result?.length) throw new Error("No location catalog returned");
  evidence.push({
    operation: "serp.locations",
    costMicro: 0,
    data: task.result,
  });
  console.log("Free account and location checks passed.");

  const market = { locationCode: 2840, languageCode: "en" };
  const research = { ...market, keyword: "coffee", limit: 2 };
  const probes: Array<{
    operation: string;
    run: () => Promise<DataforseoApiResponse<unknown>>;
  }> = [
    {
      operation: "serp.live",
      run: () => fetchLiveSerp({ ...market, keyword: "coffee", depth: 10 }),
    },
    {
      operation: "keywords.overview",
      run: () =>
        fetchKeywordOverview({ ...market, keywords: ["coffee", "tea"] }),
    },
    {
      operation: "keywords.related",
      run: () => fetchRelatedKeywords({ ...research, depth: 1 }),
    },
    {
      operation: "keywords.suggestions",
      run: () => fetchKeywordSuggestions(research),
    },
    { operation: "keywords.ideas", run: () => fetchKeywordIdeas(research) },
    {
      operation: "domain.overview",
      run: () =>
        fetchDomainRankOverview({ ...market, target: "wikipedia.org" }),
    },
    {
      operation: "backlinks.summary",
      run: () => fetchBacklinksSummary({ target: "example.com" }),
    },
  ];
  if (budgetMicro > 0) {
    for (const probe of probes) {
      const remainingMicro = budgetMicro - spentMicro;
      if (remainingMicro <= 0) throw new Error("Verification budget exhausted");
      process.env.TREG_MAX_CALL_COST_USD = (remainingMicro / 1_000_000).toFixed(
        6,
      );
      const result = await withProviderExecution(execution, probe.run);
      const costMicro = Math.round(result.billing.costUsd * 1_000_000);
      spentMicro += costMicro;
      evidence.push({
        operation: probe.operation,
        costMicro,
        data: result.data,
      });
      console.log(
        `${probe.operation} passed; total $${(spentMicro / 1_000_000).toFixed(6)}`,
      );
      if (spentMicro > budgetMicro)
        throw new Error("Treg exceeded its request ceiling; stopping");
    }
  } else {
    console.log("Paid SEO checks skipped (budget $0).");
  }
} catch (error) {
  // Stop on the first error, including ambiguous submissions. Never fall back
  // or try another key; a lost response may already have been charged.
  console.error(error instanceof Error ? error.message : "Verification failed");
  process.exitCode = 1;
} finally {
  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(
      args.output,
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          budgetMicro,
          spentMicro,
          evidence,
        },
        null,
        2,
      ),
    );
  }
}

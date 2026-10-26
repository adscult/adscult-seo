import { RankTrackingConfigService } from "./RankTrackingConfigService";
import { unwrapProviderResult } from "@/server/providers/operation";
import { env } from "cloudflare:workers";
import {
  customerHasPaidPlan,
  type BillingCustomerContext,
} from "@/server/billing/subscription";
import { fetchKeywordMetrics } from "@/server/providers/keyword-metrics";
import { recordProviderResultSource } from "@/server/providers/result-source";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import type { RankCheckTriggerResult } from "@/types/schemas/rank-tracking";
import {
  beginRankCheckRun,
  reconcileActiveRankCheckRun,
} from "./rankCheckRunGuards";
import {
  estimateRankCheckCredits,
  rankCheckCostApprovalError,
} from "@/shared/rank-tracking";
import { resolveKeywordDataLanguage } from "@/shared/keyword-locations";
import { getLatestResults } from "./rankTrackingResults";
import { RankTrackingKeywordService } from "./RankTrackingKeywordService";

// ---------------------------------------------------------------------------
// Trigger a manual check
// ---------------------------------------------------------------------------

async function triggerCheck(input: {
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  keywordIds?: string[];
  maxCostCredits?: number;
}): Promise<RankCheckTriggerResult> {
  const config = await RankTrackingConfigService.getConfig(
    input.configId,
    input.projectId,
  );

  await requireRankCheckAccess(input.billingCustomer.organizationId);

  const keywords = await RankTrackingRepository.getKeywordsForConfig(config.id);
  if (keywords.length === 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      "No keywords to track. Add keywords to this domain first.",
    );
  }

  if (input.maxCostCredits != null) {
    const { costCredits } = estimateRankCheckCredits(
      keywords.map((kw) => kw.keyword),
      config.devices,
      config.serpDepth,
      "live",
    );
    if (costCredits > input.maxCostCredits) {
      throw new AppError(
        "VALIDATION_ERROR",
        rankCheckCostApprovalError(costCredits, input.maxCostCredits),
      );
    }
  }

  return beginRankCheckRun({
    workflow: env.RANK_CHECK_WORKFLOW,
    config,
    projectId: input.projectId,
    billingCustomer: {
      userId: input.billingCustomer.userId,
      userEmail: input.billingCustomer.userEmail,
      organizationId: input.billingCustomer.organizationId,
      projectId: input.billingCustomer.projectId,
    },
    keywordsTotal: input.keywordIds ? input.keywordIds.length : keywords.length,
    keywordIds: input.keywordIds,
    maxCostCredits: input.maxCostCredits,
    trigger: "manual",
    workflowStartErrorMessage: "Failed to start rank check workflow",
  });
}

// A scheduled check this close covers the same keywords, so an automatic
// check now would bill the customer twice within the hour.
const AUTO_CHECK_SCHEDULE_WINDOW_MS = 60 * 60_000;

// The check that follows adding a domain or keywords, as opposed to the user
// pressing "Check Now" — so it yields to an imminent scheduled check.
async function triggerAutoCheck(input: {
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  keywordIds?: string[];
}): Promise<
  | RankCheckTriggerResult
  | { ok: false; reason: "scheduled_soon" | "no_keywords" }
> {
  const config = await RankTrackingConfigService.getConfig(
    input.configId,
    input.projectId,
  );
  const msUntilScheduled = config.nextCheckAt
    ? new Date(config.nextCheckAt).getTime() - Date.now()
    : Infinity;
  if (msUntilScheduled <= AUTO_CHECK_SCHEDULE_WINDOW_MS) {
    // A free plan must not be told to wait for a scheduled check that the
    // scheduler will skip. The other path checks access in triggerCheck.
    await requireRankCheckAccess(input.billingCustomer.organizationId);
    return { ok: false, reason: "scheduled_soon" };
  }
  // A brand-new domain has no keywords yet; a re-added archived one keeps its.
  const counts = await RankTrackingRepository.getKeywordCountsForConfigs([
    config.id,
  ]);
  if (!counts.get(config.id)) return { ok: false, reason: "no_keywords" };
  return triggerCheck(input);
}

async function getLatestRun(configId: string, projectId: string) {
  await RankTrackingConfigService.getConfig(configId, projectId);
  const run = await RankTrackingRepository.getLatestRunForConfig(configId);
  if (!run) return null;

  // If the DB says the run is still active, check the workflow instance.
  // We only report staleness here — the next call to beginRankCheckRun will
  // mark a stale blocker as failed before retrying its insert. Mutating from
  // this read path caused a race where the original workflow kept running
  // while a replacement was started.
  const reconciliation = await reconcileActiveRankCheckRun(run);
  if (reconciliation) {
    return formatRun(run, {
      maybeStale: true,
      staleReason: reconciliation.errorMessage,
    });
  }

  return formatRun(run);
}

// ---------------------------------------------------------------------------
// Keyword metrics (volume, difficulty, CPC)
// ---------------------------------------------------------------------------

async function refreshKeywordMetrics(
  configId: string,
  projectId: string,
  billingCustomer: BillingCustomerContext,
): Promise<{
  updated: number;
  failures?: Array<{ keyword: string; code: string }>;
}> {
  const config = await RankTrackingConfigService.getConfig(configId, projectId);
  await requireRankCheckAccess(billingCustomer.organizationId);
  const keywords = await RankTrackingRepository.getKeywordsForConfig(configId);
  if (keywords.length === 0) return { updated: 0 };

  const batch = await fetchKeywordMetrics(billingCustomer, {
    // The keyword-data APIs are case-insensitive and echo keywords back
    // lowercased, so ask in lowercase. A match-case keyword can sit next to
    // its lowercase twin; both then map to the same metrics row and the
    // request carries no duplicates.
    keywords: [...new Set(keywords.map((kw) => kw.keyword.toLowerCase()))],
    locationCode: config.locationCode,
    // Trackers can pair any SERP language with any country; the keyword-data
    // APIs only serve the country's own languages.
    languageCode: resolveKeywordDataLanguage(
      config.locationCode,
      config.languageCode,
    ),
    // Local configs get volume/CPC scoped to the tracked city; national
    // numbers can overstate local demand by orders of magnitude.
    locationName: config.locationName ?? undefined,
    creditFeature: "rank_tracking",
  });
  const data = unwrapProviderResult(batch);
  const metrics = data.items.flatMap(({ result }) =>
    result.ok ? [result.data] : [],
  );
  const failures = data.items.flatMap(({ keyword, result }) =>
    result.ok ? [] : [{ keyword, code: result.error.code }],
  );
  const providerResultSourceId =
    await recordProviderResultSource("keywords.metrics");
  const byKeyword = new Map(
    metrics.map((metric) => [metric.keyword.toLowerCase(), metric]),
  );

  const now = new Date().toISOString();
  const updates = keywords
    .map((kw) => {
      const metric = byKeyword.get(kw.keyword.toLowerCase());
      if (!metric) return null;
      // Rank tracking only tracks volume / difficulty / CPC.
      return {
        id: kw.id,
        searchVolume: metric.searchVolume,
        keywordDifficulty: metric.keywordDifficulty,
        cpc: metric.cpc,
        metricsFetchedAt: now,
        providerResultSourceId,
      };
    })
    .filter((u): u is NonNullable<typeof u> => u !== null);

  if (updates.length === 0) return { updated: 0 };
  await RankTrackingRepository.updateKeywordMetrics(updates);
  return { updated: updates.length, ...(failures.length ? { failures } : {}) };
}

// ---------------------------------------------------------------------------
// MCP/browser read models and access policy
// ---------------------------------------------------------------------------

async function getConfigs(projectId: string) {
  return RankTrackingRepository.getConfigsForProject(projectId);
}

async function getTracker(configId: string, projectId: string) {
  const config = await RankTrackingConfigService.getConfig(configId, projectId);
  const results = await getLatestResults(configId, projectId);
  return { config, results };
}

async function requireRankCheckAccess(organizationId: string) {
  if (!(await isHostedServerAuthMode())) return;
  if (await customerHasPaidPlan(organizationId)) return;
  throw new AppError(
    "PAYMENT_REQUIRED",
    "Upgrade to the paid plan to run rank checks",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RunRow = NonNullable<
  Awaited<ReturnType<typeof RankTrackingRepository.getLatestRunForConfig>>
>;

function formatRun(
  run: RunRow,
  stale?: { maybeStale: boolean; staleReason: string },
) {
  return {
    id: run.id,
    status: run.status,
    keywordsTotal: run.keywordsTotal,
    keywordsChecked: run.keywordsChecked,
    isSubsetRun: run.isSubsetRun,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    maybeStale: stale?.maybeStale ?? false,
    staleReason: stale?.staleReason ?? null,
  };
}

export const RankTrackingService = {
  createConfig: RankTrackingConfigService.createConfig,
  updateConfig: RankTrackingConfigService.updateConfig,
  addKeywords: RankTrackingKeywordService.addKeywords,
  removeKeywords: RankTrackingKeywordService.removeKeywords,
  triggerCheck,
  triggerAutoCheck,
  getLatestRun,
  estimateCost: RankTrackingKeywordService.estimateCost,
  refreshKeywordMetrics,
  getConfigs,
  getTracker,
  requireRankCheckAccess,
};

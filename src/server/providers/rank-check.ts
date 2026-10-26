import { getScopedProviderExecution, withProviderScope } from "./context";
import { fetchAnyapiRank } from "./treg/anyapi-rank";
import { AppError } from "@/server/lib/errors";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { fetchRankCheckTaskResult } from "@/server/lib/dataforseo";
import {
  executeProviderOperation,
  normalizeProviderFailure,
  executeProviderReadOperation,
} from "./operation";
import {
  rankCheckResultSchema,
  type RankCheckRequest,
  type RankTaskRequest,
} from "./contracts/rank-check";

function rankScope(input: Omit<RankTaskRequest, "tasks">, anyapi: boolean) {
  return {
    engine: "google" as const,
    targetDomain: input.targetDomain,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName ?? null,
    depth: Math.min(100, Math.max(10, input.depth)),
    positionSemantics: anyapi
      ? ("organic_rank_across_pages" as const)
      : ("organic_rank_with_absolute_fallback" as const),
  };
}

export function fetchRankChecks(
  customer: BillingCustomerContext,
  inputs: RankCheckRequest[],
  searchProvider: "anyapi" | "dataforseo" = "dataforseo",
) {
  return withProviderScope(customer.organizationId, async () => {
    const execution = await getScopedProviderExecution();
    const anyapi = searchProvider === "anyapi";
    const run = (
      settled: PromiseSettledResult<unknown>[],
      warnings: string[],
    ) => {
      const items = inputs.map((input, inputIndex) => {
        const outcome = settled[inputIndex];
        let result;
        try {
          if (!outcome || outcome.status === "rejected") {
            throw (
              outcome?.reason ?? new SyntaxError("Missing rank-check outcome")
            );
          }
          result = {
            ok: true as const,
            data: rankCheckResultSchema.parse(outcome.value),
          };
        } catch (cause) {
          result = {
            ok: false as const,
            error: normalizeProviderFailure(cause),
          };
        }
        return {
          inputIndex,
          keywordId: input.keywordId,
          keyword: input.keyword,
          device: input.device,
          scope: rankScope(input, anyapi),
          result,
        };
      });
      const failed = items.filter((item) => !item.result.ok).length;
      if (failed)
        warnings.push(
          `Rank checks unavailable for ${failed} of ${inputs.length} inputs.`,
        );
      return { items };
    };
    if (anyapi)
      return executeProviderReadOperation(
        "serp.rankCheck",
        async (warnings) => {
          if (!execution || execution.provider !== "treg")
            throw new AppError("SEO_PROVIDER_UNSUPPORTED");
          return run(
            await Promise.allSettled(
              inputs.map((input) => fetchAnyapiRank(execution, input)),
            ),
            warnings,
          );
        },
        { upstreamVendor: "anyapi" },
      );
    return executeProviderOperation(
      customer,
      "serp.rankCheck",
      async (client, warnings) => {
        const nativeInputs = inputs.map((input) => {
          if (input.device === "provider")
            throw new AppError("VALIDATION_ERROR");
          return { ...input, device: input.device };
        });
        // Preserve one reservation/settlement for the native batch.
        return run(await client.serp.rankCheckBatch(nativeInputs), warnings);
      },
    );
  });
}

export function postRankTasks(
  customer: BillingCustomerContext,
  input: RankTaskRequest,
) {
  return executeProviderOperation(
    customer,
    "serp.rankTaskPost",
    async (client, warnings) => {
      const tasks = z
        .array(
          z.object({
            taskId: z.string(),
            keywordId: z.string(),
            keyword: z.string(),
            device: z.enum(["desktop", "mobile"]),
          }),
        )
        .parse(await client.serp.rankCheckTaskPost(input));
      if (tasks.length < input.tasks.length)
        warnings.push("Some rank-check tasks were not accepted.");
      return {
        tasks,
        requestedCount: input.tasks.length,
        scope: rankScope(input, false),
      };
    },
  );
}

const rankTaskOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("failed"), message: z.string() }),
  z.object({ status: z.literal("completed"), result: rankCheckResultSchema }),
]);

export function collectRankTask(
  customer: BillingCustomerContext,
  input: {
    taskId: string;
    keywordId: string;
    keyword: string;
    targetDomain: string;
  },
) {
  // Collection is free. The transport resolves the persisted task reference,
  // and workflow scopes retain the configuration captured when work started.
  return executeProviderOperation(customer, "serp.rankTaskGet", async () => {
    const outcome = rankTaskOutcomeSchema.parse(
      await fetchRankCheckTaskResult(input),
    );
    return outcome.status === "failed"
      ? { ...outcome, message: "UPSTREAM_UNAVAILABLE" }
      : outcome;
  });
}

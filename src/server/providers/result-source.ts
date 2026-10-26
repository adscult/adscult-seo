import { db } from "@/db";
import { seoProviderResultSources } from "@/db/schema";
import { getScopedProviderExecution } from "./context";
import type { providerOperations } from "./types";

/** Record the pinned execution, including when a workflow replays a paid step. */
export async function recordProviderResultSource(
  operation:
    | (typeof providerOperations)[number]["operation"]
    | "keywords.research"
    | "keywords.metrics"
    | "ai.answers",
  upstreamVendor = "dataforseo",
): Promise<string | null> {
  const execution = await getScopedProviderExecution();
  // Unscoped imports and historical/client-supplied metrics are unattributed.
  if (!execution) return null;
  const id = crypto.randomUUID();
  await db.insert(seoProviderResultSources).values({
    id,
    organizationId: execution.organizationId,
    provider: execution.provider,
    upstreamVendor,
    operation,
    configurationId: execution.credentialVersion,
    revision: execution.revision,
    contractVersion: 1,
    fetchedAt: new Date().toISOString(),
  });
  return id;
}

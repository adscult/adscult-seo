import type { ProviderExecution } from "../types";
import { AppError } from "@/server/lib/errors";
import {
  getOptionalEnvValue,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";

/** Bounded Treg transport shared by explicit, server-owned operation adapters. */
export async function callTregEndpoint(
  execution: ProviderExecution,
  endpoint: string,
  options: {
    maxCostUsd?: number;
    body?: unknown;
    query?: Record<string, string>;
    signal?: AbortSignal | null;
  },
) {
  if (execution.provider !== "treg" || (await isHostedServerAuthMode()))
    throw new AppError("SEO_PROVIDER_UNSUPPORTED");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(execution.organizationId))
    throw new AppError("VALIDATION_ERROR");
  const ceiling = (await getOptionalEnvValue("TREG_MAX_CALL_COST_USD")) ?? "1";
  if (!/^\d+(?:\.\d{1,6})?$/.test(ceiling) || Number(ceiling) > 1000)
    throw new AppError("SEO_PROVIDER_NOT_CONFIGURED");
  const destination = new URL(`https://treg.to/call/${endpoint}`);
  for (const [key, value] of Object.entries(options.query ?? {}))
    destination.searchParams.set(key, value);
  const headers = new Headers({
    Accept: "application/json",
    "X-Treg-Token": execution.authorization,
    "X-Treg-Meta": `customer=${execution.organizationId}`,
    "X-Treg-Route-Max-Cost": String(
      Math.min(Number(ceiling), options.maxCostUsd ?? Number(ceiling)),
    ),
    "Idempotency-Key": crypto.randomUUID(),
  });
  if (options.body !== undefined)
    headers.set("Content-Type", "application/json");
  const response = await fetch(destination.toString(), {
    method: options.body === undefined ? "GET" : "POST",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    signal: options.signal ?? AbortSignal.timeout(60_000),
    redirect: "manual",
  });
  const costHeader = response.headers.get("X-Treg-Cost-Micro");
  const costMicro = costHeader === null ? 0 : Number(costHeader);
  if (
    (costHeader !== null && !/^\d+$/.test(costHeader)) ||
    !Number.isSafeInteger(costMicro)
  )
    throw new AppError("UPSTREAM_UNAVAILABLE");
  // Retain the sanitized receipt even if the upstream payload cannot be parsed.
  console.info("treg.call", {
    organizationId: execution.organizationId,
    endpoint,
    callId: response.headers.get("X-Treg-Call-Id"),
    costMicro,
    httpStatus: response.status,
  });
  // Do not return Treg's raw account/balance/top-up errors to a feature parser.
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 403].includes(response.status))
      throw new AppError("SEO_PROVIDER_AUTH_FAILED");
    if (response.status === 402)
      throw new AppError("SEO_PROVIDER_QUOTA_EXCEEDED");
    if (response.status === 429) throw new AppError("RATE_LIMITED");
    if ([400, 422].includes(response.status))
      throw new AppError("VALIDATION_ERROR");
    throw new AppError("UPSTREAM_UNAVAILABLE");
  }
  return { response, costMicro };
}

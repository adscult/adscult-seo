import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import { isErrorCode, type ErrorCode } from "@/shared/error-codes";
import { getScopedProviderExecution, withProviderScope } from "./context";
import { getProviderAdapter } from "./registry";
import type { ProviderResult, providerOperations } from "./types";

type Failure = Extract<ProviderResult<never>, { ok: false }>["error"];

export function normalizeProviderFailure(cause: unknown): Failure {
  if (cause instanceof z.ZodError || cause instanceof SyntaxError)
    return {
      code: "INVALID_RESPONSE",
      message: "UPSTREAM_UNAVAILABLE",
      retryable: false,
    };
  if (
    cause instanceof Error &&
    ["DataForSEOTimeoutError", "TimeoutError", "AbortError"].includes(
      cause.name,
    )
  )
    return {
      code: "TIMEOUT",
      message: "SEO_PROVIDER_TIMEOUT",
      retryable: false,
    };
  if (cause instanceof AppError) {
    const codes: Partial<Record<ErrorCode, Failure["code"]>> = {
      VALIDATION_ERROR: "INVALID_REQUEST",
      INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
      DATAFORSEO_AUTH_FAILED: "AUTH_FAILED",
      SEO_PROVIDER_AUTH_FAILED: "AUTH_FAILED",
      RATE_LIMITED: "RATE_LIMITED",
      UPSTREAM_UNAVAILABLE: "UPSTREAM_ERROR",
      SEO_PROVIDER_UNSUPPORTED: "UNSUPPORTED",
      SEO_PROVIDER_NOT_CONFIGURED: "NOT_CONFIGURED",
      SEO_PROVIDER_QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
      BACKLINKS_BILLING_ISSUE: "QUOTA_EXCEEDED",
      AI_SEARCH_BILLING_ISSUE: "QUOTA_EXCEEDED",
    };
    const code = codes[cause.code];
    if (code) return { code, message: cause.code, retryable: false };
    // Authorization and charged-task errors retain
    // their existing public behavior and billing settlement.
    throw cause;
  }
  return {
    code: "UPSTREAM_ERROR",
    message: "UPSTREAM_UNAVAILABLE",
    retryable: false,
  };
}

/** Compatibility boundary for feature services that still throw AppError. */
export function unwrapProviderResult<T>(result: ProviderResult<T>): T {
  if (result.ok) return result.data;
  throw new AppError(
    isErrorCode(result.error.message)
      ? result.error.message
      : "UPSTREAM_UNAVAILABLE",
  );
}

// Only provider modules supply implementations. Features receive normalized
// results, never the metered vendor client. No retries or failover here.
export function executeProviderOperation<T>(
  customer: BillingCustomerContext,
  operation: (typeof providerOperations)[number]["operation"],
  dataforseo: (
    client: ReturnType<typeof createDataforseoClient>,
    warnings: string[],
  ) => Promise<T>,
  semantics?: Partial<
    Pick<
      ProviderResult<T>["meta"],
      "scope" | "metricDefinitions" | "upstreamVendor"
    >
  >,
): Promise<ProviderResult<T>> {
  return withProviderScope(customer.organizationId, () =>
    executeProviderReadOperation(
      operation,
      (warnings) => dataforseo(createDataforseoClient(customer), warnings),
      semantics,
    ),
  );
}

// Free reads never enter the metered client. An unscoped invocation retains
// the existing installation/CLI DataForSEO mode; authenticated requests always
// resolve their organization and fail closed if its settings cannot be read.
export async function executeProviderReadOperation<T>(
  operation: (typeof providerOperations)[number]["operation"],
  read: (warnings: string[]) => Promise<T>,
  semantics?: Partial<
    Pick<
      ProviderResult<T>["meta"],
      "scope" | "metricDefinitions" | "upstreamVendor"
    >
  >,
): Promise<ProviderResult<T>> {
  const execution = await getScopedProviderExecution();
  const meta = {
    provider: execution?.provider ?? "dataforseo",
    upstreamVendor: "dataforseo",
    operation,
    settingsRevision: execution?.revision ?? 0,
    fetchedAt: new Date().toISOString(),
    warnings: [] as string[],
    ...semantics,
  };
  const available = getProviderAdapter(execution?.provider ?? "dataforseo")
    .capabilities()
    .some((item) => item.operation === operation && item.state === "available");
  if (!available)
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED",
        message: "SEO_PROVIDER_UNSUPPORTED",
        retryable: false,
      },
      meta,
    };
  try {
    const data = await read(meta.warnings);
    return { ok: true, data, meta };
  } catch (cause) {
    return { ok: false, error: normalizeProviderFailure(cause), meta };
  }
}

import { dataforseoAccountErrorCode } from "./account-error";
import { z } from "zod";
import type {
  ProviderTransportAdapter,
  ProviderExecution,
  ProviderResult,
} from "@/server/providers/types";
import { providerOperations } from "@/server/providers/types";
import { AppError } from "@/server/lib/errors";

// Compatibility adapter: the existing section parsers and billing envelope
// remain the authority for validation and normalization of DataForSEO data.
export const dataforseoAdapter: ProviderTransportAdapter = {
  id: "dataforseo",
  capabilities: () =>
    providerOperations.map(({ operation, label }) => ({
      operation,
      label,
      state: "available",
    })),
  testConnection,
  request(execution, url, init) {
    if (execution.provider !== "dataforseo")
      throw new AppError("SEO_PROVIDER_UNSUPPORTED");
    const target = new URL(url);
    if (
      ![
        "https://api.dataforseo.com",
        "https://sandbox.dataforseo.com",
      ].includes(target.origin) ||
      !target.pathname.startsWith("/v3/")
    ) {
      throw new AppError("VALIDATION_ERROR", "Unknown DataForSEO route");
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Basic ${execution.authorization}`);
    return fetch(url, { ...init, headers, redirect: "manual" });
  },
};

const connectionEnvelopeSchema = z.object({
  status_code: z.number(),
  tasks: z
    .array(
      z.object({
        status_code: z.number(),
        result: z.array(z.unknown()).nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
});

async function testConnection(
  execution: ProviderExecution,
): Promise<ProviderResult<{ authenticated: boolean }>> {
  const meta = {
    provider: execution.provider,
    upstreamVendor: "dataforseo",
    operation: "connection.test",
    settingsRevision: execution.revision,
    fetchedAt: new Date().toISOString(),
    warnings: [],
  };
  type FailureCode = Extract<
    ProviderResult<never>,
    { ok: false }
  >["error"]["code"];
  const failure = (
    code: FailureCode,
  ): ProviderResult<{ authenticated: boolean }> => ({
    ok: false,
    error: {
      code,
      message: code,
      retryable: ["RATE_LIMITED", "TIMEOUT", "UPSTREAM_ERROR"].includes(code),
    },
    meta,
  });
  try {
    // Documented free account endpoint, never a billable SEO query. No retries.
    const response = await dataforseoAdapter.request(
      execution,
      "https://api.dataforseo.com/v3/appendix/user_data",
      { method: "GET", signal: AbortSignal.timeout(15_000) },
    );
    const accountErrors = {
      DATAFORSEO_AUTH_FAILED: "AUTH_FAILED",
      SEO_PROVIDER_QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
      RATE_LIMITED: "RATE_LIMITED",
    } as const;
    const httpAccountError = dataforseoAccountErrorCode(response.status);
    if (httpAccountError) return failure(accountErrors[httpAccountError]);
    if (!response.ok) return failure("UPSTREAM_ERROR");
    const envelope = connectionEnvelopeSchema.safeParse(await response.json());
    if (!envelope.success) return failure("INVALID_RESPONSE");
    const task = envelope.data.tasks?.[0];
    const status =
      envelope.data.status_code !== 20000
        ? envelope.data.status_code
        : task?.status_code;
    const accountError = dataforseoAccountErrorCode(status);
    if (accountError) return failure(accountErrors[accountError]);
    if (status !== 20000) return failure("UPSTREAM_ERROR");
    if (!task?.result?.length) return failure("INVALID_RESPONSE");
    return { ok: true, data: { authenticated: true }, meta };
  } catch (error) {
    if (error instanceof SyntaxError) return failure("INVALID_RESPONSE");
    if (
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
    )
      return failure("TIMEOUT");
    return failure("UPSTREAM_ERROR");
  }
}

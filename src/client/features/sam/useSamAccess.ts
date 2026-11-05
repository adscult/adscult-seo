import { useQuery } from "@tanstack/react-query";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getSamAccessSetupStatus } from "@/serverFunctions/samAccess";

// Fails closed: the chat only renders once the check confirms the selected provider's
// key is set. A failed check is an error with retry, not the key-missing gate.
type SamAccess =
  | {
      status: "ready";
      details: Awaited<ReturnType<typeof getSamAccessSetupStatus>>;
    }
  | { status: "checking" }
  | {
      status: "error";
      error: unknown;
      isRetrying: boolean;
      onRetry: () => void;
    }
  | {
      status: "setup";
      provider: "openrouter" | "anthropic";
      errorMessage: string | null;
      isRefetching: boolean;
      onRetry: () => void;
    };

export function useSamAccess(projectId: string): SamAccess {
  const { data, error, isFetching, isRefetching, refetch } = useQuery({
    queryKey: ["samAccessStatus", projectId],
    queryFn: () => getSamAccessSetupStatus({ data: { projectId } }),
    refetchOnWindowFocus: false,
    refetchInterval: 15_000,
    staleTime: 60 * 1000,
  });

  const onRetry = () => void refetch();

  if (data === undefined) {
    return error
      ? { status: "error", error, isRetrying: isFetching, onRetry }
      : { status: "checking" };
  }
  if (data.enabled) return { status: "ready", details: data };
  return {
    status: "setup",
    provider: data.provider,
    errorMessage:
      data.errorMessage ??
      (error
        ? getStandardErrorMessage(
            error,
            "Could not load AI agent setup status.",
          )
        : null),
    isRefetching,
    onRetry,
  };
}

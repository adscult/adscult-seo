import { queryOptions } from "@tanstack/react-query";
import { getSeoApiKeyStatus } from "@/serverFunctions/config";

export function seoProviderStatusQueryOptions(
  organizationId: string | undefined,
) {
  return queryOptions({
    queryKey: ["seoApiKeyStatus", organizationId],
    queryFn: () => getSeoApiKeyStatus(),
    enabled: Boolean(organizationId),
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

import { createServerFn } from "@tanstack/react-start";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { resolveProviderExecution } from "@/server/providers/resolver";

export const getSeoApiKeyStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    try {
      const execution = await resolveProviderExecution(context.organizationId);
      return { configured: true, provider: execution.provider };
    } catch {
      return { configured: false, provider: null };
    }
  });

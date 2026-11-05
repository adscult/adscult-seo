import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { samConfig } from "@/shared/sam-config";
import { SamUsageRepository } from "@/server/features/sam/SamUsageRepository";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });

type SamAccessStatus = {
  enabled: boolean;
  errorMessage: string | null;
  provider: "openrouter" | "anthropic";
  model: string;
  keyName: string;
  usage: Awaited<ReturnType<typeof SamUsageRepository.status>> | null;
};

// Check only the selected provider's key. Never return credentials to the client.
export const getSamAccessSetupStatus = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }): Promise<SamAccessStatus> => {
    const settings = Object.fromEntries(
      await Promise.all(
        [
          "SAM_PROVIDER",
          "SAM_TOOL_PROFILE",
          "SAM_MODELS",
          "OPENROUTER_MODEL",
          "ANTHROPIC_MODEL",
        ].map(async (name) => [name, await getOptionalEnvValue(name)] as const),
      ),
    );
    const config = samConfig((name) => settings[name]);
    const enabled = Boolean(await getOptionalEnvValue(config.keyName));
    return {
      ...config,
      enabled,
      errorMessage: enabled
        ? null
        : `${config.keyName} is not set. Add it to your environment, restart OpenSEO, then confirm here.`,
      usage: enabled
        ? await SamUsageRepository.status(context.organizationId)
        : null,
    };
  });

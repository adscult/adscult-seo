import { getAuthMode } from "@/lib/auth-mode";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { SelfhostTeamService } from "@/server/auth/SelfhostTeamService";
import { SHARED_WORKSPACE_ORGANIZATION_ID } from "@/server/auth/delegated-organization";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";

// WebSockets authenticate at connection time. Resolve the role again for each
// turn so an open chat does not retain privileges after a role change.
export async function resolveSamToolRole(context: {
  userId: string;
  userEmail: string;
  organizationId: string;
}) {
  const mode = getAuthMode(await getOptionalEnvValue("AUTH_MODE"));
  if (mode === "local_noauth") return "owner";
  if (mode === "cloudflare_access") {
    if (context.organizationId !== SHARED_WORKSPACE_ORGANIZATION_ID)
      throw new AppError("FORBIDDEN");
    return SelfhostTeamService.getRole(context.userId, context.userEmail);
  }
  const membership = await AuthRepository.getMembership(
    context.userId,
    context.organizationId,
  );
  return membership?.role ?? null;
}

import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getAuthMode } from "@/lib/auth-mode";
import { WorkspaceMergeService } from "@/server/auth/workspace-merge";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";

// Legacy per-user workspaces only ever existed in cloudflare_access mode, and
// the merge must not be reachable anywhere else. AUTH_MODE is a runtime var on
// self-host deployments, so the client can't gate this itself — the status
// response is what hides the banner in other modes.
function isCloudflareAccessMode() {
  return getAuthMode(env.AUTH_MODE) === "cloudflare_access";
}

export const getWorkspaceMergeStatus = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    if (
      !isCloudflareAccessMode() ||
      !hasOrgPermission(context.role, { project: ["delete"] })
    ) {
      return { legacyWorkspaceCount: 0 };
    }

    return {
      legacyWorkspaceCount: await WorkspaceMergeService.countLegacyWorkspaces(),
    };
  });

// Merging moves projects across workspaces, so it requires the same permission
// as destructive project management. The service also checks the auth mode.
export const mergeLegacyWorkspaces = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { project: ["delete"] });
    return WorkspaceMergeService.mergeLegacyWorkspaces();
  });

import { createServerFn } from "@tanstack/react-start";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { SelfhostTeamService } from "@/server/auth/SelfhostTeamService";
import { updateSelfhostTeamRoleSchema } from "@/shared/selfhost-team";

export const getSelfhostTeam = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(({ context }) => SelfhostTeamService.list(context));

export const updateSelfhostTeamRole = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(updateSelfhostTeamRoleSchema)
  .handler(({ context, data }) =>
    SelfhostTeamService.updateRole(context, data),
  );

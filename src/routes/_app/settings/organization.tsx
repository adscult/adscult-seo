import { createFileRoute, notFound } from "@tanstack/react-router";
import { TeamSettings } from "@/client/features/team/TeamSettings";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { getAuthMode } from "@/lib/auth-mode";
import { SelfhostTeamSettings } from "@/client/features/team/SelfhostTeamSettings";

export const Route = createFileRoute("/_app/settings/organization")({
  beforeLoad: () => {
    if (getAuthMode(import.meta.env.AUTH_MODE) === "local_noauth") {
      throw notFound();
    }
  },
  component: () =>
    isHostedClientAuthMode() ? <TeamSettings /> : <SelfhostTeamSettings />,
});

import type * as React from "react";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";
import { useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppTopBar, SeoApiStatusBanners } from "@/client/layout/AppShellParts";
import { organizationContextQueryOptions } from "@/client/features/team/organizationQueries";
import { GscReEngagementModal } from "@/client/features/gsc/GscReEngagementModal";
import { Sidebar } from "@/client/components/Sidebar";
import { BILLING_ROUTE } from "@/shared/billing";
import { seoProviderStatusQueryOptions } from "@/client/features/settings/providerQueries";
import { getLastProjectId } from "@/client/lib/active-project";
import { dataforseoHelpLinkOptions } from "@/client/navigation/items";
import { SidebarInset, SidebarProvider } from "@/client/components/ui/sidebar";

export function AuthenticatedAppLayout({
  children,
  projectId,
  ready,
  banner,
}: {
  children: React.ReactNode;
  projectId?: string;
  /** The session is confirmed. Until then the shell renders but loads nothing. */
  ready: boolean;
  banner?: React.ReactNode;
}) {
  const location = useLocation();
  // On non-project pages (e.g. /settings) there's no projectId in the URL, so
  // derive one for the nav/switcher: prefer the last-visited project, else the
  // most recent. The whole app tree is client-only (see root ClientOnly), so we
  // can read localStorage synchronously during render — this lets the sidebar
  // show the full project nav on the very first paint instead of briefly
  // flashing only the always-visible Connect group while projects load. It is
  // read on every render, not once: the shell stays mounted across project
  // pages, which update the remembered project as the user moves between them.
  const projectsQuery = useQuery({
    ...projectsQueryOptions(),
    enabled: ready && !projectId,
  });
  const rememberedProjectId = getLastProjectId();
  const fallbackProjects = projectsQuery.data ?? [];
  const fallbackProjectId =
    fallbackProjects.find((project) => project.id === rememberedProjectId)
      ?.id ??
    fallbackProjects[0]?.id ??
    null;
  // Once the projects list loads, fallbackProjectId is the validated choice
  // (remembered-if-valid, else most recent). Before it loads, fall back to the
  // remembered id so the project nav renders immediately; a stale id here only
  // builds links that self-correct via the route guard once data arrives.
  const sidebarProjectId =
    projectId ?? fallbackProjectId ?? rememberedProjectId;
  // No project to show yet, but the list that may name one is still loading
  // (a first visit to a page without a project in the URL).
  const sidebarProjectPending =
    sidebarProjectId === null && projectsQuery.isPending;
  const organization = useQuery({
    ...organizationContextQueryOptions(),
    enabled: ready,
  });
  // Configuration and help pages do not need their own setup banner.
  const shouldCheckSeoApiKeyStatus =
    location.pathname !== BILLING_ROUTE &&
    !location.pathname.startsWith("/settings") &&
    location.pathname !== dataforseoHelpLinkOptions.to;
  const seoApiKeyStatusQuery = useQuery({
    ...seoProviderStatusQueryOptions(organization.data?.organizationId),
    enabled: ready && Boolean(organization.data?.organizationId),
  });
  const isSeoApiKeyConfigured = shouldCheckSeoApiKeyStatus
    ? (seoApiKeyStatusQuery.data?.configured ?? null)
    : null;
  const seoApiKeyStatusError =
    shouldCheckSeoApiKeyStatus && seoApiKeyStatusQuery.isError;

  const shouldShowSeoApiWarning =
    !seoApiKeyStatusError && isSeoApiKeyConfigured === false;

  return (
    <SidebarProvider className="h-[100dvh] min-h-0 overflow-hidden">
      <Sidebar
        projectId={sidebarProjectId}
        projectPending={sidebarProjectPending}
        ready={ready}
      />
      <SidebarInset className="min-h-0 overflow-hidden md:!m-0 md:!mt-2 md:!rounded-none md:!rounded-tl-lg md:border-l md:border-t md:border-sidebar-border md:!shadow-none">
        <AppTopBar
          providerStatus={seoApiKeyStatusQuery.data}
          statusError={organization.isError || seoApiKeyStatusQuery.isError}
        />
        <SeoApiStatusBanners
          shouldShowSeoApiWarning={shouldShowSeoApiWarning}
          seoApiKeyStatusError={seoApiKeyStatusError}
        />
        {banner}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </SidebarInset>

      {ready ? (
        <GscReEngagementModal projectId={sidebarProjectId} suppressed={false} />
      ) : null}
    </SidebarProvider>
  );
}

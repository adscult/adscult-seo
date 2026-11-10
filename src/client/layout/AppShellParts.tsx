import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { AppBanner } from "@/client/layout/AppBanner";
import { SidebarTrigger } from "@/client/components/ui/sidebar";
import type { getSeoApiKeyStatus } from "@/serverFunctions/config";
import { BrandLockup } from "@/client/components/BrandLogo";

export function AppTopBar({
  providerStatus,
  statusError,
}: {
  providerStatus: Awaited<ReturnType<typeof getSeoApiKeyStatus>> | undefined;
  statusError: boolean;
}) {
  const names = { dataforseo: "DataForSEO", treg: "Treg" };
  const provider = statusError
    ? "Unavailable"
    : !providerStatus
      ? "Checking…"
      : providerStatus.configured && providerStatus.provider
        ? names[providerStatus.provider]
        : "Not configured";

  return (
    <header className="flex min-h-12 w-full min-w-0 shrink-0 items-center gap-1 border-b border-border/80 bg-background px-2 md:px-4">
      <div className="flex items-center gap-1 md:hidden">
        <SidebarTrigger aria-label="Toggle sidebar" />
        <Link
          to="/"
          aria-label="AdsCult SEO home"
          className="ml-1 flex items-center gap-1.5"
        >
          <BrandLockup logoClassName="h-5 max-w-24" className="gap-1.5" />
        </Link>
      </div>
      <Link
        to="/settings"
        className="ml-auto flex min-h-9 min-w-0 max-w-full shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        aria-label={`Active SEO provider: ${provider}. Open provider settings.`}
        title="The active provider is used for new SEO requests. Open settings to review or change it."
      >
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${statusError || !providerStatus?.configured ? "bg-warning" : "bg-success"}`}
        />
        <span className="hidden text-muted-foreground md:inline">
          SEO provider
        </span>
        <span className="max-w-32 truncate font-medium" aria-live="polite">
          {provider}
        </span>
      </Link>
    </header>
  );
}

export function SeoApiStatusBanners({
  shouldShowSeoApiWarning,
  seoApiKeyStatusError,
}: {
  shouldShowSeoApiWarning: boolean;
  seoApiKeyStatusError: boolean;
}) {
  const icon = <AlertTriangle className="size-4 shrink-0" />;
  const settingsLink = (
    <Link
      to="/settings"
      className="font-medium text-primary underline-offset-4 hover:underline"
    >
      provider settings
    </Link>
  );
  return (
    <>
      {shouldShowSeoApiWarning ? (
        <AppBanner variant="warning" icon={icon}>
          Connect a supported SEO provider in {settingsLink} to load SEO data.
        </AppBanner>
      ) : null}

      {seoApiKeyStatusError ? (
        <AppBanner variant="info" icon={icon}>
          We could not check your SEO provider configuration. Review your{" "}
          {settingsLink}.
        </AppBanner>
      ) : null}
    </>
  );
}

import { getScopedProviderExecution } from "@/server/providers/context";
import { RankTrackingRepository } from "../repositories/RankTrackingRepository";
import { assertSerpLocationNameAccepted } from "@/server/lib/dataforseo/serp-location-validate";
import { AppError } from "@/server/lib/errors";
import type {
  RankTrackingConfig,
  RankCheckScheduleTime,
} from "@/types/schemas/rank-tracking";
import { MAX_CONFIGS_PER_PROJECT } from "@/shared/rank-tracking";
import { getIsoCountryCode, resolveMarket } from "@/shared/keyword-locations";
import { toRankTrackingTimestamp } from "../rankTrackingTimestamps";
import { resolveNextCheckAt } from "./configSchedule";

function assertRankTargeting(
  searchProvider: RankTrackingConfig["searchProvider"],
  devices: RankTrackingConfig["devices"],
  locationName: string | null | undefined,
  activeProvider: string | undefined,
  languageCode: string,
) {
  if (
    searchProvider === "anyapi" &&
    (activeProvider !== "treg" ||
      devices !== "provider" ||
      !/^[a-z]{2}$/.test(languageCode) ||
      locationName)
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "AnyAPI requires Treg, country targeting and a provider-managed device. Choose DataForSEO for city or desktop/mobile tracking.",
    );
  if (searchProvider !== "anyapi" && devices === "provider")
    throw new AppError(
      "VALIDATION_ERROR",
      "Choose desktop or mobile for DataForSEO tracking.",
    );
}

async function createConfig(input: {
  projectId: string;
  projectMarket: { locationCode: number; languageCode: string };
  domain: string;
  locationCode?: number;
  languageCode?: string;
  locationName?: string;
  searchProvider?: RankTrackingConfig["searchProvider"];
  devices?: RankTrackingConfig["devices"];
  serpDepth: number;
  scheduleInterval?: RankTrackingConfig["scheduleInterval"];
  scheduleTime?: RankCheckScheduleTime;
}) {
  const normalizedDomain = normalizeDomain(input.domain);
  const execution = await getScopedProviderExecution();
  const searchProvider =
    input.searchProvider ??
    (execution?.provider === "treg" ? "anyapi" : "dataforseo");
  const devices =
    input.devices ?? (searchProvider === "anyapi" ? "provider" : "both");

  const { locationCode, languageCode } = resolveMarket(
    input,
    input.projectMarket,
  );
  assertRankTargeting(
    searchProvider,
    devices,
    input.locationName,
    execution?.provider,
    languageCode,
  );

  const scheduleInterval = input.scheduleInterval ?? "weekly";
  const nextCheckAt = await resolveNextCheckAt(
    scheduleInterval,
    input.scheduleTime,
  );

  const locationName = input.locationName ?? null;
  // Before the duplicate/limit checks so an unusable location name is the
  // error the caller sees.
  if (locationName) {
    await assertSerpLocationNameAccepted({
      locationName,
      languageCode,
      countryCode: getIsoCountryCode(locationCode),
    });
  }

  const existing =
    await RankTrackingRepository.getConfigByProjectDomainLocation(
      input.projectId,
      normalizedDomain,
      locationCode,
      locationName,
    );
  // The (project, domain, location) row still exists when a domain is
  // archived — archiving only flips isActive to false. So re-adding an
  // archived domain reactivates that row (keeping its keyword/ranking
  // history) with the freshly chosen settings, rather than colliding with
  // the unique index. An already-active row is a genuine duplicate.
  if (existing?.isActive) {
    throw new AppError(
      "VALIDATION_ERROR",
      locationName
        ? "This domain + city combination is already being tracked"
        : "This domain + country combination is already being tracked",
    );
  }

  // Enforced for reactivations too, not just new rows — otherwise archiving
  // and re-adding domains would push a project past the active-config cap.
  const allConfigs = await RankTrackingRepository.getConfigsForProject(
    input.projectId,
  );
  if (allConfigs.length >= MAX_CONFIGS_PER_PROJECT) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Maximum ${MAX_CONFIGS_PER_PROJECT} tracked domains per project`,
    );
  }

  if (existing) {
    await RankTrackingRepository.updateConfig(existing.id, input.projectId, {
      isActive: true,
      languageCode,
      devices,
      searchProvider,
      serpDepth: input.serpDepth,
      scheduleInterval,
      nextCheckAt,
      // Drop any stale skip reason from before it was archived so the
      // re-added domain doesn't surface an outdated warning.
      lastSkipReason: null,
    });

    return getValidatedConfig(existing.id, input.projectId);
  }

  const configId = crypto.randomUUID();
  const config: RankTrackingConfig = {
    id: configId,
    projectId: input.projectId,
    domain: normalizedDomain,
    locationCode,
    languageCode,
    locationName,
    devices,
    searchProvider,
    serpDepth: input.serpDepth,
    scheduleInterval,
    nextCheckAt,
    isActive: true,
    lastCheckedAt: null,
    lastSkipReason: null,
    createdAt: toRankTrackingTimestamp(new Date()),
  };

  await RankTrackingRepository.createConfig(config);

  return config;
}

async function updateConfig(
  configId: string,
  projectId: string,
  input: {
    domain?: string;
    locationCode?: number;
    languageCode?: string;
    locationName?: string | null;
    searchProvider?: RankTrackingConfig["searchProvider"];
    devices?: RankTrackingConfig["devices"];
    serpDepth?: number;
    scheduleInterval?: RankTrackingConfig["scheduleInterval"];
    scheduleTime?: RankCheckScheduleTime;
    isActive?: boolean;
  },
) {
  const { scheduleTime, ...fields } = input;
  const updates: typeof fields & { nextCheckAt?: string | null } = {};
  const existing = await getValidatedConfig(configId, projectId);
  const targetingChanged =
    input.searchProvider !== undefined ||
    input.devices !== undefined ||
    input.locationName !== undefined ||
    input.locationCode !== undefined ||
    input.languageCode !== undefined ||
    input.isActive === true;
  if (targetingChanged) {
    assertRankTargeting(
      input.searchProvider ?? existing.searchProvider,
      input.devices ?? existing.devices,
      input.locationName === undefined
        ? existing.locationName
        : input.locationName,
      (await getScopedProviderExecution())?.provider,
      input.languageCode ?? existing.languageCode,
    );
  }

  // A location name is only valid together with its market, so re-check the
  // resulting (name, language, country) whenever any of the three changes.
  const marketChanged =
    input.locationName !== undefined ||
    input.locationCode !== undefined ||
    input.languageCode !== undefined;
  if (marketChanged) {
    const locationName =
      input.locationName === undefined
        ? existing.locationName
        : input.locationName;
    if (locationName) {
      await assertSerpLocationNameAccepted({
        locationName,
        languageCode: input.languageCode ?? existing.languageCode,
        countryCode: getIsoCountryCode(
          input.locationCode ?? existing.locationCode,
        ),
      });
    }
  }

  if (input.domain !== undefined)
    updates.domain = normalizeDomain(input.domain);
  if (input.locationCode !== undefined)
    updates.locationCode = input.locationCode;
  if (input.languageCode !== undefined)
    updates.languageCode = input.languageCode;
  if (input.locationName !== undefined)
    updates.locationName = input.locationName;
  if (input.devices !== undefined) updates.devices = input.devices;
  if (input.searchProvider !== undefined)
    updates.searchProvider = input.searchProvider;
  if (input.serpDepth !== undefined) updates.serpDepth = input.serpDepth;
  if (input.isActive !== undefined) updates.isActive = input.isActive;

  const scheduleInterval = input.scheduleInterval ?? existing.scheduleInterval;
  // The config modal resends the interval on every save, so only move the
  // anchor when the schedule really changed — otherwise editing, say, devices
  // would re-randomize the run time.
  if (
    scheduleTime ||
    scheduleInterval !== existing.scheduleInterval ||
    (scheduleInterval !== "manual" && !existing.nextCheckAt)
  ) {
    updates.scheduleInterval = scheduleInterval;
    updates.nextCheckAt = await resolveNextCheckAt(
      scheduleInterval,
      scheduleTime,
    );
  }

  await RankTrackingRepository.updateConfig(configId, projectId, updates);
}

function normalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase();
  // Strip protocol
  d = d.replace(/^https?:\/\//, "");
  // Strip path, query string, and fragment
  d = d.replace(/[/?#].*$/, "");
  // Strip trailing slash
  d = d.replace(/\/+$/, "");
  // Strip www. prefix
  d = d.replace(/^www\./, "");
  if (!d) {
    throw new AppError("INTERNAL_ERROR", "Invalid domain");
  }
  return d;
}

async function getValidatedConfig(configId: string, projectId: string) {
  const config = await RankTrackingRepository.getConfigById({
    configId,
    projectId,
  });
  if (!config) {
    throw new AppError("NOT_FOUND", "Rank tracking config not found");
  }
  return config;
}

export const RankTrackingConfigService = {
  createConfig,
  updateConfig,
  getConfig: getValidatedConfig,
};

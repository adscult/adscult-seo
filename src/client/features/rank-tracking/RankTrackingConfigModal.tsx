import {
  RankTrackingSourceField,
  LANGUAGE_ITEMS,
  DEVICE_ITEMS,
  DEPTH_ITEMS,
} from "./RankTrackingConfigFields";
import { RankTrackingCostEstimate } from "./RankTrackingCostEstimate";
import { organizationContextQueryOptions } from "@/client/features/team/organizationQueries";
import { seoProviderStatusQueryOptions } from "@/client/features/settings/providerQueries";
import { useId, useState } from "react";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";
import { useQuery } from "@tanstack/react-query";
import { revalidateLogic, useStore } from "@tanstack/react-form";
import { Info } from "lucide-react";
import { useAppForm } from "@/client/components/form/useAppForm";
import { CountryCombobox } from "@/client/components/CountryCombobox";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { Field, FieldLabel } from "@/client/components/ui/field";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import { domainField, normalizeDomain } from "@/types/schemas/domain";
import { getLanguageCode } from "@/client/features/keywords/locations";
import { getIsoCountryCode } from "@/shared/keyword-locations";
import type { ProjectMarket } from "@/client/features/projects/types";
import { QueryError } from "@/client/components/QueryState";
import { Spinner } from "@/client/components/Spinner";
import { getFieldError } from "@/client/lib/forms";
import { SearchTargetingField } from "./SearchTargetingField";
import { KeywordSuggestionStep } from "./KeywordSuggestionStep";
import {
  useSaveConfigMutations,
  type SaveConfigInput,
} from "./useSaveConfigMutations";
import { ScheduleField } from "./ScheduleField";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { SCHEDULED_RANK_CHECKS_PAUSED } from "@/shared/rank-tracking-pause";
import {
  localScheduleTimeFrom,
  randomScheduleDate,
  withBrowserTimeZone,
  type LocalScheduleTime,
} from "./scheduleTime";

type Props = {
  projectId: string;
  existingConfig?: RankTrackingConfig | null;
  onClose: () => void;
  onSaved: (createdConfigId?: string) => void;
  onConfigCreated?: () => void;
};

type ConfigFormValues = Omit<SaveConfigInput, "scheduleTime"> & {
  scheduleTime: LocalScheduleTime;
};

function validateConfig(values: ConfigFormValues) {
  const fields: Partial<Record<keyof ConfigFormValues, string>> = {};
  if (!values.domain.trim()) {
    fields.domain = "Enter a domain";
  } else if (!domainField.safeParse(values.domain).success) {
    fields.domain = "Enter a valid domain, like example.com";
  }
  if (values.searchProvider === "anyapi" && values.languageCode.length !== 2)
    fields.languageCode = "Choose a supported AnyAPI language";
  if (values.targetingMode === "local" && !values.locationName) {
    fields.locationName = "Select a city or region for local targeting";
  }
  return Object.keys(fields).length > 0 ? { fields } : undefined;
}

export function RankTrackingConfigModal({
  projectId,
  existingConfig,
  onClose,
  onSaved,
  onConfigCreated,
}: Props) {
  // A new domain starts from the project's market, so it waits for projects.
  const projectsQuery = useQuery({
    ...projectsQueryOptions(),
    enabled: !existingConfig,
  });
  const organization = useQuery(organizationContextQueryOptions());
  const providerStatus = useQuery(
    seoProviderStatusQueryOptions(organization.data?.organizationId),
  );
  const initialMarket =
    existingConfig ??
    projectsQuery.data?.find((project) => project.id === projectId);

  if (!initialMarket || !providerStatus.data || providerStatus.isError) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="sr-only">Add Domain</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-40 items-center justify-center">
            {projectsQuery.isPending || providerStatus.isPending ? (
              <Spinner />
            ) : (
              <QueryError
                error={providerStatus.error ?? projectsQuery.error}
                fallback="Failed to load the project."
                onRetry={() => {
                  void projectsQuery.refetch();
                  void providerStatus.refetch();
                }}
                isRetrying={projectsQuery.isFetching}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <RankTrackingConfigModalContent
      projectId={projectId}
      existingConfig={existingConfig}
      initialMarket={initialMarket}
      activeProvider={providerStatus.data.provider}
      onClose={onClose}
      onSaved={onSaved}
      onConfigCreated={onConfigCreated}
    />
  );
}

function RankTrackingConfigModalContent({
  projectId,
  existingConfig,
  initialMarket,
  activeProvider,
  onClose,
  onSaved,
  onConfigCreated,
}: Props & {
  initialMarket: ProjectMarket;
  activeProvider: "treg" | "dataforseo" | null;
}) {
  const countryId = useId();
  const isEdit = !!existingConfig;
  const scheduledChecksPaused =
    SCHEDULED_RANK_CHECKS_PAUSED && isHostedClientAuthMode();
  const [createdConfigId, setCreatedConfigId] = useState<string>();
  // An untouched edit leaves the stored run time alone; anything that changes
  // the schedule sends the time on screen so it is the one that gets saved.
  const [scheduleTimeEdited, setScheduleTimeEdited] = useState(false);

  const { createMutation, updateMutation } = useSaveConfigMutations({
    projectId,
    existingConfig,
    onCreated: (configId) => {
      setCreatedConfigId(configId);
      onConfigCreated?.();
    },
    onUpdated: () => onSaved(),
  });

  // Built once: the schedule default is random, and new default values would
  // reset the form on every render.
  const [defaultValues] = useState<ConfigFormValues>(() => ({
    domain: existingConfig?.domain ?? "",
    locationCode: existingConfig?.locationCode ?? initialMarket.locationCode,
    languageCode: existingConfig?.languageCode ?? initialMarket.languageCode,
    targetingMode: existingConfig?.locationName ? "local" : "national",
    locationName: existingConfig?.locationName ?? undefined,
    searchProvider:
      existingConfig?.searchProvider ??
      (activeProvider === "treg" ? "anyapi" : "dataforseo"),
    devices:
      existingConfig?.devices ??
      (activeProvider === "treg" ? "provider" : "mobile"),
    schedule:
      existingConfig?.scheduleInterval ??
      (scheduledChecksPaused ? "manual" : "weekly"),
    // Shown and edited in the browser's timezone; the server converts it to UTC.
    scheduleTime: localScheduleTimeFrom(
      existingConfig?.nextCheckAt
        ? new Date(existingConfig.nextCheckAt)
        : randomScheduleDate(),
    ),
    serpDepth: existingConfig?.serpDepth ?? 40,
  }));

  const form = useAppForm({
    defaultValues,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: ({ value }) => validateConfig(value) },
    onSubmit: async ({ value, formApi }) => {
      const domain = domainField.parse(value.domain);
      formApi.setFieldValue("domain", domain);
      const sendScheduleTime =
        value.schedule !== "manual" &&
        (!existingConfig ||
          scheduleTimeEdited ||
          value.schedule !== existingConfig.scheduleInterval);
      const input: SaveConfigInput = {
        ...value,
        domain,
        scheduleTime: sendScheduleTime
          ? withBrowserTimeZone(value.scheduleTime)
          : undefined,
      };
      await (isEdit
        ? updateMutation.mutateAsync(input)
        : createMutation.mutateAsync(input));
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);

  const closeKeywordStep = () => onSaved(createdConfigId);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || isSubmitting) return;
        if (createdConfigId) closeKeywordStep();
        else onClose();
      }}
    >
      <DialogContent
        showCloseButton={!!createdConfigId}
        className={createdConfigId ? "sm:max-w-3xl" : "sm:max-w-lg"}
      >
        {createdConfigId ? (
          <KeywordSuggestionStep
            configId={createdConfigId}
            projectId={projectId}
            domain={values.domain}
            locationCode={values.locationCode}
            onDone={onSaved}
            onClose={closeKeywordStep}
          />
        ) : (
          <form.AppForm>
            <form.Form className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>
                  {isEdit ? "Edit Domain Config" : "Add Domain"}
                </DialogTitle>
              </DialogHeader>

              <form.AppField
                name="domain"
                listeners={{
                  onBlur: ({ value }) => {
                    try {
                      form.setFieldValue("domain", normalizeDomain(value), {
                        dontValidate: true,
                      });
                    } catch {
                      // Keep invalid partial input editable; submit shows the error.
                    }
                  },
                }}
              >
                {(field) => (
                  <field.TextField
                    label="Target Domain"
                    placeholder="example.com"
                  />
                )}
              </form.AppField>

              <RankTrackingSourceField
                value={values.searchProvider}
                activeProvider={activeProvider}
                onChange={(source) => {
                  form.setFieldValue("searchProvider", source);
                  form.setFieldValue(
                    "devices",
                    source === "anyapi" ? "provider" : "mobile",
                  );
                  if (source === "anyapi") {
                    form.setFieldValue("targetingMode", "national");
                    form.setFieldValue("locationName", undefined);
                  }
                }}
              />
              <Field>
                <FieldLabel htmlFor={countryId}>Country</FieldLabel>
                <CountryCombobox
                  id={countryId}
                  value={values.locationCode}
                  onChange={(locationCode) => {
                    form.setFieldValue("locationCode", locationCode);
                    form.setFieldValue(
                      "languageCode",
                      getLanguageCode(locationCode),
                    );
                    // A picked city belongs to the previous country.
                    form.setFieldValue("locationName", undefined);
                  }}
                />
              </Field>

              {values.searchProvider !== "anyapi" && (
                <form.Field name="locationName">
                  {(field) => (
                    <SearchTargetingField
                      mode={values.targetingMode}
                      onModeChange={(mode) =>
                        form.setFieldValue("targetingMode", mode)
                      }
                      locationName={field.state.value}
                      onLocationNameChange={field.handleChange}
                      countryCode={getIsoCountryCode(values.locationCode)}
                      error={
                        getFieldError(field.state.meta.errors) ?? undefined
                      }
                    />
                  )}
                </form.Field>
              )}

              <form.AppField name="languageCode">
                {(field) => (
                  <field.SelectField
                    label="Language"
                    items={
                      values.searchProvider === "anyapi"
                        ? LANGUAGE_ITEMS.filter(
                            (item) => item.value.length === 2,
                          )
                        : LANGUAGE_ITEMS
                    }
                    description="Defaults to the country's language. Any language can be tracked in any country — pick the one your customers search in."
                  />
                )}
              </form.AppField>

              {values.searchProvider === "anyapi" ? (
                <p className="text-sm text-muted-foreground">
                  Device: provider-managed. Results are stored separately from
                  desktop and mobile history. Checks can take several minutes.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <form.AppField name="devices">
                    {(field) => (
                      <field.SelectField
                        label="Devices"
                        items={DEVICE_ITEMS}
                        description="Most Google searches come from mobile, but select this based on your customer."
                      />
                    )}
                  </form.AppField>
                  {values.devices === "both" && (
                    <p className="flex items-start gap-1.5 text-xs text-info">
                      <Info className="mt-0.5 size-3.5 shrink-0" />
                      Tracking both devices uses 2x credits per keyword check
                    </p>
                  )}
                </div>
              )}

              <ScheduleField
                schedule={values.schedule}
                onScheduleChange={(schedule) =>
                  form.setFieldValue("schedule", schedule)
                }
                scheduleTime={values.scheduleTime}
                onScheduleTimeChange={(time) => {
                  form.setFieldValue("scheduleTime", time);
                  setScheduleTimeEdited(true);
                }}
                scheduledChecksPaused={scheduledChecksPaused}
              />

              <form.AppField name="serpDepth">
                {(field) => (
                  <field.SelectField
                    label="Search Depth"
                    items={DEPTH_ITEMS}
                    description={
                      values.searchProvider === "anyapi"
                        ? "AnyAPI reads pages until this depth or your domain is found. Each page is billed separately."
                        : "10 pages is ~8x more expensive than 1 page"
                    }
                  />
                )}
              </form.AppField>

              <RankTrackingCostEstimate
                useLivePricing={activeProvider === "treg"}
                searchProvider={values.searchProvider}
                devices={values.devices}
                serpDepth={values.serpDepth}
                schedule={values.schedule}
              />

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <form.SubmitButton>
                  {isEdit ? "Save Changes" : "Add Domain"}
                </form.SubmitButton>
              </DialogFooter>
            </form.Form>
          </form.AppForm>
        )}
      </DialogContent>
    </Dialog>
  );
}

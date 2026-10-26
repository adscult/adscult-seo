import { Field, FieldLabel } from "@/client/components/ui/field";
import { SERP_LANGUAGE_OPTIONS } from "@/shared/keyword-locations";
import { pagesToDepth } from "@/shared/rank-tracking";
import type { SaveConfigInput } from "./useSaveConfigMutations";

export const LANGUAGE_ITEMS = SERP_LANGUAGE_OPTIONS.map((language) => ({
  value: language.code,
  label: language.label,
}));

export const DEVICE_ITEMS: {
  value: SaveConfigInput["devices"];
  label: string;
}[] = [
  { value: "both", label: "Desktop + Mobile" },
  { value: "desktop", label: "Desktop only" },
  { value: "mobile", label: "Mobile only" },
];

export const DEPTH_ITEMS = Array.from({ length: 10 }, (_, i) => i + 1).map(
  (pages) => ({
    value: pagesToDepth(pages),
    label: `${pages} ${pages === 1 ? "page" : "pages"} (top ${pages * 10} results)`,
  }),
);

export function RankTrackingSourceField({
  value,
  activeProvider,
  onChange,
}: {
  value: SaveConfigInput["searchProvider"];
  activeProvider: "treg" | "dataforseo" | null;
  onChange: (source: SaveConfigInput["searchProvider"]) => void;
}) {
  if (activeProvider !== "treg" && value !== "anyapi") return null;
  return (
    <Field>
      <FieldLabel htmlFor="rank-search-provider">
        Rank source through Treg
      </FieldLabel>
      <select
        id="rank-search-provider"
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        value={value}
        onChange={(event) =>
          onChange(event.target.value === "anyapi" ? "anyapi" : "dataforseo")
        }
      >
        <option value="anyapi" disabled={activeProvider !== "treg"}>
          AnyAPI (default; requires Treg)
        </option>
        <option value="dataforseo">DataForSEO</option>
      </select>
      <p className="text-xs text-muted-foreground">
        Saved for this tracker. AnyAPI uses country targeting and its own
        device. Choose DataForSEO for city or desktop/mobile tracking. Ranking
        requests use this source; keyword metrics still use DataForSEO. Calls
        never fall back to another source.
      </p>
    </Field>
  );
}

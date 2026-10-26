import { estimateRankCheckCredits } from "@/shared/rank-tracking";
import type { SaveConfigInput } from "./useSaveConfigMutations";

export function RankTrackingCostEstimate({
  useLivePricing,
  devices,
  searchProvider,
  serpDepth,
  schedule,
}: Pick<
  SaveConfigInput,
  "devices" | "serpDepth" | "schedule" | "searchProvider"
> & { useLivePricing: boolean }) {
  // Direct DataForSEO schedules use queue prices; Treg checks use live routes.
  const { costUsd: costPerKeyword } = estimateRankCheckCredits(
    ["plain keyword"],
    devices,
    serpDepth,
    schedule === "manual" || useLivePricing ? "live" : "queued",
  );
  const checksPerMonth =
    schedule === "daily" ? 30 : schedule === "weekly" ? 4 : 1;
  return (
    <div className="space-y-0.5 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
      <div>
        <span className="font-mono font-semibold text-foreground">
          ~${costPerKeyword.toFixed(4)}
        </span>{" "}
        {searchProvider === "anyapi"
          ? "maximum per keyword per check; actual cost is usually lower"
          : "per keyword per check"}
      </div>
      {schedule !== "manual" && (
        <div>
          50 keywords would cost{" "}
          <span className="font-mono font-semibold text-foreground">
            ~${(costPerKeyword * 50 * checksPerMonth).toFixed(2)}
          </span>
          /month
        </div>
      )}
    </div>
  );
}

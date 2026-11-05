import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";

const preferenceSchema = z.object({
  model: z.string(),
  models: z.array(z.string()),
  labels: z.record(z.string(), z.string()),
  groups: z.array(z.object({ label: z.string(), models: z.array(z.string()) })),
});

export function useSamModelPreference(sessionId: string) {
  const queryClient = useQueryClient();
  const queryKey = ["samModel", sessionId];
  const request = async (model?: string) => {
    const response = await fetch(
      `/agents/sam-chat/${sessionId}/model`,
      model === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model }),
          },
    );
    if (!response.ok) {
      const error = z
        .object({ error: z.string() })
        .safeParse(await response.json().catch(() => null));
      throw new Error(
        error.success
          ? error.data.error
          : "Could not load the model selection. Try again.",
      );
    }
    return preferenceSchema.parse(await response.json());
  };
  const query = useQuery({ queryKey, queryFn: () => request(), staleTime: 0 });
  const mutation = useMutation({
    mutationFn: (model: string) => request(model),
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });
  return { query, mutation };
}

export function SamModelSelector({
  preference,
  busy,
  compact = false,
}: {
  preference: ReturnType<typeof useSamModelPreference>;
  busy: boolean;
  compact?: boolean;
}) {
  const { query, mutation } = preference;
  const data = query.data;
  return (
    <div
      className={compact ? "min-w-0 flex-1 space-y-1.5" : "mb-2 space-y-1.5"}
    >
      <div className="flex min-h-7 items-center gap-2">
        <span className={compact ? "sr-only" : "text-xs text-muted-foreground"}>
          Model
        </span>
        {data ? (
          <Select
            value={data.model}
            disabled={busy || mutation.isPending}
            onValueChange={(value) => {
              if (typeof value === "string" && value !== data.model)
                mutation.mutate(value);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="SAM model"
              title={data.model}
              className={
                compact
                  ? "min-w-0 max-w-64 border-transparent bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:text-foreground"
                  : "min-w-0 max-w-sm flex-1 text-xs"
              }
            >
              <SelectValue className="truncate">
                {data.labels[data.model] ?? data.model}
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              side="top"
              align="start"
              sideOffset={8}
              alignItemWithTrigger={false}
              className="min-w-60 max-w-(--available-width)"
            >
              {data.groups.map((group) => (
                <SelectGroup key={group.label}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.models.map((model) => (
                    <SelectItem
                      key={model}
                      value={model}
                      className="[&>span:first-child]:min-w-0 [&>span:first-child]:shrink"
                    >
                      <span className="truncate" title={model}>
                        {data.labels[model] ?? model}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        ) : query.isError ? (
          <Button
            variant="ghost"
            size="sm"
            pending={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry loading models
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground" role="status">
            Loading models…
          </span>
        )}
        {mutation.isPending && (
          <span className="text-xs text-muted-foreground" role="status">
            Saving…
          </span>
        )}
      </div>
      {mutation.isError && (
        <p className="text-xs text-destructive" role="alert">
          {mutation.error.message}
        </p>
      )}
      {query.isError && (
        <p className="text-xs text-destructive" role="alert">
          {query.error.message}
        </p>
      )}
    </div>
  );
}

import { useState } from "react";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { GitCompareArrows } from "lucide-react";
import { PageHeader } from "@/client/components/PageHeader";
import { EmptyState } from "@/client/components/EmptyState";
import { QueryState, QueryError } from "@/client/components/QueryState";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";
import { Textarea } from "@/client/components/ui/textarea";
import { getProjectContext } from "@/serverFunctions/projectContext";
import { getProjectAccess } from "@/serverFunctions/projects";
import { compareSitemaps } from "@/serverFunctions/pageGaps";
import { pageGapInputSchema } from "@/types/schemas/page-gaps";
import type { PageGapComparison } from "@/types/schemas/page-gaps";
import { PageGapResults } from "./PageGapResults";

export function PageGapsPage({ projectId }: { projectId: string }) {
  const defaults = useQuery({
    queryKey: ["pageGapDefaults", projectId],
    queryFn: async () => {
      const [project, context] = await Promise.all([
        getProjectAccess({ data: { projectId } }),
        getProjectContext({ data: { projectId } }),
      ]);
      return {
        website: project.domain ?? "",
        competitors: context.competitors.slice(0, 3).map((site) => site.domain),
      };
    },
  });
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
      <PageHeader
        title="Page gaps"
        description="Compare sitemap topics and find pages to consider creating."
      />
      <QueryState
        query={defaults}
        errorFallback="Could not load your website and competitors"
      >
        {(data) => (
          <ComparisonForm
            key={projectId}
            projectId={projectId}
            defaults={data}
          />
        )}
      </QueryState>
    </div>
  );
}

function ComparisonForm({
  projectId,
  defaults,
}: {
  projectId: string;
  defaults: { website: string; competitors: string[] };
}) {
  const client = useQueryClient();
  const queryKey = ["pageGaps", projectId];
  const saved = useQuery<PageGapComparison>({
    queryKey,
    queryFn: skipToken,
    gcTime: 60 * 60 * 1000,
  });
  const [website, setWebsite] = useState(
    saved.data?.website.origin ?? defaults.website,
  );
  const [competitors, setCompetitors] = useState(
    (
      saved.data?.competitors.map((site) => site.origin) ?? defaults.competitors
    ).join("\n"),
  );
  const [validation, setValidation] = useState("");
  const comparison = useMutation({
    mutationFn: (data: typeof pageGapInputSchema._output) =>
      compareSitemaps({ data }),
    onSuccess: (data) => client.setQueryData(queryKey, data),
  });
  const results = comparison.data ?? saved.data;
  return (
    <div className="space-y-6">
      <form
        className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          const input = pageGapInputSchema.safeParse({
            projectId,
            website,
            competitors: competitors
              .split(/[\n,]+/)
              .map((site) => site.trim())
              .filter(Boolean),
          });
          if (!input.success) {
            setValidation(
              "Enter your website and one to three competitor domains, one per line.",
            );
            return;
          }
          setValidation("");
          comparison.mutate(input.data);
        }}
      >
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="page-gap-website">Your website</Label>
            <Input
              id="page-gap-website"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="example.com"
              required
              maxLength={2048}
              disabled={comparison.isPending}
            />
            <p className="text-xs text-muted-foreground">
              Use the domain homepage. Sitemaps are discovered automatically.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="page-gap-competitors">Competitor websites</Label>
            <Textarea
              id="page-gap-competitors"
              value={competitors}
              onChange={(event) => setCompetitors(event.target.value)}
              placeholder={"competitor-one.com\ncompetitor-two.com"}
              rows={3}
              required
              maxLength={6200}
              disabled={comparison.isPending}
            />
            <p className="text-xs text-muted-foreground">
              Up to three domains, one per line. Starts with your saved
              competitors.
            </p>
          </div>
        </div>
        {validation && (
          <p role="alert" className="text-sm text-destructive">
            {validation}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" pending={comparison.isPending}>
            <GitCompareArrows />
            {comparison.isPending ? "Comparing sitemaps…" : "Compare sitemaps"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Public sitemaps · No paid API calls
          </span>
        </div>
      </form>
      {comparison.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Reading sitemap indexes and comparing page topics. Larger sites may
          take about a minute.
        </p>
      )}
      {comparison.isError && (
        <QueryError
          error={comparison.error}
          fallback="Comparison failed. Check the domains and try again."
          onRetry={() =>
            comparison.variables && comparison.mutate(comparison.variables)
          }
        />
      )}
      {results && (
        <div className={comparison.isPending ? "opacity-60" : ""}>
          <PageGapResults key={results.checkedAt} data={results} />
        </div>
      )}
      {!results && !comparison.isPending && !comparison.isError && (
        <EmptyState
          icon={GitCompareArrows}
          title="Find the gaps in your page coverage"
          description="Compare your public sitemap with competitors. Review suggested topics, the pages supporting them, and similar pages you already have."
        />
      )}
    </div>
  );
}

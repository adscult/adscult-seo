import { useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { EmptyState } from "@/client/components/EmptyState";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableCard,
} from "@/client/components/ui/table";
import { exportRows } from "@/client/lib/exportRows";
import type { PageGapComparison, SitemapSite } from "@/types/schemas/page-gaps";

function SiteCoverage({
  site,
  own = false,
}: {
  site: SitemapSite;
  own?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span className="break-all">
        {new URL(site.origin).hostname}
        {own ? " (your website)" : ""}
      </span>
      <span className="text-muted-foreground">
        {site.status === "unavailable"
          ? "Sitemap unavailable"
          : `${site.pageCount.toLocaleString()} pages${site.status === "partial" ? " · Partial coverage" : ""}`}
      </span>
    </li>
  );
}

export function PageGapResults({ data }: { data: PageGapComparison }) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("All page types");
  const [rival, setRival] = useState("");
  const [visible, setVisible] = useState(25);
  const gaps = data.gaps.filter(
    (gap) =>
      (kind === "All page types" || gap.kind === kind) &&
      (!rival || gap.competitors.some((site) => site.origin === rival)) &&
      `${gap.topic} ${gap.suggestedPath}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const limited = [data.website, ...data.competitors].some(
    (site) => site.status !== "available",
  );
  return (
    <section className="space-y-5" aria-label="Sitemap comparison results">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Pages to consider</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.totalGaps.toLocaleString()} candidate topics ·{" "}
            {data.coveredTopics.toLocaleString()} matched on your site · Checked{" "}
            {new Date(data.checkedAt).toLocaleString()}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={!gaps.length}
          onClick={() =>
            void exportRows({
              format: "csv",
              feature: "page-gaps",
              filename: "page-gaps",
              headers: [
                "Topic",
                "Page type",
                "Suggested path",
                "Competitor coverage",
                "Evidence URLs",
                "Similar own page",
                "Coverage",
              ],
              rows: gaps.map((gap) => [
                gap.topic,
                gap.kind,
                gap.suggestedPath,
                gap.competitors.length,
                gap.competitors.map((site) => site.url).join("\n"),
                gap.similarPage,
                limited ? "Partial sitemap coverage" : "Available sitemaps",
              ]),
            })
          }
        >
          <Download />
          Export CSV
        </Button>
      </div>
      <details
        className="rounded-lg border border-border px-4 py-3"
        open={limited}
      >
        <summary className="cursor-pointer text-sm font-medium">
          Sitemap coverage{limited ? " · Review limitations" : ""}
        </summary>
        <ul className="mt-2 divide-y">
          <SiteCoverage site={data.website} own />
          {data.competitors.map((site) => (
            <SiteCoverage key={site.origin} site={site} />
          ))}
        </ul>
        <p className="mt-2 max-w-prose text-xs text-muted-foreground">
          Reads up to 5,000 URLs and 20 sitemap documents per site. Blocked,
          missing, oversized, timed-out or skipped documents can leave gaps in
          coverage. Pages outside a sitemap are not included.
        </p>
      </details>
      <p className="max-w-prose text-sm text-muted-foreground">
        Suggestions compare URL wording, not page content or search demand. More
        competitor coverage is a stronger reason to review a topic. Category and
        content opportunities appear before individual products. Check relevance
        and existing pages before creating anything.
      </p>
      {data.website.status === "unavailable" ? (
        <EmptyState
          kind="error"
          title="Your sitemap could not be read"
          description="No page suggestions were generated. Check that your website has a public sitemap.xml or a sitemap listed in robots.txt, then compare again."
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Filter suggested topics"
              placeholder="Filter topics or paths…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setVisible(25);
              }}
              className="sm:max-w-xs"
            />
            <select
              aria-label="Page type"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setVisible(25);
              }}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {[
                "All page types",
                "Category",
                "Product",
                "Content",
                "Service",
                "Other",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <select
              aria-label="Competitor"
              value={rival}
              onChange={(event) => {
                setRival(event.target.value);
                setVisible(25);
              }}
              className="h-10 max-w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All competitors</option>
              {data.competitors.map((site) => (
                <option key={site.origin} value={site.origin}>
                  {new URL(site.origin).hostname}
                </option>
              ))}
            </select>
          </div>
          {!gaps.length ? (
            <EmptyState
              kind={data.gaps.length ? "filtered" : "no-data"}
              title={
                data.competitors.every((site) => site.status === "unavailable")
                  ? "Competitor sitemaps could not be read"
                  : data.gaps.length
                    ? "No topics match these filters"
                    : "No candidate gaps found in the available URLs"
              }
              description="Try different competitors or filters. Matching URLs do not prove that all topics are covered in your content."
            />
          ) : (
            <TableCard>
              <Table className="min-w-[760px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Suggested page</TableHead>
                    <TableHead>Competitor evidence</TableHead>
                    <TableHead>Your coverage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gaps.slice(0, visible).map((gap) => (
                    <TableRow key={`${gap.kind}:${gap.topic}`}>
                      <TableCell className="max-w-sm align-top">
                        <div className="font-medium capitalize">
                          {gap.topic}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {gap.kind}
                        </div>
                        <div className="mt-2 break-all text-xs">
                          Suggested path: {gap.suggestedPath}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="mb-2 text-xs text-muted-foreground">
                          {gap.competitors.length} of{" "}
                          {
                            data.competitors.filter(
                              (site) => site.status !== "unavailable",
                            ).length
                          }{" "}
                          readable competitors
                        </div>
                        <ul className="space-y-2">
                          {gap.competitors.map((site) => (
                            <li key={site.origin}>
                              <a
                                href={site.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex max-w-xs items-start gap-1 break-all text-primary underline-offset-4 hover:underline"
                              >
                                {new URL(site.url).hostname +
                                  new URL(site.url).pathname}
                                <ExternalLink
                                  className="mt-1 size-3 shrink-0"
                                  aria-hidden
                                />
                              </a>
                            </li>
                          ))}
                        </ul>
                      </TableCell>
                      <TableCell className="max-w-xs align-top">
                        <span className="text-sm">
                          {gap.similarPage
                            ? "Review an existing page first"
                            : "No matching URL topic found"}
                        </span>
                        {gap.similarPage && (
                          <a
                            href={gap.similarPage}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 block break-all text-primary underline-offset-4 hover:underline"
                          >
                            {new URL(gap.similarPage).pathname}
                          </a>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
                <span>
                  Showing {Math.min(visible, gaps.length)} of {gaps.length}{" "}
                  loaded suggestions
                  {data.totalGaps > data.gaps.length
                    ? ` (top ${data.gaps.length} of ${data.totalGaps} candidates)`
                    : ""}
                </span>
                {visible < gaps.length && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setVisible((count) => count + 25)}
                  >
                    Show more
                  </Button>
                )}
              </div>
            </TableCard>
          )}
        </>
      )}
    </section>
  );
}

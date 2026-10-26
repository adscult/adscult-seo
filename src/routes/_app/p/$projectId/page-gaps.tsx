import { createFileRoute } from "@tanstack/react-router";
import { PageGapsPage } from "@/client/features/page-gaps/PageGapsPage";

export const Route = createFileRoute("/_app/p/$projectId/page-gaps")({
  component: PageGapsRoute,
});

function PageGapsRoute() {
  const { projectId } = Route.useParams();
  return <PageGapsPage key={projectId} projectId={projectId} />;
}

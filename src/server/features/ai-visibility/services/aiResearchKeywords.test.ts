import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBatch } from "@/db/runBatch";

const {
  listCompetitors,
  listResearchKeywords,
  research,
  workflow,
  prepareWebsiteTracking,
  startWebsiteTrackingRun,
  openRouterKey,
} = vi.hoisted(() => ({
  listCompetitors: vi.fn(),
  listResearchKeywords: vi.fn(),
  research: vi.fn(),
  workflow: { get: vi.fn(), create: vi.fn() },
  prepareWebsiteTracking: vi.fn(),
  startWebsiteTrackingRun: vi.fn(),
  openRouterKey: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { AI_VISIBILITY_WORKFLOW: workflow },
}));

vi.mock("@/db/runBatch", () => ({ runBatch: vi.fn() }));
vi.mock("../repositories/aiResearchKeywordSources", () => ({
  listAiResearchKeywordSources: async () => ({
    saved: ["saved term"],
    tracked: ["tracked term"],
  }),
}));
vi.mock("@/server/billing/subscription", () => ({
  checkUsageCreditsDepleted: vi.fn(),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => false,
  getOptionalEnvValue: openRouterKey,
}));
vi.mock("../repositories/aiVisibilityConfigurationRepository", () => ({
  writeConfiguration: vi.fn(),
  writeResearchKeywords: vi.fn(),
}));
vi.mock("./websiteTrackingSetup", () => ({
  prepareWebsiteTracking,
  startWebsiteTrackingRun,
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: async () => ({
      id: "project",
      name: "OpenSEO",
      domain: "openseo.so",
      locationCode: 2840,
      languageCode: "en",
    }),
  },
}));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({
    ProjectContextRepository: {
      listSections: async () => [
        { key: "business_overview", content: "SEO tools." },
      ],
      listCompetitors,
    },
  }),
);
vi.mock("../repositories/AiVisibilityRepository", () => ({
  AiVisibilityRepository: { listResearchKeywords },
}));
vi.mock("@/server/features/projects/services/websiteResearch", () => ({
  researchWebsite: research,
}));

import {
  getAiResearchSetup,
  runAiResearchSetup,
  startAiResearchSetup,
} from "./aiResearchKeywords";
import { customer } from "./aiVisibilityTestFixtures";

const topic = (name: string) => ({ name, prompts: [] });

beforeEach(() => {
  openRouterKey.mockResolvedValue("configured-test-key");
});

describe("runAiResearchSetup", () => {
  beforeEach(() => {
    listResearchKeywords.mockResolvedValue([]);
    listCompetitors.mockResolvedValue([]);
    prepareWebsiteTracking.mockResolvedValue(null);
    research.mockResolvedValue({
      name: "OpenSEO",
      domain: "openseo.so",
      overview: "SEO tools.",
      competitors: [
        {
          name: "Ahrefs",
          domain: "ahrefs.com",
          notes: "SEO suite.",
          sourceUrl: "https://ahrefs.com/",
        },
      ],
      suggestedTopics: ["rank tracker", "seo tool"].map(topic),
      suggestedKeywords: [],
    });
  });

  it("does nothing when keywords were saved meanwhile", async () => {
    listResearchKeywords.mockResolvedValue(["rank tracker"]);

    await expect(
      runAiResearchSetup({ projectId: "project" }, customer),
    ).resolves.toEqual({ review: null });
    expect(research).not.toHaveBeenCalled();
  });

  it("runs newly seeded tracking once only for in-app setup", async () => {
    listCompetitors.mockResolvedValue([{ domain: "ahrefs.com" }]);
    prepareWebsiteTracking.mockResolvedValue({ prompts: [] });

    await runAiResearchSetup({ projectId: "project" }, customer);
    expect(startWebsiteTrackingRun).not.toHaveBeenCalled();

    await runAiResearchSetup({ projectId: "project" }, customer, {
      runSeededTracking: true,
    });
    expect(startWebsiteTrackingRun).toHaveBeenCalledWith("project", customer);
  });

  it("returns website research for competitor review when competitors are missing", async () => {
    const result = await runAiResearchSetup({ projectId: "project" }, customer);

    expect(result).toMatchObject({
      review: { competitors: [{ domain: "ahrefs.com" }] },
    });
  });
});

describe("getAiResearchSetup", () => {
  it.each([
    [undefined, "keywords"],
    ["openrouter", "openrouter"],
  ])(
    "uses deployment setup mode %s without modifying saved data",
    async (mode, expected) => {
      listResearchKeywords.mockResolvedValue(["existing keyword"]);
      listCompetitors.mockResolvedValue([]);
      openRouterKey.mockImplementation(async (name: string) =>
        name === "AI_RESEARCH_SETUP_MODE" ? mode : undefined,
      );
      expect(await getAiResearchSetup("project")).toMatchObject({
        defaultSetupMode: expected,
        status: "ready",
        keywords: ["existing keyword"],
      });
      expect(runBatch).not.toHaveBeenCalled();
      expect(workflow.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      "AppError: We couldn't read this website. Check the URL and try again.",
      "website_unreadable",
    ],
    ["Error: connect ECONNREFUSED 10.0.0.5:5432", null],
  ])("surfaces only a known failure cause for %s", async (message, failure) => {
    listResearchKeywords.mockResolvedValue([]);
    listCompetitors.mockResolvedValue([]);
    workflow.get.mockResolvedValue({
      status: async () => ({
        status: "errored",
        error: { name: "Error", message },
      }),
    });

    const setup = await getAiResearchSetup("project");

    expect(setup).toMatchObject({ status: "failed", failure });
    expect(JSON.stringify(setup)).not.toContain(message);
  });
});

describe("startAiResearchSetup", () => {
  it("saves supplied keywords without OpenRouter, paid research, tracking or scheduling", async () => {
    listResearchKeywords
      .mockResolvedValueOnce([])
      .mockResolvedValue(["Prada sunglasses"]);
    listCompetitors.mockResolvedValue([{ domain: "competitor.example" }]);
    workflow.get.mockRejectedValue(new Error("not found"));
    openRouterKey.mockResolvedValue(undefined);

    await expect(
      startAiResearchSetup(
        { projectId: "project", keywords: ["Prada sunglasses"] },
        customer,
        { runSeededTracking: true },
      ),
    ).resolves.toMatchObject({
      status: "ready",
      keywords: ["Prada sunglasses"],
      failure: null,
    });
    expect(runBatch).toHaveBeenCalledOnce();
    expect(workflow.create).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(prepareWebsiteTracking).not.toHaveBeenCalled();
    expect(startWebsiteTrackingRun).not.toHaveBeenCalled();
  });
  it("reports missing OpenRouter configuration without creating a setup workflow", async () => {
    listResearchKeywords.mockResolvedValue([]);
    listCompetitors.mockResolvedValue([]);
    workflow.get.mockRejectedValue(new Error("not found"));
    openRouterKey.mockResolvedValue(undefined);

    expect(await getAiResearchSetup("project")).toMatchObject({
      status: "none",
      failure: "openrouter_not_configured",
    });
    await expect(
      startAiResearchSetup({ projectId: "project" }, customer),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("keeps saved research available without an OpenRouter key", async () => {
    listResearchKeywords.mockResolvedValue(["rank tracker"]);
    listCompetitors.mockResolvedValue([]);
    openRouterKey.mockResolvedValue(undefined);
    expect(await getAiResearchSetup("project")).toMatchObject({
      status: "ready",
      failure: null,
    });
  });
  it("does not start a second paid run while one is running, such as after a reload", async () => {
    listResearchKeywords.mockResolvedValue([]);
    listCompetitors.mockResolvedValue([]);
    workflow.get.mockResolvedValue({
      status: async () => ({ status: "running" }),
      restart: vi.fn(),
    });

    await expect(
      startAiResearchSetup({ projectId: "project" }, customer),
    ).resolves.toMatchObject({ status: "running" });
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("starts one workflow per project with serializable billing fields only", async () => {
    listResearchKeywords.mockResolvedValue([]);
    listCompetitors.mockResolvedValue([]);
    workflow.get.mockRejectedValue(new Error("not found"));

    await startAiResearchSetup(
      { projectId: "project" },
      // A request context also carries objects a workflow cannot serialize.
      { ...customer, project: { id: "project" } } as typeof customer,
    );

    expect(workflow.create).toHaveBeenCalledWith({
      id: "ai-research-setup-project",
      params: {
        setupProjectId: "project",
        runSeededTracking: false,
        customer: { ...customer, projectId: "project" },
      },
    });
  });
});

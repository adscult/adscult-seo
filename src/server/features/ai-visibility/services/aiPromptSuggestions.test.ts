import { expect, it, vi } from "vitest";
import { generateText } from "ai";
import { generateAiPrompts } from "./aiPromptSuggestions";
import { customer } from "./aiVisibilityTestFixtures";

vi.mock("ai", () => ({ generateText: vi.fn(), Output: { object: vi.fn() } }));
vi.mock("../repositories/AiVisibilityRepository", () => ({
  AiVisibilityRepository: { getConfiguration: async () => null },
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: async () => ({ domain: "example.com" }),
  },
}));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({
    ProjectContextRepository: {
      listSections: async () => [],
      listCompetitors: async () => [],
    },
  }),
);
vi.mock("@/server/billing/subscription", () => ({
  checkUsageCreditsDepleted: vi.fn(),
}));
vi.mock("@/server/billing/researchSpend", () => ({
  billResearchSpend: vi.fn(),
}));
vi.mock("@/server/lib/chatAgent", () => ({
  requireOpenRouterCostUsd: vi.fn(),
}));
vi.mock("@/server/lib/openrouter", () => ({ buildChatAgentModel: vi.fn() }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async () => undefined,
  getRequiredEnvValue: async () => {
    throw new Error(
      "Missing required environment variable: OPENROUTER_API_KEY",
    );
  },
  isHostedServerAuthMode: async () => false,
}));

it("reports missing generation configuration as a safe client error without a model call", async () => {
  await expect(
    generateAiPrompts(
      {
        projectId: "project",
        locationCode: 2356,
        languageCode: "en",
        excludePrompts: [],
      },
      customer,
    ),
  ).rejects.toMatchObject({ code: "AI_GENERATION_NOT_CONFIGURED" });
  expect(generateText).not.toHaveBeenCalled();
});

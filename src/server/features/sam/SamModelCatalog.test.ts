import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { samConfig } from "@/shared/sam-config";
import { SamModelCatalog } from "./SamModelCatalog";
import { SamModelPreferenceService } from "./SamModelPreferenceService";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockRejectedValue(new Error("Unexpected catalog request"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function config(settings: Record<string, string> = {}) {
  const values: Record<string, string> = {
    SAM_PROVIDER: "anthropic",
    ANTHROPIC_MODEL: "default-model",
    ...settings,
  };
  return samConfig((name) => values[name]);
}
function page(id: string, more = false) {
  return Response.json({
    data: [{ id, display_name: `Name for ${id}` }],
    has_more: more,
    last_id: id,
  });
}

it("discovers new models across Anthropic pages and permits saving them", async () => {
  fetchMock
    .mockResolvedValueOnce(page("new-model", true))
    .mockResolvedValueOnce(page("another-model"));
  const catalog = await new SamModelCatalog().get(config(), "fixture-key");
  expect(catalog).toMatchObject({
    models: ["default-model", "new-model", "another-model"],
    labels: {
      "default-model": "default-model",
      "new-model": "Name for new-model",
      "another-model": "Name for another-model",
    },
  });
  expect(fetchMock.mock.calls[1][0]).toEqual(
    new URL(
      "https://api.anthropic.com/v1/models?limit=1000&after_id=new-model",
    ),
  );
  let saved: unknown;
  const storage = {
    get: async () => saved,
    put: async (_key: string, value: string) => {
      saved = value;
    },
  };
  const choices = catalog;
  await SamModelPreferenceService.set(storage, choices, { model: "new-model" });
  expect(await SamModelPreferenceService.get(storage, choices)).toBe(
    "new-model",
  );
});

it.each([undefined, "claude-sonnet-5"])(
  "defaults to the newest allowed Sonnet and groups major generations (allowlist: %s)",
  async (allowed) => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
          { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
          { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
        ],
        has_more: false,
        last_id: "claude-sonnet-5-5",
      }),
    );
    const catalog = await new SamModelCatalog().get(
      config({
        ANTHROPIC_MODEL: "latest-sonnet",
        ...(allowed ? { SAM_MODELS: allowed } : {}),
      }),
      "fixture-key",
    );
    expect(catalog.model).toBe(allowed ?? "claude-sonnet-5-5");
    expect(catalog.groups).toEqual(
      allowed
        ? [{ label: "New generation", models: [allowed] }]
        : [
            {
              label: "New generation",
              models: [
                "claude-sonnet-5-5",
                "claude-sonnet-5",
                "claude-opus-5-5",
              ],
            },
            { label: "Older generation", models: ["claude-sonnet-4-6"] },
          ],
    );
    expect(
      await SamModelPreferenceService.get(
        { get: async () => undefined, put: vi.fn() },
        catalog,
      ),
    ).toBe(catalog.model);
    expect(
      await SamModelPreferenceService.get(
        { get: async () => allowed ?? "claude-sonnet-4-6", put: vi.fn() },
        catalog,
      ),
    ).toBe(allowed ?? "claude-sonnet-4-6");
  },
);

it("enforces the admin allowlist against discovered models while retaining the configured default", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({
      data: [
        { id: "approved", display_name: "Approved" },
        { id: "unapproved", display_name: "Unapproved" },
      ],
      has_more: false,
      last_id: "unapproved",
    }),
  );
  const catalog = await new SamModelCatalog().get(
    config({ SAM_MODELS: "approved,unavailable" }),
    "fixture-key",
  );
  expect(catalog.models).toEqual(["default-model", "approved"]);
  await expect(
    SamModelPreferenceService.set(
      { get: async () => undefined, put: vi.fn() },
      catalog,
      { model: "unapproved" },
    ),
  ).rejects.toThrow("available SAM models");
});

it("lists only tool-capable text models from OpenRouter", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({
      data: [
        {
          id: "new/chat",
          name: "New Chat",
          architecture: { output_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
        {
          id: "image",
          name: "Image",
          architecture: { output_modalities: ["image"] },
          supported_parameters: ["tools"],
        },
        {
          id: "no-tools",
          name: "No tools",
          architecture: { output_modalities: ["text"] },
          supported_parameters: [],
        },
      ],
    }),
  );
  const catalog = await new SamModelCatalog().get(
    config({ SAM_PROVIDER: "openrouter", OPENROUTER_MODEL: "configured/chat" }),
    "fixture-key",
  );
  expect(catalog.models).toEqual(["configured/chat", "new/chat"]);
  expect(catalog.labels["new/chat"]).toBe("New Chat");
  expect(fetchMock.mock.calls[0][0]).toEqual(
    new URL("https://openrouter.ai/api/v1/models"),
  );
});

it("refreshes discovery after five minutes and immediately after credentials change", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  fetchMock
    .mockResolvedValueOnce(page("first"))
    .mockResolvedValueOnce(page("second"))
    .mockResolvedValueOnce(page("third"));
  const catalog = new SamModelCatalog();
  await catalog.get(config(), "first-key");
  expect((await catalog.get(config(), "first-key")).models).toContain("first");
  now.mockReturnValue(300_001);
  expect((await catalog.get(config(), "first-key")).models).toContain("second");
  expect((await catalog.get(config(), "other-key")).models).toContain("third");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("reports rejected credentials and lets a subsequent request retry discovery", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(page("recovered"));
  const catalog = new SamModelCatalog();
  await expect(catalog.get(config(), "fixture-key")).rejects.toThrow(
    "credentials were rejected",
  );
  expect((await catalog.get(config(), "fixture-key")).models).toContain(
    "recovered",
  );
});

/* eslint-disable max-lines -- SAM's lifecycle hooks share Durable Object state. */
import { Think } from "@cloudflare/think";
import type {
  ChatErrorContext,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  ChatResponseResult,
  SaveMessagesResult,
  Session,
  StepContext,
  ToolCallResultContext,
  ToolCallContext,
  ToolCallDecision,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import { clearChatTerminal } from "agents/chat";
import {
  createCompactFunction,
  estimateMessageTokens,
  estimateStringTokens,
} from "agents/experimental/memory/utils";
import { generateText, convertToModelMessages } from "ai";
import type { UIMessage } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, withPgClient } from "@/db";
import { user } from "@/db/schema";
import {
  openRouterCostUsd,
  staticAssistantModel,
} from "@/server/lib/chatAgent";
import { SamSessionRepository } from "@/server/features/sam/SamSessionRepository";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { buildSamSkillSource } from "@/server/features/sam/samSkills";
import { buildSamSystemPrompt } from "@/server/features/sam/samSystemPrompt";
import {
  SamTelemetry,
  type SamTurnStats,
} from "@/server/features/sam/samTurnTelemetry";
import { buildSamModel } from "./samModel";
import { SamUsageRepository } from "./SamUsageRepository";
import { SamModelPreferenceService } from "./SamModelPreferenceService";
import { SamModelCatalog } from "./SamModelCatalog";
import { SamToolCatalog } from "./SamToolCatalog";
import { buildSamHistoryTool, compactSamHistory } from "./samToolContext";
import { samConfig } from "@/shared/sam-config";
import {
  getEnvValueSync,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";
import { resolveSamToolRole } from "./samToolAuth";
import {
  checkUsageCreditsDepleted,
  trackUsageCreditSpend,
} from "@/server/billing/subscription";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import { MCP_SCOPE } from "@/lib/oauth-resource";
import type { ToolAuthContext } from "@/server/mcp/context";
import { AppError } from "@/server/lib/errors";

// SAM's read-only view of the project's shared memory. The block has no `set`
// provider, so Think exposes no set_context tool for it; writes go through the
// update_project_context tool, the same one MCP clients and the settings UI use.
const PROJECT_CONTEXT_BLOCK = "project_context";

const PUBLIC_ORIGIN_KEY = "sam-public-origin";

// Batching threshold for metering, not a charge: the user pays the turn's
// actual OpenRouter cost (times the usual markup) whatever this is set to.
// Spend accumulates step by step and is sent to Autumn once the unbilled
// total reaches this much, with the remainder flushed when the turn ends —
// so a $0.50 turn is ~10 Autumn calls rather than one per step, and a turn
// the isolate kills mid-way has at most this much unbilled. Each call rounds
// up to a whole credit (a tenth of a cent).
const SAM_BILLING_CHUNK_USD = 0.05;

// Long tool-heavy turns are what outgrow the Durable Object memory limit; the
// model's 1M-token window never gets a say. Compact between turns past this
// estimated token count, and mid-turn once a step's input passes 90% of the
// proactive ceiling — both far below the window, because the constraint is DO
// memory, not the provider.
//
// The between-turn threshold is compared against the Session's built-in
// estimate (~4 chars/token over the full stored transcript). That runs high
// relative to what the model receives, because Think clips tool outputs
// older than the last four messages to 500 chars on every call, so it fires
// early — the safe side. Don't pass a tokenCounter built on the model's
// reported usage: the Session also calls the counter per single message when
// choosing what to protect, and a whole-prompt number collapses the protected
// tail to two messages. A real per-message counter means a tokenizer in the
// bundle, which costs the same heap we're protecting.
const SAM_COMPACT_AFTER_TOKENS = 120_000;
const SAM_MAX_INPUT_TOKENS = 160_000;

const INTERRUPTED_TURN_NOTICE =
  "That reply was cut off before it finished — the work got too big to complete in one go. Everything above is saved. Ask again for a narrower slice (fewer keywords, competitors, or pages), or tell me where to pick up.";

// Derive a short session title from the first user message.
function deriveTitle(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "New chat";
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

function firstUserText(messages: UIMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const textPart = firstUser?.parts.find((part) => part.type === "text");
  return textPart?.text ?? "";
}

type SamContext = {
  row: NonNullable<
    Awaited<ReturnType<typeof SamSessionRepository.getSessionById>>
  >;
  project: NonNullable<
    Awaited<ReturnType<typeof ProjectRepository.getProjectById>>
  >;
  // The session row is normalized (project/user ids only); the creating
  // user's current email is resolved here for the billing/MCP auth context.
  userEmail: string;
};

/**
 * Durable Object backing the SAM in-app agent, built on Think. One DO per chat
 * session (Think hosts one conversation per instance); the DO instance name IS
 * the session id, set by the client (`useAgent({ name: sessionId })`) and
 * authorized in the Worker (`onBeforeConnect`) before any connection reaches
 * here — so the DO trusts that its caller may act on `this.name` and derives
 * project/user from the sam_sessions row (and the org from the project).
 *
 * Think owns the agentic loop (streaming, persistence, compaction-ready
 * history, context blocks); this subclass contributes the model, the MCP
 * toolset, the billing gate/metering, and project-scoped memory: the
 * "project_context" block renders the project's shared memory, which every
 * session in the project — and the MCP server and settings UI — reads and
 * writes through ProjectContextService.
 */
export class SamChatAgent extends Think {
  // SAM's toolset is the MCP tools from beforeTurn; it has no use for Think's
  // workspace bash tool, whose just-bash dependency is stubbed out of the
  // bundle anyway (see vite.config.ts) to keep ~30 MB of eagerly-evaluated
  // source out of every isolate's baseline heap.
  override workspaceBash = false;

  // Session row + project, resolved once per DO lifetime (the binding is
  // immutable). Null until a turn/provider needs it — and left null when the
  // registry row is gone, which beforeTurn turns into a polite refusal.
  private samContext: SamContext | null = null;
  private selectedModel: string | undefined;
  private readonly modelCatalog = new SamModelCatalog();
  private connectedCatalog: SamToolCatalog | undefined;
  private readonly turnToolResults = new Map<string, unknown>();

  // Per-turn billing state: beforeTurn arms it (non-null = hosted mode, meter
  // this turn), onStepFinish accumulates OpenRouter cost and meters it in
  // chunks as the turn runs, onChatResponse/onChatError flush the remainder.
  // Chunked per step rather than once per turn so a turn the Durable Object
  // memory limit kills mid-way still bills what it spent — the Sep 2026
  // recovery loop burned ~$160/day of OpenRouter spend that never reached
  // onChatResponse. Deductions run off the inference loop, serialized so they
  // land in order; waitUntil keeps the final flush alive in the background.
  private turnUnbilledUsd = 0;
  private turnMonthlyRemaining: number | null = null;
  private billing: Promise<void> = Promise.resolve();

  // Turn telemetry: armed in beforeTurn, fed by the step and tool hooks,
  // reported once as `sam:turn` when the turn ends by any route (response,
  // error, or a memory-limit kill surfacing as recovery).
  private readonly telemetry = new SamTelemetry(
    () => this.name,
    () => withPgClient(() => this.loadSamContext()),
    (promise) => this.ctx.waitUntil(promise),
  );

  // Mid-turn context guard, using the compaction configured in
  // configureSession (see SAM_MAX_INPUT_TOKENS). The reactive backstop is
  // deliberately off: it re-runs the whole turn from compacted history, which
  // would re-issue every tool call — a second site audit, a second DataForSEO
  // charge for the same research — on a classifier that is a regex over the
  // provider's error text. A turn that still overflows ends as an error the
  // user can retry.
  override contextOverflow = {
    proactive: { maxInputTokens: SAM_MAX_INPUT_TOKENS },
  };

  /** Permanently erase a conversation, also used during account erasure. */
  async destroyForErasure(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(1000, "Conversation deleted");
    }
    this.cancelAllChats();
    if (!(await this.waitUntilStable({ timeout: 5000 }))) {
      throw new Error(
        "SAM is still stopping this conversation. Try deleting it again.",
      );
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // Record the app origin for the deep links tools attach to responses,
  // derived from the requests this DO serves instead of env config. DO storage
  // (not an instance field) because the DO hibernates: a turn can arrive as a
  // WS message on a wake-up where fetch() never ran. Reads are served from
  // workerd's in-process cache and unchanged puts are deduped, so this costs
  // nothing per turn.
  async fetch(request: Request): Promise<Response> {
    await this.ctx.storage.put(PUBLIC_ORIGIN_KEY, getPublicOrigin(request));
    return super.fetch(request);
  }

  getModel() {
    return this.buildModel("max");
  }

  private buildModel(reasoningEffort: "max" | "low") {
    return buildSamModel(
      this.env,
      reasoningEffort,
      (provider, model) =>
        withPgClient(async () => {
          const ctx = await this.loadSamContext();
          if (
            !ctx ||
            !(await resolveSamToolRole({
              userId: ctx.row.userId,
              userEmail: ctx.userEmail,
              organizationId: ctx.project.organizationId,
            }))
          ) {
            throw new Error(
              "You no longer have access to this chat. Start a new chat if you have changed workspaces.",
            );
          }
          return SamUsageRepository.admit({
            organizationId: ctx.project.organizationId,
            sessionId: ctx.row.id,
            provider,
            model,
            purpose: reasoningEffort === "low" ? "summary" : "response",
          });
        }),
      this.selectedModel,
    );
  }

  private get samConfig() {
    return samConfig((name) => getEnvValueSync(this.env, name));
  }

  private async availableModels() {
    const config = this.samConfig;
    return {
      ...config,
      ...(await this.modelCatalog.get(
        config,
        getEnvValueSync(this.env, config.keyName),
      )),
    };
  }

  override getSkills() {
    if (this.samConfig.profile === "connected_data") return [];
    return [buildSamSkillSource()];
  }

  override afterToolCall(ctx: ToolCallResultContext) {
    if (this.samConfig.profile === "connected_data" && ctx.success)
      this.turnToolResults.set(ctx.toolCallId, ctx.output);
    this.telemetry.toolCall(ctx);
  }

  override async beforeToolCall(
    ctx: ToolCallContext,
  ): Promise<ToolCallDecision | void> {
    if (
      this.samConfig.profile === "connected_data" &&
      !this.connectedCatalog?.canExecute(ctx.toolName)
    ) {
      return {
        action: "block",
        reason: "This tool is not available in the connected-data profile.",
      };
    }
    if (
      this.samConfig.profile === "connected_data" &&
      ["load_tools", "read_tool_result"].includes(ctx.toolName)
    ) {
      const role = await withPgClient(async () => {
        const context = await this.loadSamContext();
        return context
          ? resolveSamToolRole({
              userId: context.row.userId,
              userEmail: context.userEmail,
              organizationId: context.project.organizationId,
            })
          : null;
      });
      if (!role)
        return {
          action: "block",
          reason: "You no longer have access to this conversation.",
        };
    }
  }

  override beforeStep() {
    if (this.samConfig.profile === "connected_data")
      return { activeTools: this.connectedCatalog?.activeTools ?? [] };
  }

  async configureSession(session: Session): Promise<Session> {
    this.selectedModel = await SamModelPreferenceService.get(
      this.ctx.storage,
      await this.availableModels(),
    );
    const compact = createCompactFunction({
      summarize: (prompt) => this.summarizeForCompaction(prompt),
    });
    return session
      .withContext("soul", {
        provider: { get: () => this.buildSoulPrompt() },
      })
      .withContext(PROJECT_CONTEXT_BLOCK, {
        description:
          this.samConfig.profile === "connected_data"
            ? "Existing project context: sections, competitors, key pages and research log. Read-only in this profile."
            : "This project's shared memory — sections, competitors, key pages and research log. Change it with update_project_context.",
        provider: { get: () => this.renderProjectContext() },
      })
      .onCompaction((messages, context) =>
        compact(
          this.samConfig.profile === "connected_data"
            ? compactSamHistory(messages)
            : messages,
          context,
        ),
      )
      .compactAfter(
        SAM_COMPACT_AFTER_TOKENS,
        this.samConfig.profile === "connected_data"
          ? {
              tokenCounter: ({ messages, systemPrompt }) =>
                estimateMessageTokens(compactSamHistory(messages)) +
                estimateStringTokens(systemPrompt),
            }
          : undefined,
      );
  }

  // Compaction summaries run outside the step loop (so outside onStepFinish),
  // on the same model at low reasoning; their cost joins the turn's total.
  private async summarizeForCompaction(prompt: string): Promise<string> {
    const result = await generateText({
      model: this.buildModel("low"),
      prompt:
        this.samConfig.profile === "connected_data"
          ? `Preserve the user's question, exact measured totals and findings, source properties, inclusive dates, filters, freshness/limitations, private report URLs, and contextPreview messageId/toolCallId references. Do not promote preview rows to population totals. Detail remains readable through read_tool_result.\n\n${prompt}`
          : prompt,
      maxOutputTokens: 8_000,
    });
    this.recordSpend(openRouterCostUsd(result.providerMetadata));
    this.telemetry.compaction();
    return result.text;
  }

  private async loadSamContext(): Promise<SamContext | null> {
    if (this.samContext) return this.samContext;
    const row = await SamSessionRepository.getSessionById(this.name);
    if (!row) return null;
    const project = await ProjectRepository.getProjectById(row.projectId);
    if (!project) return null;
    const [creator] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, row.userId))
      .limit(1);
    if (!creator) return null;
    this.samContext = { row, project, userEmail: creator.email };
    return this.samContext;
  }

  // The identity block. Runs through the context-block pipeline like the
  // project-memory block, so it re-renders (fresh project row, intake mode
  // on/off) whenever the prompt is refreshed.
  private buildSoulPrompt(): Promise<string> {
    return withPgClient(async () => {
      const ctx = await this.loadSamContext();
      if (!ctx) {
        return "You are SAM, the SEO agent inside OpenSEO. This chat session no longer exists; tell the user to start a new chat.";
      }
      const context = await ProjectContextService.getProjectContext(
        ctx.project.id,
      );
      return buildSamSystemPrompt(
        {
          projectId: ctx.project.id,
          projectName: ctx.project.name,
          domain: ctx.project.domain,
          locationCode: ctx.project.locationCode,
          languageCode: ctx.project.languageCode,
        },
        // Nothing recorded about the business yet: SAM runs its intake flow.
        {
          intakeMode: context.missingSections.includes("business_overview"),
          profile: this.samConfig.profile,
        },
      );
    });
  }

  // The project-memory block. Scopes its own Postgres client: providers are
  // invoked from Think's internals, so no ambient withPgClient scope can be
  // assumed (no-op in D1 mode).
  private renderProjectContext(): Promise<string | null> {
    return withPgClient(async () => {
      const ctx = await this.loadSamContext();
      if (!ctx) return null;
      return ProjectContextService.renderProjectContextMarkdown(
        await ProjectContextService.getProjectContext(ctx.project.id),
      );
    });
  }

  // Gates swap the model for one turn: the canned model streams the refusal
  // back through Think's normal pipeline (rendered and persisted like any
  // assistant message) without calling a provider, so a refusal is free even
  // when users script them. The old version made a real 200-token call, which
  // MiniMax M3 could spend entirely on reasoning tokens — leaving the user a
  // truncated chain-of-thought and no reply (issue #161).
  private refusalTurn(text: string): TurnConfig {
    return { model: staticAssistantModel(text) };
  }

  async beforeTurn(turnCtx: TurnContext): Promise<TurnConfig> {
    // turnUnbilledUsd deliberately carries over: a between-turn compaction
    // summary can land after the previous flush, and it is the same org's
    // spend either way.
    this.turnMonthlyRemaining = null;
    this.turnToolResults.clear();
    this.connectedCatalog = undefined;
    const turn = this.telemetry.beginTurn(turnCtx.continuation);
    turn.provider = this.samConfig.provider;
    return withPgClient(async (): Promise<TurnConfig> => {
      const ctx = await this.loadSamContext();
      if (!ctx) {
        turn.refusal = "no_session";
        return this.refusalTurn(
          "I couldn't find this chat session. Please start a new one.",
        );
      }

      // Gate every turn on credits in hosted mode: SAM is open to every plan
      // (including free), and LLM tokens plus DataForSEO tool calls all draw
      // down the org's credit balance. Self-hosted brings its own provider
      // keys and has no Autumn balance, so it's ungated. Depletion is
      // confirmed against a second Autumn read path before refusing — a
      // stale check reading here once locked a paying customer out of chat.
      const { organizationId } = ctx.project;
      if (await isHostedServerAuthMode()) {
        const { depleted, monthlyRemaining } = await checkUsageCreditsDepleted({
          userId: ctx.row.userId,
          userEmail: ctx.userEmail,
          organizationId,
          projectId: ctx.project.id,
        });
        if (depleted) {
          turn.refusal = "credits";
          return this.refusalTurn(
            "You're out of credits. Upgrade your plan or buy more credits on the Billing page to keep using SAM.",
          );
        }
        this.turnMonthlyRemaining = monthlyRemaining;
      }

      const baseUrl =
        (await this.ctx.storage.get<string>(PUBLIC_ORIGIN_KEY)) ??
        "https://app.openseo.so";
      // In hosted mode a missing member row means the user was removed from the
      // workspace; fail closed instead of letting the open socket keep
      // owner-level tools (WebSockets authorize at connect time only, so this
      // per-turn check is what actually revokes a removed member's chat).
      const role = await resolveSamToolRole({
        userId: ctx.row.userId,
        userEmail: ctx.userEmail,
        organizationId,
      });
      if (!role) {
        turn.refusal = "no_access";
        return this.refusalTurn(
          "You no longer have access to this organization, so I can't continue this chat.",
        );
      }
      const authContext: ToolAuthContext = {
        userId: ctx.row.userId,
        userEmail: ctx.userEmail,
        organizationId,
        role,
        // SAM sessions belong to one project's workspace; org context is
        // fixed for the session, like an OAuth token's.
        orgScope: "pinned",
        baseUrl,
        clientId: null,
        scopes: [MCP_SCOPE],
      };

      // Loaded per turn, not at startup: the tool schemas are costly to build.
      const samTools = await import("@/server/features/sam/samChatTools");
      const tools = samTools.buildSamMcpTools(
        authContext,
        ctx.project,
        turn.turnId,
        this.samConfig.profile,
      );
      if (this.samConfig.profile === "connected_data") {
        tools.read_tool_result = buildSamHistoryTool(async (reference) => {
          if (this.turnToolResults.has(reference.toolCallId))
            return this.turnToolResults.get(reference.toolCallId);
          const message = reference.messageId
            ? await this.session.getMessage(reference.messageId)
            : this.messages.find((candidate) =>
                candidate.parts.some(
                  (part) =>
                    "toolCallId" in part &&
                    part.toolCallId === reference.toolCallId,
                ),
              );
          const part = message?.parts.find(
            (candidate) =>
              "toolCallId" in candidate &&
              candidate.toolCallId === reference.toolCallId &&
              "output" in candidate,
          );
          return part && "output" in part ? part.output : undefined;
        });
        this.connectedCatalog = new SamToolCatalog(tools);
      }
      const turnTools = this.connectedCatalog?.tools ?? tools;
      return {
        tools: turnTools,
        // Use the original cached transcript, not Think's generic 500-character
        // older-result truncation, so dates/totals/links survive our projection.
        messages: this.connectedCatalog
          ? await convertToModelMessages(compactSamHistory(this.messages), {
              tools: turnTools,
              ignoreIncompleteToolCalls: true,
            })
          : undefined,
        // Retain the project instructions/context, without Think's generic
        // workspace instructions for capabilities this profile doesn't expose.
        instructions:
          this.samConfig.profile === "connected_data"
            ? await this.session.freezeSystemPrompt()
            : undefined,
        // Think merges framework workspace/context tools into config.tools.
        // Only expose this profile's explicit read/report allowlist to the model.
        activeTools:
          this.samConfig.profile === "connected_data"
            ? this.connectedCatalog?.activeTools
            : undefined,
        // Bound each response in addition to the shared daily token allowance.
        maxSteps: 12,
        maxOutputTokens: 8_000,
      };
    });
  }

  onStepFinish(ctx: StepContext): void {
    const costUsd = openRouterCostUsd(ctx.providerMetadata);
    this.recordSpend(costUsd);
    this.telemetry.step(ctx, costUsd);
  }

  // Add spend to the turn's unbilled total and meter it once a chunk has
  // accumulated, or on `flush` at the end of the turn. Self-hosted turns (no
  // armed balance) are never metered.
  private recordSpend(costUsd: number, { flush = false } = {}): void {
    this.turnUnbilledUsd += costUsd;
    this.telemetry.spend(costUsd);
    const armed = this.turnMonthlyRemaining;
    if (armed === null) return;
    if (!flush && this.turnUnbilledUsd < SAM_BILLING_CHUNK_USD) return;
    const chunkUsd = this.turnUnbilledUsd;
    this.turnUnbilledUsd = 0;
    const turn = this.telemetry.turn;
    this.billing = this.billing
      .then(() => this.meterSpend(chunkUsd, armed, turn))
      .catch((error: unknown) => {
        console.error("[sam] credit metering failed", error);
        this.telemetry.captureError(error, { stage: "metering" });
      });
  }

  private async meterSpend(
    costUsd: number,
    armedMonthlyRemaining: number,
    turn: SamTurnStats | null,
  ): Promise<void> {
    const ctx = await withPgClient(() => this.loadSamContext());
    if (!ctx) return;
    // Earlier chunks in the chain have already drawn the monthly balance
    // down; the value captured at enqueue time only covers a flush that
    // outlives its turn (onChatError), where the field has been re-armed.
    const { monthlyCredits, topupCredits } = await trackUsageCreditSpend({
      customer: {
        userId: ctx.row.userId,
        userEmail: ctx.userEmail,
        organizationId: ctx.project.organizationId,
        projectId: ctx.project.id,
      },
      customerId: ctx.project.organizationId,
      creditFeature: "agent",
      costUsd,
      monthlyRemaining: this.turnMonthlyRemaining ?? armedMonthlyRemaining,
      properties: { provider: this.samConfig.provider, turn_id: turn?.turnId },
    });
    if (turn) turn.credits += monthlyCredits + topupCredits;
    if (this.turnMonthlyRemaining !== null)
      this.turnMonthlyRemaining -= monthlyCredits;
  }

  async onChatResponse(result: ChatResponseResult): Promise<void> {
    this.flushSpend();
    this.ctx.waitUntil(
      this.telemetry.report(
        result.status,
        { request_id: result.requestId, error_message: result.error },
        this.messages,
        { billing: this.billing },
      ),
    );

    await withPgClient(async () => {
      const ctx = await this.loadSamContext();
      if (!ctx) return;

      // Name the session from its first message so the side-panel is readable.
      if (ctx.row.title === "New chat") {
        const title = deriveTitle(firstUserText(this.messages));
        if (title !== "New chat") {
          await SamSessionRepository.setTitle(ctx.row.id, title);
          ctx.row.title = title;
        }
      } else {
        await SamSessionRepository.touch(ctx.row.id);
      }
    });

    // Re-render the blocks so context written during this turn — or by another
    // session, the settings UI, or an MCP client — is in the prompt by the next
    // turn. One withPgClient scope covers both providers (their own defensive
    // scopes reuse it). Best-effort — never fail the response.
    if (result.status === "completed") {
      await withPgClient(() => this.session.refreshSystemPrompt()).catch(
        (error: unknown) => {
          console.error("[sam] context refresh failed", error);
        },
      );
    }
  }

  // The return value becomes the stored chat-terminal body that reconnecting
  // clients replay — returning nothing would make it the string "undefined".
  onChatError(error: unknown, ctx?: ChatErrorContext): unknown {
    console.error("[sam] chat turn error", ctx?.stage, error);
    // A stopped or failed turn still consumed what it consumed.
    this.flushSpend();
    this.telemetry.error(error, ctx, this.messages, this.billing);
    return error;
  }

  // Meter the turn's remainder without holding the turn (and the queue
  // behind it) on Autumn: the DO stays alive for the chain via waitUntil,
  // which also covers the error stages Think never follows with a response
  // hook.
  private flushSpend(): void {
    this.recordSpend(0, { flush: true });
    this.ctx.waitUntil(this.billing);
  }

  // Think's chat recovery re-runs an interrupted turn: after a Durable Object
  // reset it wakes, reads the incident, and calls the model again to continue
  // the partial reply. When the reset was a memory-limit kill (a long,
  // tool-heavy turn under GPT-5.6 Luna at max reasoning), every re-run dies at
  // the same point, and the bookkeeping that bounds the retry budget dies with
  // it — one incident was observed at attempt 44 of a max of 10. Each attempt
  // is a full OpenRouter call that never reaches onChatResponse, so none of it
  // is metered: in early Sep 2026 these loops were ~95% of the key's spend.
  // Keep the durable bookkeeping (partial reply persisted) but never re-run
  // inference automatically; the user resends instead. Skipped recoveries
  // get no framework banner (that only fires when a retry budget is
  // exhausted), so schedule our own notice — delivered from inside this hook
  // it would land before the partial reply in the transcript.
  override async onChatRecovery(
    ctx: ChatRecoveryContext,
  ): Promise<ChatRecoveryOptions> {
    console.warn("[sam] interrupted turn not re-run", {
      name: this.name,
      incidentId: ctx.incidentId,
      recoveryKind: ctx.recoveryKind,
    });
    // The DO that ran the turn is gone with its stats; this is the only
    // signal that a turn was killed, so count it as its own status.
    await this.telemetry.report(
      "interrupted",
      { incident_id: ctx.incidentId, recovery_kind: ctx.recoveryKind },
      this.messages,
      { synthesize: true },
    );
    // Recovery runs from the DO's startup path, and a hook that fails or
    // times out is re-run on the next wake; idempotent so the notice is
    // scheduled once per incident, not once per restart.
    await this.schedule(1, "notifyInterruptedTurn", ctx.incidentId, {
      idempotent: true,
    });
    return { persist: true, continue: false };
  }

  async notifyInterruptedTurn(): Promise<void> {
    await this.deliverNotice(INTERRUPTED_TURN_NOTICE);
  }

  // Recovery continuations already queued as alarms before this deploy still
  // fire, and would each make one more model call (re-arming through the
  // alarm circuit breaker when that call OOMs too). Skip them without touching
  // the model; Think records the incident as skipped. Every other trigger
  // (auto-continuation, RPC, sub-agent) passes through untouched.
  protected override async continueLastTurn(
    ...args: Parameters<Think["continueLastTurn"]>
  ): Promise<SaveMessagesResult> {
    if (args[1]?.trigger === "recovery-continue") {
      console.warn("[sam] skipped queued recovery continuation", {
        name: this.name,
      });
      return { requestId: crypto.randomUUID(), status: "skipped" };
    }
    return super.continueLastTurn(...args);
  }

  // POST .../rewind {messageId}: delete that message and everything after it on
  // the active branch. Backs the client's undo (rewind past a user message) and
  // edit (rewind, then resend the edited text). Authorized in the Worker like
  // every other HTTP request to this DO. Think's own onRequest wrapper handles
  // /get-messages before delegating here.
  async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/model")) {
      if (request.method !== "GET" && request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, POST" },
        });
      }
      let config: Awaited<ReturnType<SamChatAgent["availableModels"]>>;
      try {
        config = await this.availableModels();
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error && !(error instanceof z.ZodError)
                ? error.message
                : "Could not load models from SAM's provider. Try again shortly.",
          },
          { status: 503 },
        );
      }
      if (request.method === "POST") {
        if (!(await this.waitUntilStable({ timeout: 1 }))) {
          return Response.json(
            { error: "Wait for SAM's reply to finish before changing models." },
            { status: 409 },
          );
        }
        try {
          this.selectedModel = await SamModelPreferenceService.set(
            this.ctx.storage,
            config,
            await request.json().catch(() => null),
          );
        } catch (error) {
          if (
            !(error instanceof AppError) ||
            error.code !== "VALIDATION_ERROR"
          ) {
            console.error("[sam] model preference save failed", error);
            return Response.json(
              { error: "Could not save the model selection. Try again." },
              { status: 500 },
            );
          }
          return Response.json(
            { error: "Choose one of the available SAM models." },
            { status: 400 },
          );
        }
      } else {
        this.selectedModel = await SamModelPreferenceService.get(
          this.ctx.storage,
          config,
        );
      }
      return Response.json({
        model: this.selectedModel,
        models: config.models,
        labels: config.labels,
        groups: config.groups,
      });
    }
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/rewind")
    ) {
      const body = z
        .object({ messageId: z.string().min(1) })
        .safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return Response.json({ error: "messageId required" }, { status: 400 });
      }
      const { messageId } = body.data;
      // A rewind can race an in-flight turn (the user undoes while the agent
      // is still working, e.g. after the stream stalled client-side). Abort
      // the turn and wait for it to settle BEFORE deleting, or its still-
      // running loop keeps streaming chunks and persists a fresh assistant
      // message right after the delete — an orphaned reply to nothing.
      this.cancelAllChats();
      await this.waitUntilStable({ timeout: 5000 });
      const index = this.messages.findIndex(
        (message) => message.id === messageId,
      );
      if (index === -1) {
        return Response.json({ error: "message not found" }, { status: 404 });
      }
      const ids = this.messages.slice(index).map((message) => message.id);
      await this.session.deleteMessages(ids);
      // Drop the stored how-the-last-turn-ended record too. It exists so a
      // reconnecting client can learn the last turn errored — but that turn
      // was just undone, and leaving it makes every future connection replay
      // a "Something went wrong" for a message that no longer exists.
      await clearChatTerminal(this.ctx.storage);
      return Response.json({ ok: true });
    }
    return super.onRequest(request);
  }
}

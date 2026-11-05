import { createContext, useContext, type ReactNode } from "react";
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type TextMessagePartComponent,
} from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Check,
  Copy,
  FileText,
  Pencil,
  RotateCcw,
  Search,
  Square,
  Undo2,
} from "lucide-react";
import { Button, buttonVariants } from "@/client/components/ui/button";
import {
  SamMarkdown,
  SamReasoning,
  SamThinking,
  SamToolCall,
} from "./SamMessageParts";
import {
  SamModelSelector,
  type useSamModelPreference,
} from "./SamModelSelector";

const UndoContext = createContext<(messageId: string) => void>(() => {});
const actionClass = buttonVariants({
  variant: "ghost",
  size: "icon-sm",
  className: "text-muted-foreground",
});
const suggestions = [
  {
    title: "Understand traffic",
    detail: "Compare the last 28 complete days",
    prompt:
      "How did traffic change over the latest complete 28 days compared with the preceding 28 days?",
    icon: BarChart3,
  },
  {
    title: "Find search opportunities",
    detail: "See which pages need attention",
    prompt:
      "Which pages are losing search traffic, and where are the best opportunities to improve?",
    icon: Search,
  },
  {
    title: "Explore saved keywords",
    detail: "Prioritize the terms you already track",
    prompt:
      "Which of my saved keywords should I prioritize based on the connected search data?",
    icon: ArrowUp,
  },
  {
    title: "Create a private report",
    detail: "Save findings and recommended next steps",
    prompt:
      "Analyze my connected data and save a private report with findings, supporting tables, and recommended next steps.",
    icon: FileText,
  },
];

function Welcome() {
  return (
    <ThreadPrimitive.Empty>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center py-6 sm:py-16">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          What would you like to understand?
        </h2>
        <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
          Ask SAM about your traffic, search performance, and saved keywords.
          Turn the findings into a clear next step.
        </p>
        <div className="mt-8 grid gap-2.5 sm:grid-cols-2">
          {suggestions.map(({ title, detail, prompt, icon: Icon }) => (
            <ThreadPrimitive.Suggestion
              key={title}
              prompt={prompt}
              send={false}
              className="group flex items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors outline-none hover:border-input hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:p-4"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{title}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {detail}
                </span>
              </span>
              <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      </div>
    </ThreadPrimitive.Empty>
  );
}

const UserText: TextMessagePartComponent = ({ text }) => (
  <p className="whitespace-pre-wrap break-words text-sm leading-6">{text}</p>
);

function CopyMessage() {
  return (
    <ActionBarPrimitive.Copy
      className={actionClass}
      aria-label="Copy message"
      title="Copy message"
    >
      <AuiIf condition={(s) => !s.message.isCopied}>
        <Copy />
      </AuiIf>
      <AuiIf condition={(s) => s.message.isCopied}>
        <Check />
      </AuiIf>
    </ActionBarPrimitive.Copy>
  );
}

function UserMessage() {
  const id = useAuiState((s) => s.message.id);
  const undo = useContext(UndoContext);
  return (
    <MessagePrimitive.Root className="group flex flex-col items-end gap-1.5 pl-8 sm:pl-16">
      <div className="max-w-full rounded-2xl bg-muted px-4 py-3">
        <MessagePrimitive.Parts components={{ Text: UserText }} />
      </div>
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="not-last"
        className="flex gap-0.5"
      >
        <CopyMessage />
        <ActionBarPrimitive.Edit
          className={actionClass}
          aria-label="Edit message"
          title="Edit message"
        >
          <Pencil />
        </ActionBarPrimitive.Edit>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="Undo from this message"
          title="Remove this message and everything after it"
          onClick={() => undo(id)}
        >
          <Undo2 />
        </Button>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="group min-w-0 space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
          S
        </span>
        SAM
      </div>
      <MessagePrimitive.Parts
        components={{
          Text: SamMarkdown,
          Reasoning: SamReasoning,
          Empty: SamThinking,
          tools: { Fallback: SamToolCall },
        }}
      />
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="not-last"
        className="flex gap-0.5"
      >
        <CopyMessage />
        <ActionBarPrimitive.Reload
          className={actionClass}
          aria-label="Regenerate response"
          title="Regenerate response"
        >
          <RotateCcw />
        </ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function EditComposer() {
  return (
    <ComposerPrimitive.Root className="rounded-xl border border-input bg-background p-3">
      <ComposerPrimitive.Input
        aria-label="Edit message"
        autoFocus
        minRows={2}
        maxRows={8}
        className="w-full resize-none bg-transparent text-sm leading-6 outline-none"
      />
      <div className="mt-3 flex justify-end gap-2">
        <ComposerPrimitive.Cancel
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Cancel
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send className={buttonVariants({ size: "sm" })}>
          Save & resend
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

export function SamThread({
  modelPreference,
  busy,
  onUndo,
  notice,
}: {
  modelPreference: ReturnType<typeof useSamModelPreference>;
  busy: boolean;
  onUndo: (messageId: string) => void;
  notice: ReactNode;
}) {
  const empty = useAuiState((s) => s.thread.isEmpty);
  return (
    <UndoContext.Provider value={onUndo}>
      <ThreadPrimitive.Root className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
        <ThreadPrimitive.Viewport
          autoScroll={!empty}
          scrollToBottomOnInitialize={!empty}
          scrollToBottomOnThreadSwitch={!empty}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 sm:px-6"
        >
          <Welcome />
          <AuiIf condition={(s) => !s.thread.isEmpty}>
            <div className="mx-auto w-full max-w-3xl space-y-8 py-8">
              <ThreadPrimitive.Messages
                components={{ UserMessage, AssistantMessage, EditComposer }}
              />
            </div>
          </AuiIf>
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto mt-auto w-full max-w-3xl bg-card pb-4 pt-3 sm:pb-5">
            <ThreadPrimitive.ScrollToBottom
              className={buttonVariants({
                variant: "outline",
                size: "icon-sm",
                className:
                  "absolute -top-10 left-1/2 -translate-x-1/2 rounded-full disabled:invisible",
              })}
              aria-label="Scroll to latest message"
            >
              <ArrowDown />
            </ThreadPrimitive.ScrollToBottom>
            {notice}
            <ComposerPrimitive.Root className="rounded-2xl border border-input bg-background p-3 transition-colors focus-within:border-ring sm:p-4">
              <ComposerPrimitive.Input
                aria-label="Message SAM"
                placeholder="Ask about your traffic, search performance, or next steps…"
                minRows={2}
                maxRows={6}
                autoFocus={false}
                className="w-full resize-none bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
              />
              <div className="mt-3 flex items-end justify-between gap-3">
                <SamModelSelector
                  preference={modelPreference}
                  busy={busy}
                  compact
                />
                <AuiIf condition={(s) => !s.thread.isRunning}>
                  <ComposerPrimitive.Send
                    className={buttonVariants({
                      size: "icon-sm",
                      className: "rounded-full",
                    })}
                    aria-label="Send message"
                  >
                    <ArrowUp />
                  </ComposerPrimitive.Send>
                </AuiIf>
                <AuiIf condition={(s) => s.thread.isRunning}>
                  <ComposerPrimitive.Cancel
                    className={buttonVariants({
                      variant: "secondary",
                      size: "icon-sm",
                      className: "rounded-full",
                    })}
                    aria-label="Stop response"
                  >
                    <Square className="size-3.5 fill-current" />
                  </ComposerPrimitive.Cancel>
                </AuiIf>
              </div>
            </ComposerPrimitive.Root>
            <p className="mt-2.5 hidden text-center text-xs text-muted-foreground sm:block">
              Enter to send · Shift + Enter for a new line
            </p>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </UndoContext.Provider>
  );
}

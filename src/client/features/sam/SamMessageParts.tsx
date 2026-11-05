import type {
  EmptyMessagePartComponent,
  ReasoningMessagePartComponent,
  ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { AlertCircle, Check, ChevronRight, LoaderCircle } from "lucide-react";
import remarkGfm from "remark-gfm";
import { MARKDOWN_COMPONENTS } from "@/client/components/Markdown";

export function SamMarkdown() {
  return (
    <MarkdownTextPrimitive
      className="min-w-0 break-words text-sm leading-7"
      remarkPlugins={[remarkGfm]}
      components={MARKDOWN_COMPONENTS}
    />
  );
}

export const SamThinking: EmptyMessagePartComponent = ({ status }) =>
  status.type === "running" ? (
    <div
      className="flex items-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
      Working on your question…
    </div>
  ) : null;

export const SamReasoning: ReasoningMessagePartComponent = ({
  text,
  status,
}) => (
  <details className="group/reasoning mb-3 text-sm text-muted-foreground">
    <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronRight className="size-3.5 transition-transform group-open/reasoning:rotate-90" />
      {status.type === "running" ? "Thinking…" : "Thought process"}
    </summary>
    <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/60 p-3 text-xs leading-relaxed">
      {text}
    </p>
  </details>
);

export const SamToolCall: ToolCallMessagePartComponent = ({
  toolName,
  args,
  result,
  isError,
  status,
}) => {
  const running = status.type === "running";
  const label =
    (
      {
        load_tools: "Preparing analysis",
        read_tool_result: "Reviewing saved data",
      } as Record<string, string>
    )[toolName] ??
    toolName.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  return (
    <details className="group/tool my-2 rounded-lg border border-border text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring">
        {running ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : isError ? (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <span
          className={isError ? "text-destructive" : "text-muted-foreground"}
        >
          {running ? "Running" : isError ? "Unable to finish" : "Complete"}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />
      </summary>
      <div className="space-y-3 border-t border-border p-3">
        <div>
          <p className="mb-1.5 font-medium text-muted-foreground">Inputs</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2.5 font-mono text-xs">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
        <div>
          <p className="mb-1.5 font-medium text-muted-foreground">Result</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2.5 font-mono text-xs">
            {result === undefined
              ? "Waiting for the result…"
              : typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      </div>
    </details>
  );
};

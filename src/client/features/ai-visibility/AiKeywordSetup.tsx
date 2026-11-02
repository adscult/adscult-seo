import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent } from "@/client/components/ui/card";
import { Label } from "@/client/components/ui/label";
import { Textarea } from "@/client/components/ui/textarea";
import { normalizeAiSuggestion } from "@/shared/ai-prompt-suggestions";
import { aiResearchSetupSchema } from "@/types/schemas/ai-visibility";

export function AiKeywordSetup({
  text,
  onTextChange,
  sources,
  saving,
  error,
  onSave,
  onOpenRouter,
}: {
  text: string;
  onTextChange: (text: string) => void;
  sources: { saved: string[]; tracked: string[] };
  saving: boolean;
  error: boolean;
  onSave: (keywords: string[]) => void;
  onOpenRouter: () => void;
}) {
  const keywords = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const valid =
    aiResearchSetupSchema.shape.keywords.safeParse(keywords).success;
  const add = (names: string[]) => {
    const combined = new Map(
      keywords.map((name) => [normalizeAiSuggestion(name), name]),
    );
    for (const name of names) {
      const key = normalizeAiSuggestion(name);
      if (!combined.has(key)) combined.set(key, name);
    }
    onTextChange([...combined.values()].join("\n"));
  };
  return (
    <div className="grid min-h-[calc(100dvh-8rem)] place-items-center">
      <Card className="w-full max-w-2xl py-6 md:py-8">
        <CardContent className="space-y-6 px-6 md:px-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Use your keywords for AI visibility
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Choose keywords you already work with. Your saved project context
              and competitors stay in use.
            </p>
          </div>
          <div className="space-y-3">
            <Label htmlFor="ai-setup-keywords">Keywords, one per line</Label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={saving || !sources.saved.length}
                onClick={() => add(sources.saved)}
              >
                Add saved keywords
              </Button>
              <Button
                variant="outline"
                disabled={saving || !sources.tracked.length}
                onClick={() => add(sources.tracked)}
              >
                Add rank tracking keywords
              </Button>
            </div>
            <Textarea
              id="ai-setup-keywords"
              rows={7}
              className="max-h-72 field-sizing-fixed"
              value={text}
              disabled={saving}
              onChange={(event) => onTextChange(event.target.value)}
              aria-describedby="ai-setup-keyword-help"
            />
            <p
              id="ai-setup-keyword-help"
              className="text-xs text-muted-foreground"
            >
              {keywords.length} / 100 keywords. Up to 200 characters each.
              Imports include up to 100 terms per source; edit the list before
              saving.
            </p>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                Could not save your keywords. Try again.
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-3">
            <Button
              className="w-full"
              size="lg"
              disabled={saving || !valid}
              onClick={() => onSave(keywords)}
            >
              {saving ? "Saving keywords…" : "Save keywords and continue"}
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Saving is free. Research and answer checks are separate paid
              actions. Keywords are not expanded into questions automatically;
              you can enter exact prompts in Prompt Tracking.
            </p>
            <Button
              variant="link"
              className="h-auto whitespace-normal px-0"
              disabled={saving}
              onClick={onOpenRouter}
            >
              Research with OpenRouter instead
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

# SAM connected analytics

SAM can answer questions using the current project's Google Analytics 4, Google
Search Console, saved keywords, and project context. Connect GA4 and Search Console
through Integrations first. Other projects' data is outside the chat's scope.

SAM uses small source pages and shows relevant rows first. Exact source counts,
available totals, reporting dates, filters and limitations stay with each result.
It can read more rows or revisit a saved result when a follow-up needs detail.
Older tables are condensed in the model's context while the saved conversation
keeps their detail and report links. For the connected-data profile, specialist
tools load only when needed; the full profile keeps its existing tool catalog.

For local development, add these settings to `.env.local`. For Docker or Coolify,
set them in the deployment environment and rebuild/restart the container:

```dotenv
SAM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=latest-sonnet
SAM_TOOL_PROFILE=connected_data
```

Keep the API key on the server. Chat displays the selected provider and model;
the setup screen names the selected provider's missing key. `/api/health` reports
its configuration status without calling the model. Cloudflare deployments forward
these settings through Alchemy, with the API key stored as a secret.

Choose a model from the dropdown inside the message box. The selection
is saved per chat and survives refreshes. It applies to replies and conversation
summaries. Wait for the current reply to finish before switching models.

SAM loads available models and their names from the selected provider, refreshing
the server's catalog after five minutes. New models appear without a code update.
For OpenRouter, the list includes text models that support tools. Administrators
can restrict choices with a comma-separated `SAM_MODELS` allowlist, then restart.
Leave it empty to show the provider's catalog. `ANTHROPIC_MODEL` or
`OPENROUTER_MODEL` controls the default. `ANTHROPIC_MODEL=latest-sonnet` selects
the newest available Sonnet version allowed by the administrator for new chats.
Set a specific model ID to pin the default instead. Saved chat selections remain
unchanged while that model is available. The picker groups Claude models by their
major version into new and older generations. For example:

```dotenv
SAM_MODELS=claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5
```

Changing models preserves chat history and uses the same team token allowance.
All users use the server's configured provider credentials; the selector cannot
change providers or supply API keys. Provider availability and prices can differ
between models. A model failure never selects another model automatically.

Existing installations default to `SAM_PROVIDER=openrouter` and
`SAM_TOOL_PROFILE=full`. Coolify Compose defaults to `connected_data` for this
deployment, while keeping OpenRouter selected until you explicitly change it.
To roll back the provider, set `SAM_PROVIDER=openrouter` with `OPENROUTER_API_KEY`
and optionally `OPENROUTER_MODEL`, then restart. Chat history and saved reports
remain in their existing storage. Provider errors never switch providers.
OpenRouter's existing region-based model routing remains available.

Try asking:

- “Why did organic traffic fall over the latest complete 28 days?”
- “Which declining search pages still convert in GA4?”
- “Which saved keywords match pages with search opportunities?”
- “Save a private report with the findings and recommended next steps.”

SAM's default analysis compares the latest complete 28-day period common to the
requested sources with the preceding 28 days. Answers should identify the actual
dates, properties, filters, freshness, and any missing or truncated data. GA4 and
GSC can be compared at landing-page level; GSC keywords cannot be attributed to
individual GA4 conversions. If one connector is unavailable, SAM can use the
others and explain the gap.

When requested, SAM creates a new private HTML report and returns its Reports
page link. Reports include the question, periods, sources, findings, tables,
recommendations, and limitations. The existing sandboxed report viewer displays
them. This profile cannot overwrite, delete, or publicly share reports, change
project context or keywords, crawl websites, or run paid SEO operations.

Every organization has a shared allowance of **1,000,000 input plus output tokens
per day**, resetting at midnight **Asia/Kolkata**. Chat shows recorded usage and
the next reset time. All users and projects in that organization share it.
Summaries, repeated context, and retries count. Cached input is included once in
input tokens; reasoning is included in reported output tokens. Each response is
limited to 12 model steps and 8,000 output tokens per call, including summaries.

The allowance is checked before each model call. Calls already admitted can finish
and take usage above the allowance. It is a token allowance, not a dollar ceiling.
If a response is interrupted before the provider returns usage, the call is
recorded as interrupted with no token total; the provider may still charge for
that work. An abrupt runtime termination may leave a call recorded as admitted.
The allowance uses returned provider usage, so it cannot account for unreported
tokens. Daily usage is assigned to the day the call was admitted.

For production, apply the generated database migrations using your normal
deployment process before starting the new code. Keep the existing persistent
volume. Confirm the provider, model, and usage indicator through Cloudflare Access,
then check streaming and a requested report's persistence. Agree on a live-test
spending limit before making billable Claude calls. No scheduled reports or
dedicated PDF generation are included.

---
name: actions-metrics-dashboard
description: Open and drive the Actions metrics dashboard, the Copilot CLI canvas extension that renders gh runner-kit metrics as an interactive panel for one repository or a whole organization, and read its numbers back as structured JSON. Use when the user wants to see, explore, compare or chart GitHub Actions and self-hosted runner metrics rather than read a single table, when they refer to the dashboard or the panel, or when a question needs several reports over one window held in step.
---

# Actions metrics dashboard

Reference for the `actions-metrics` canvas extension shipped in this repository
at `.github/extensions/actions-metrics/`. It collects the `gh runner-kit
metrics` reports over a single window, renders them as a dashboard, and exposes
every number it shows as structured JSON.

## Dashboard or CLI

Both read the same reports, so pick on how the answer is used.

Use the dashboard when the user wants to look at the data: to explore, to
compare periods, to filter interactively, or to keep a view open while the
conversation continues. Its collection covers several reports at once and is
cached, so follow-up questions over the same window are answered without
re-reading the API.

Use the `gh runner-kit metrics` CLI directly (see the `gh-runner-kit` skill)
for a one-off number, for scripting, for a scheduled workflow, or when the
answer belongs in a file rather than on screen.

Do not run the CLI to answer a question about a dashboard that is already open.
Call `get_metrics` instead: it returns what the user is looking at, so the
answer cannot disagree with the screen.

## Opening

```text
open_canvas({ canvasId: "actions-metrics", instanceId: "<your-handle>" })
```

The open input accepts every query field listed below; `{}` analyses the
workspace repository over the last 30 days. Opening the same `instanceId` again
focuses and reloads the existing panel rather than making a second one.

## Actions

| Action | Purpose |
| --- | --- |
| `set_filters` | Change the target, the window, the filters or the limits, and re-collect. Every field is optional; an omitted field keeps its value. |
| `get_metrics` | Read the current numbers as JSON. Takes `section` (`overview`, `runners`, `usage`, `fleet`, `all`) and `limit` (rows per ranked table, default 10). |
| `refresh` | Re-collect the current window, reusing the cached job lists. Pass `bypassCache: true` to discard them and fetch every run again. Fails with `rate_limited` while a rate limit is in effect. Use when the user asks for fresh data, not to fix an empty result. |
| `trace_runner` | Rebuild the concurrency timeline from the jobs of the runners matching a query, and draw a per-runner heatmap. |
| `export_metrics` | Publish the window through `gh runner-kit metrics export`, as `prometheus` (default) or `json`. |

`trace_runner` takes exactly one of `query` (a name fragment, or a pattern
carrying `*`), `all` (every runner, the expensive path) or `clear` (restore the
fleet-wide chart). `exclude` is not one of the three; it narrows whichever of
the first two runs.

## Target and scope

The panel analyses either one repository (`repo`) or a whole organization
(`owner`). The two are mutually exclusive, and each carries its own host, so
`owner: "github.example.com/acme"` moves the panel to that GitHub Enterprise
Server instance.

The two scopes do not report the same things:

- Everything derived from **workflow runs** is available for both, because runs
  are collected with `gh runner-kit metrics runs`, which walks every repository
  of an organization.
- Everything derived from **jobs** — queue time, run duration, runner usage,
  cost estimates, the slowest runs, the most failing jobs — is collected one
  repository at a time and is **not** available for an organization.
- The fleet reports `gh runner-kit` aggregates itself are available for both.

A section that was not collected is returned as
`{ "available": false, "reason": "..." }` rather than as zeros. Never read such
a section as "nothing happened"; say what was not measured, or switch to a
repository target and collect it.

## Query fields

Passed to `open_canvas` and to `set_filters` alike.

**Target** — `repo` (`[HOST/]OWNER/REPO`), `owner` (`[HOST/]OWNER`), `host`.

**Window and filters** — `days` (1-365, default 30), `event`, `branch`,
`workflow` (file name such as `ci.yml`, or the workflow ID), `labels` (the
concurrency timeline only, because no other report accepts a label filter).

**Repository filters** — `includeRepos`, `excludeRepos`, patterns such as
`octo/*` or `owner/repo`. Applied before collection, so they also cut the API
traffic; `excludeRepos` is applied after `includeRepos`. **Organization targets
only**, and they are cleared automatically when the target moves to a different
owner or host, because a pattern written for one owner can never match another.

**Fleet shape** — `groupBy` (`name`, `label`, `group`; use `label` or `group`
for ephemeral runners), `bucket` (`auto`, `15m` … `24h`), `runnerType` (`auto`,
`org`, `repo`), `selfHostedOnly`, `targetWait` (`15s` … `30m`, default `1m`),
`targetUtilization` (0-1, default 0.7), `billable` (opt-in; one extra API
request per run).

**Limits** — `maxRuns` (**per repository**; 0, the default, means every run in
the window, so an organization collects 0 × every repository it owns),
`jobConcurrency` (1-20, default 6), `jobKind` (`all`, `self-hosted` (default),
`github-hosted`), `topRunners` (default 40), `maxRows` (default 400000),
`rowBudget` (Job explorer rows held in the browser, default 20000).

Passing an empty string clears a text filter; passing an empty array clears a
list one.

## Reading the result

`get_metrics` returns the sections below. Ranked tables are cut to `limit`.

- `overview` — run totals and success rate, conclusions, duration and queue
  percentiles, a daily series, and rankings per workflow, per job, per event,
  plus the slowest runs. Under an organization the job-derived members are
  unavailable objects.
- `runners` — the registered inventory, which is read from the runner API and
  so covers an organization too. Its job-derived members (the self-hosted /
  GitHub-hosted split, label demand, the busiest runners) are repository-only.
- `usage` — the billing rates, the billable time of the window and the figure
  GitHub reports for the billing cycle. Repository targets only.
- `fleet` — what `gh runner-kit` computed: the summary, per-runner activity,
  queue time, concurrency, label supply and demand, per-workflow reliability,
  per-repository self-hosted activity, recommended pool sizes and cost.

Rows carry `repository` wherever an organization could put two repositories in
one table, so never identify a workflow by name alone under an organization.

`fleet.workflows` rows carry `failed`, `decided` and `retried`; `failureRate` is
`failed / decided`, and `decided` is not `jobs`. A row whose jobs all ended
undecided has a `null` failure rate — report it as unknown, not as a success.

`fleet.repositories` comes from `gh runner-kit metrics repository`, which is
always self-hosted-only and seeds a row for every repository. All-zero rows are
a real answer meaning "this repository put no job on the fleet", not a failure.

## Troubleshooting

| Symptom | Cause / Resolution |
| --- | --- |
| Every card is empty and the panel names an include filter | A repository filter matched nothing. Clear `includeRepos`, or widen it to the owner now targeted. |
| Queue time, cost or the slowest runs are missing | The target is an organization, where the job-derived reports are not collected. Switch to a repository to see them. |
| `fleet.repositories` is an unavailable object | The per-repository report only runs for an organization target. |
| A workflow appears twice with the same name | Two repositories of the organization share the workflow name. Read the `repository` field; the rows are grouped by repository and workflow path. |
| The runner inventory is missing and a 403 is reported | The token lacks the runner scopes. Everything derived from runs and jobs is still reported; only the inventory is skipped. |
| A report is named as unavailable in the installed version | The `gh runner-kit` binary predates that subcommand. Run `gh extension upgrade runner-kit`. |
| An organization collection is very slow | `maxRuns` is per repository and defaults to unlimited. Narrow with `includeRepos`, a shorter `days`, or a `maxRuns` cap. |
| Run counts disagree with a number the CLI printed earlier | The panel and a bare CLI call cut the window at the same instant, but a cached collection is older. Call `refresh`. |
| The panel is stale after the extension was edited | `extension.mjs` and `lib/` need an extension reload; `public/` only needs the panel reloaded. |

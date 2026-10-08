---
name: actions-metrics-dashboard
description: Open and drive the Actions metrics dashboard, the Copilot CLI canvas extension that renders gh runner-kit metrics as an interactive panel for one repository or a whole organization, and read its numbers back as structured JSON. Use when the user wants to see, explore, compare or chart GitHub Actions and self-hosted runner metrics rather than read a single table, when they refer to the dashboard or the panel, or when a question needs several reports over one window held in step.
---

# Actions metrics dashboard

Reference for the `actions-metrics` canvas extension shipped in this repository
at `.github/extensions/actions-metrics/`. It collects the `gh runner-kit
metrics` reports over a single window, renders them as a dashboard, and exposes
every number it shows as structured JSON. It also has a Step timeline tab for per-step workflow timing statistics and single-run job/step Gantt timelines.

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

The extension's `gh` subprocesses use stored `gh auth login` credentials by
default, not Copilot's inherited `GH_TOKEN`. The canvas **GitHub authentication**
setting accepts a token for the extension's `gh` subprocesses only. It stays in
process memory, is shared by open dashboards, and is cleared on extension restart;
the panel never reads it back or persists it. **Clear token** restores the
stored credentials, or `ACTIONS_METRICS_GH_TOKEN` if set in the Copilot process
environment before launch. These overrides apply to github.com and ghe.com;
GitHub Enterprise Server hosts use stored `gh` credentials.

## Opening

```text
open_canvas({ canvasId: "actions-metrics", instanceId: "<your-handle>" })
```

The open input accepts every query field listed below; `{}` analyses the
workspace repository over the last 30 days. Opening the same `instanceId` again
focuses and reloads the existing panel rather than making a second one.

Sortable table headings accept multiple ordered conditions. Click for the
primary sort (again to reverse it; a third click restores report order in
dashboard tables). Shift+click adds a tie-breaker, then reverses or removes
that condition on subsequent Shift+clicks. Arrows and numbers show direction
and priority. For example, click **Success** twice, then Shift+click **Runs**
to rank lowest success rate first and most runs first within equal rates.
Missing values remain last. The runner list and Job explorer sort all matches
before paging; their single-column sort toggles between two directions.

In **Workflows**, the **Workflow** column links to each repository's workflow
file on its default branch, on the dashboard's GitHub host, in a new tab.
Dynamic workflows (Copilot, Dependabot) and rows without a file path stay plain
text; they do not identify a repository workflow file.

## Actions

| Action | Purpose |
| --- | --- |
| `set_filters` | Change the target, the window, the filters or the limits, and re-collect. Every field is optional; an omitted field keeps its value. |
| `get_metrics` | Read the current numbers as JSON. Takes `section` (`overview`, `runners`, `usage`, `fleet`, `all`) and `limit` (rows per ranked table, default 10). |
| `refresh` | Re-collect the current window, reusing the cached job lists. Pass `bypassCache: true` to discard them and fetch every run again. Fails with `rate_limited` while a rate limit is in effect. Use when the user asks for fresh data, not to fix an empty result. |
| `trace_runner` | Rebuild the concurrency timeline from the jobs of the runners matching a query, and draw a per-runner heatmap. |
| `get_step_metrics` | Collect Step timeline statistics for one workflow file. Inputs: `workflow` (file name/path or ID), `repository` (exact `OWNER/REPO`; empty/omitted means all), `job`, `jobStatus` (job lifecycle status or conclusion; empty/omitted means all), `includeAllAttempts` (boolean, default false), `section` (`jobs`, `steps`, `timeline`, `trend`, `runners`), `limit`, `mergeMatrix`, `showInfra`, `runBudget`, `runnerKind` (`all`, `self-hosted`, `github-hosted`), `runsOn` (comma-separated label set), `runnerGroup`, `runner` (name, `*` wildcards), `reuseRows`. |
| `show_run_timeline` | Show one workflow run ID or URL as a job/step Gantt in the Step timeline tab. Inputs: required `run`, optional `repo`, optional `attempt`. |
| `export_metrics` | Publish the window through `gh runner-kit metrics export`, as `prometheus` (default) or `json`. |

`trace_runner` takes exactly one of `query` (a name fragment, or a pattern
carrying `*`), `all` (every runner, the expensive path) or `clear` (restore the
fleet-wide chart). `exclude` is not one of the three; it narrows whichever of
the first two runs.

## Step timeline

Use the **Step timeline** tab when the user asks which steps are slow, flaky,
skipped, moving later in time, or consuming most of a job. It requires a
current `gh runner-kit` binary with `metrics steps` and `job timeline`; if those
commands are missing, tell the user to update `gh runner-kit` and do not treat
the empty tab as evidence that no steps ran.

Important workflow rule: `metrics steps --workflow` expects the workflow file
name or ID (`ci.yml`, not the display name `Build and Test`). Prefer the
workflow path already present in dashboard workflow rows; use its basename for
collection. The tab samples newest runs with `--max-runs`, so always mention
the reported run count, observed range and truncation flag when summarising.

**Include all attempts** / `includeAllAttempts: true` collects every attempt
of each sampled run. False (the default) uses GitHub's latest-attempt job
listing, including carried-over jobs. Earlier failures and timeouts replaced
by a successful rerun are only available in the all-attempt scope. The panel
reads earlier attempts with `job timeline --attempt <N>`, reusing the CLI's
completed-attempt cache and preserving their own timeline origins.
Carried-over jobs are deduplicated. `runBudget` counts runs, not attempts.
Changing this option requires collection even with `reuseRows: true`, because
the row cache is scoped by attempt mode. In the UI, changing the checkbox only
edits the next collection; **Load steps** applies it and persists it per target.
Pending edits survive panel updates. **Repository**, **Job**, **Job status** and runner filters
immediately re-aggregate the loaded sample without a new collection, using its
workflow, run budget and attempt mode rather than pending edits to those
controls. Select **All jobs** to clear the job selection. These filters are
unavailable until steps are loaded and during a fresh collection.

All-attempt mode gives the run list one row per attempt; selecting a row opens
that attempt's Gantt. Each run-list row also has a **GitHub** link next to
**Gantt** that opens the same attempt on the dashboard's GitHub host in a new
tab. `meta.latestAttemptBasis` is false,
`meta.analysedAttempts` counts attempts with matching rows, and
`meta.historicalAttemptsRequested` / `meta.historicalAttemptsWithJobs` report
historical coverage. Surface `meta.warnings`: empty or unreadable earlier
attempts mean incomplete history, not success or no timeout. The tab displays
collection warnings collapsed by default; click the warning count to expand
or collapse the full messages. This mode needs
`metrics collect`, `metrics runs` and `job timeline` in the installed CLI.

`get_step_metrics` returns the aggregated data and updates the tab selection.
The `section` input controls whether the response focuses `steps`, `jobs`,
`timeline`, `trend`, or `runners`; omitted fields inherit the dashboard target and filters.
`repository` filters the collected rows by an exact `OWNER/REPO`; empty or
omitted means all repositories. It does not change the dashboard target or
the collection scope. Pass `reuseRows: true` to switch repositories without
collecting again. The response echoes `repository`, `repositoryFacets` and
`meta.repository`. Facets contain all repositories in the loaded workflow
sample with job counts, regardless of other filters. In the UI, the selector
appears for organization targets, defaults to **All repositories**, and is
saved per target. It narrows job, status and runner choices, workflow names,
statistics, trends, typical timelines, runner pools and run samples.
An existing workflow selection is preserved even when absent from the chosen
repository. A single-run Gantt from another repository hides its jobs with
an explanatory notice. A bare run ID defaults to the selected repository.
The runner inputs filter jobs after collection; pass `reuseRows: true` to
re-aggregate the rows already collected without calling the CLI again. Use
`section: "runners"` to compare `runs-on` pools (wait/run percentiles, failure
rate) and mention `meta.unfilteredJobs` when a runner filter is active.
`jobStatus` matches a job lifecycle status (`queued`, `in_progress`,
`completed`, etc.) or conclusion (`success`, `failure`, `cancelled`,
`skipped`, etc.) and keeps all steps of matching jobs, not only steps with
that outcome. It combines with runner filters; `reuseRows: true` avoids a
new collection. The UI **Job status** selector defaults to **All statuses**
and persists per target. The response echoes `jobStatus` and
`jobStatusFacets`, whose counts include every sampled job in the selected
repository, or every repository when the filter is empty. Statistics,
trends, runner pools and run samples reflect the filter, as does the
single-run Gantt; **Copy mermaid** still exports the full run.
`show_run_timeline` opens a single run, keeps waiting bars, and returns the CLI
JSON. Use it for a run ID or URL the user names, or after selecting a run from
the Step timeline run list.

**Typical timeline** includes `failureRate` for each step, using the same
failed / executed ratio as **Step statistics**; skipped steps are excluded.
Bars remain blue for zero failures and gray for infrastructure steps with
zero failures. A positive failure rate turns the bar red, from pale red near
0% to solid red at 100%, including infrastructure steps. The tooltip shows
the percentage. Shading reflects the current repository, job, status, runner and attempt
filters. Single-run Gantt colors are unchanged.

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
| Refreshing the panel hits API rate limits | The fleet collection uses `gh runner-kit metrics report` to gather every `fleet` section in one collection when the installed extension supports it, instead of one call per section. An older extension falls back to one call per section and reports a warning suggesting `gh extension upgrade runner-kit`; upgrading removes most of the requests. Reusing an open panel (`set_filters`, not reopening) and narrowing `days`/`includeRepos`/`maxRuns` cut the remaining ones. |
| An organization collection is very slow | `maxRuns` is per repository and defaults to unlimited. Narrow with `includeRepos`, a shorter `days`, or a `maxRuns` cap. |
| Run counts disagree with a number the CLI printed earlier | The panel and a bare CLI call cut the window at the same instant, but a cached collection is older. Call `refresh`. |
| The panel is stale after the extension was edited | `extension.mjs` and `lib/` need an extension reload; `public/` only needs the panel reloaded. |

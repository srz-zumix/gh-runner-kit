# Actions metrics

A Copilot CLI canvas extension that turns `gh runner-kit metrics` into an interactive dashboard for one repository or a whole organization.

The CLI answers one question per invocation and prints a table. This panel runs the reports together over a single window, keeps them in step, and lets you change the window, the filters and the grouping without rebuilding the commands by hand. Every number on screen is also available to the agent as structured JSON, so you can ask about a chart instead of reading it.

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated for every host you point the panel at.
- The `runner-kit` extension itself:

  ```sh
  gh extension install srz-zumix/gh-runner-kit
  ```

  The panel probes the installed binary and names the reports it cannot run, so an older version degrades rather than fails. The **Step timeline** tab needs a build that provides `gh runner-kit metrics steps` and `gh runner-kit job timeline`; older builds show an update notice for that tab while the rest of the dashboard continues to work.

Reading self-hosted runner inventories needs the runner scopes; without them the panel still reports everything derived from workflow runs and jobs, and says which inventory it had to skip.

The extension's `gh` subprocesses ignore `GH_TOKEN` and `GITHUB_TOKEN` inherited from Copilot and use the credentials stored by `gh auth login` by default. In the canvas, open **GitHub authentication** and enter a token to use it as `GH_TOKEN` for the extension's `gh` subprocesses. The token is held in extension-process memory, shared by open dashboards, never returned to the canvas or saved with preferences, and cleared when the extension restarts; **Clear token** returns to the default. You can also set `ACTIONS_METRICS_GH_TOKEN` in the Copilot process environment before launching the extension; the canvas token takes precedence, and clearing it returns to that environment token. These overrides apply to github.com and ghe.com hosts; GitHub Enterprise Server hosts still use stored `gh` credentials. The token needs runner inventory permission for the selected organization. Do not commit tokens to the repository.

## Installation

The extension lives in this repository at `.github/extensions/actions-metrics/`, so a clone is all that is needed — Copilot CLI discovers it automatically and it loads for anyone working in the repo. Nothing to build and no dependencies to install.

To use it outside this repository, copy the directory to `~/.copilot/extensions/actions-metrics/`.

Ask Copilot to open the dashboard, or open the **Actions metrics** canvas from the panel list.

## Tabs

| Tab | What it reports |
| --- | --- |
| **Workflow runs** | Run volume and outcome per day, per-workflow reliability, trigger events, the slowest runs, and the jobs that failed most. |
| **Self-hosted runners** | The registered fleet, how busy each runner was, and the labels they carry. |
| **Queue & capacity** | Queue time per runs-on label set, label demand against capacity, and the pool size each label set needs to hold a target wait. |
| **Runner activity** | Concurrency over time, a per-runner busy heatmap, and one small chart per runner so a single runner's day can be read on its own. |
| **Step timeline** | Per-step statistics across the newest runs of one workflow file, a typical Gantt timeline, trends, run samples, and a single-run job/step Gantt with waiting bars. |
| **Job explorer** | Raw job rows projected in the browser, with faceted filters that apply instantly. |
| **Usage & cost** | Billable time GitHub-hosted runners consumed, split by runner class, and the estimated cost per workflow. |

The **Workflow** column of **Workflows** links to the workflow file on the
repository's default branch, opening the selected GitHub host in a new tab.
This works for both repository and organization targets. Dynamically generated
workflows, such as Copilot and Dependabot, and rows without a file path remain
plain text because there is no repository workflow file to link.

## Step timeline

The **Step timeline** tab samples the newest runs of one workflow file with
`gh runner-kit metrics steps --format ndjson --workflow <file> --max-runs <N>`
and streams `metrics jobs --format ndjson` over the same slice for job
denominators. The workflow selector uses workflow file names, such as `ci.yml`;
GitHub display names like `Build and Test` are not accepted by the CLI. The
footnote always reports how many runs were analysed, the observed time range,
whether the run budget truncated the sample, and the attempt scope.

**Include all attempts** is off by default, preserving GitHub's latest-attempt
job listing (including carried-over jobs). Turn it on to include every attempt
of each sampled run, including failures or timeouts later replaced by a
successful rerun. The panel reads earlier attempts through
`gh runner-kit job timeline --attempt <N>` and reuses the CLI's completed-attempt
cache. Carried-over jobs are counted once, not duplicated. The run budget
still counts workflow runs, not attempts.

Changing the option only edits the next collection; press **Load steps** to
collect with it. The choice survives panel updates while it is pending.
Job, status and runner filter changes reuse the loaded rows and do not apply
pending workflow, run-budget or attempt-mode changes. The option is saved
per target when loaded. In all-attempt mode,
the run list has one row per attempt, and its **Gantt** button opens that
specific attempt. The footnote reports the number of attempts with matching
rows and how many requested historical attempts returned jobs. Missing,
unreadable or empty historical job lists produce a collection warning,
not a claim that the run succeeded. Collection warnings are collapsed by
default; click the warning count to expand or collapse the full messages.
This option requires `metrics collect`,
`metrics runs` and `job timeline` in the installed `gh runner-kit`.

Each row in **Runs and single-run Gantt** also has a **GitHub** link next to
**Gantt**, opening that run's attempt on the selected GitHub host in a new tab.

The tab groups matrix jobs by their base name only when at least two variants
share that base. Infrastructure steps (`Set up job`, `Complete job`, and names starting with `Post` followed by a space) can be hidden. Durations come from GitHub's
second-precision step timestamps, so sub-second values are displayed as `<1s`.
A run ID or Actions run URL opens the single-run Gantt through
`gh runner-kit job timeline`; the **Copy mermaid** button asks the CLI for the
Mermaid output of the same run.

In **Typical timeline**, bars show median step durations. Blue means no
observed step failures, gray marks infrastructure steps, and red marks steps
with failures. Red shading increases with the step failure rate, from pale
red near 0% to solid red at 100%; failures take precedence over the
infrastructure color. Hover over a step to see its failure rate, calculated
as failed executions divided by started, non-skipped executions, matching
the **Fail** column in **Step statistics**. Repository, job, status, runner and attempt
filters also affect the shading. Single-run Gantt colors are unchanged.

For organization targets, **Repository** filters the loaded workflow sample
by an exact `OWNER/REPO`. It defaults to **All repositories** and applies
immediately without collecting again. Repository choices and job counts come
from the whole loaded sample and remain available after other filters narrow
the data; choose **All repositories** to widen it again. The selection is
saved per target and affects statistics, trends, typical timelines, runner
pools and run samples. Job, status and runner choices reflect the selected
repository. The workflow selector also shows that repository's workflow names;
an existing workflow selection stays selected even if it has no matches.
A single-run Gantt from another repository hides its jobs and explains why.
A bare run ID can be opened using the selected repository; **Copy mermaid**
still exports the full open run.

The **Runner** row filters the sampled jobs by runner kind (self-hosted or
GitHub-hosted), `runs-on` label set, runner group and runner name (`*`
wildcards). Filter changes re-aggregate the rows already collected instead of
calling the CLI again; **Load steps** always fetches fresh rows. The
**Runners** card groups jobs by `runs-on` label set with wait and run
percentiles and the failure rate, and clicking a row toggles that label set as
the filter. The selected step is also broken down by label set, the run list
shows the runners of each run, and the single-run Gantt shows each job's
runner name and group.

The **Job** selector filters the loaded sample immediately, without collecting
again. Select **All jobs** to widen it again. Repository, job and runner filters are
unavailable before the first load or while a new collection is in progress.

The **Job status** selector keeps jobs matching a lifecycle status
(`queued`, `in_progress`, `completed`, etc.) or conclusion (`success`,
`failure`, `cancelled`, `skipped`, etc.), including every step of those jobs.
It defaults to **All statuses**, combines with the runner filters, and
re-aggregates collected rows without calling the CLI again. Statistics,
trends, the typical timeline, runner pools and run samples all use the
matching jobs. Status choices and counts come from all sampled jobs in the
selected repository (or all repositories when none is selected) so the
filter can always be widened; a selection with no matches stays visible.
The selection is saved per target. The single-run Gantt also hides jobs that
do not match; **Copy mermaid** still exports the full run.

HTTP endpoints used by the tab:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/step-prefs` | Read per-target Step timeline preferences. |
| `POST /api/steps` | Collect and aggregate step statistics for a workflow file; optional `repository` filters an exact `OWNER/REPO` after collection (empty/default: all). Use `reuseRows: true` to re-aggregate cached rows. |
| `GET /api/run-timeline?run=<id-or-url>&attempt=<n>` | Return one run's timeline JSON. Add `format=mermaid` for Mermaid text. |

## Table sorting

Click a sortable column heading to sort by it; click it again to reverse the direction. In dashboard tables, a third click restores the report's original order. Shift+click another heading to add it as the next tie-breaker, then Shift+click it again to reverse or remove that condition. The arrow and number on each heading show its direction and priority. For example, click **Success** twice for lowest success rate first, then Shift+click **Runs** for the most runs among equally successful workflows. A normal click on another heading starts a new primary sort.

Missing values stay last in either direction. The runner list and Job explorer sort every matching row before paging, not just the current page; their single-column sort cycles between ascending and descending rather than restoring source order.

## Scope

Point the panel at a repository or at an organization. The two are not equivalent:

- An **organization** target covers every repository it owns. The reports `gh runner-kit` aggregates across repositories are available; the per-job cards the dashboard derives itself (queue time, runner usage, cost estimates) are collected one repository at a time and are hidden rather than shown as zero.
- Use **Include repos** / **Exclude repos** to narrow an organization. They are applied before collection, so they also cut the API traffic. They are organization-only, and they are cleared when you switch to a different owner, because a pattern written for one owner can never match another.

## Refresh and rate limits

**Refresh** collects the current window again but reuses the job lists already fetched for completed runs — both the on-disk cache `gh runner-kit` keeps and an in-memory cache of the panel. When a collection stops at a GitHub API rate limit, what was read before the limit is kept, so the next Refresh resumes from there instead of fetching everything again. **Shift+click** Refresh to discard the cache and fetch every run again (`gh runner-kit metrics --refresh`).

The panel stops sending requests to a host as soon as one of them is refused for a rate limit:

- The remaining reports of that collection are skipped and the collection fails as a whole, so the last complete dashboard stays on screen beside a *Rate limited* banner rather than being replaced by mostly empty cards.
- Every request to that host is held back until the limit resets — the reset time reported by `GET /rate_limit`, or one minute for a secondary rate limit — so pressing Refresh in the meantime fails at once without spending budget.
- Before collecting, the panel asks `GET /rate_limit`, which does not count against the limit, and does not start while the budget is exhausted.

## Agent actions

| Action | What it does |
| --- | --- |
| `refresh` | Re-collect the current window, reusing the cached job lists. Pass `bypassCache: true` to discard them and fetch every run again. Fails with `rate_limited` while a rate limit is in effect. |
| `set_filters` | Change the target, the window, the filters, the collection limits or the projection settings, and re-collect. Every field is optional. |
| `get_metrics` | Read what is on screen as structured JSON, by section. |
| `trace_runner` | Rebuild the concurrency timeline from the jobs of the runners matching a query, and draw a per-runner heatmap. |
| `get_step_metrics` | Collect Step timeline statistics for one workflow file across a capped number of newest runs, optionally including all attempts (`includeAllAttempts`, default false), filtering an exact `repository` (`OWNER/REPO`, empty/default: all), focusing a job, merging matrix variants, hiding infrastructure steps, filtering by job status/conclusion or runner kind, `runs-on` labels, group or name, and returning jobs, steps, timeline, trend or runners JSON. |
| `show_run_timeline` | Open one workflow run ID or URL as a single-run job/step Gantt and return the `gh runner-kit job timeline --format json` payload. |
| `export_metrics` | Publish the window through `gh runner-kit metrics export`, as Prometheus text or JSON. |

A section that could not be collected reports why rather than returning zeros, so the agent can tell "nothing ran" apart from "this was never measured".

## Stored state

User-global preferences — the last target and the filters of each target — persist under `$COPILOT_HOME/extensions/actions-metrics/artifacts/` (`~/.copilot/...` when `COPILOT_HOME` is unset). Canvas tokens are not saved there. Nothing is written into the repository.

## Development

Plain ES modules with no build step and no dependencies.

- `extension.mjs` — the canvas declaration, the agent actions, and the JSON projection the agent reads.
- `lib/` — runs on the extension process: the `gh runner-kit` bridge (`runnerkit.mjs`), the `gh` wrapper and the rate limit cooldown (`gh.mjs`), collection (`collect.mjs`) and its job cache (`jobcache.mjs`), aggregation (`metrics.mjs`), the canonical query model (`query.mjs`), the loopback HTTP server (`server.mjs`), and the stores.
- `public/` — runs in the iframe: rendering, charts, and the Job explorer.
- `shared/` — imported by both sides, so a field cannot be spelled one way on the server and another in the browser.

Tests use the Node.js built-in runner and never reach GitHub:

```sh
node --test .github/extensions/actions-metrics/test/
```

After editing `public/`, reload the panel — it is served per request, with no caching. After editing `extension.mjs` or `lib/`, reload the extension. `shared/` needs both: the browser re-reads it on a panel reload, but the extension process imports it too and holds it until it restarts.

> [!IMPORTANT]
> `stdout` carries JSON-RPC. Never `console.log` from `extension.mjs` or `lib/` — use `session.log`.

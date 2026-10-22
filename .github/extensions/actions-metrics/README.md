# Actions metrics

A Copilot CLI canvas extension that turns `gh runner-kit metrics` into an interactive dashboard for one repository or a whole organization.

The CLI answers one question per invocation and prints a table. This panel runs the reports together over a single window, keeps them in step, and lets you change the window, the filters and the grouping without rebuilding the commands by hand. Every number on screen is also available to the agent as structured JSON, so you can ask about a chart instead of reading it.

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated for every host you point the panel at.
- The `runner-kit` extension itself:

  ```sh
  gh extension install srz-zumix/gh-runner-kit
  ```

  The shared dataset requires a current build with `metrics collect --all-attempts --pricing`, `metrics snapshot`, `metrics report`, row commands and `job timeline --input`. Older builds show an explicit update error rather than silently collecting inconsistent tab datasets.

Reading self-hosted runner inventories needs the runner scopes; without them the panel still reports everything derived from workflow runs and jobs, and says which inventory it had to skip.

The extension's `gh` subprocesses ignore `GH_TOKEN` and `GITHUB_TOKEN` inherited from Copilot and use the credentials stored by `gh auth login` by default. In the canvas, open **GitHub authentication** and enter a token to use it as `GH_TOKEN` for the extension's `gh` subprocesses. The token is held in extension-process memory, shared by open dashboards, never returned to the canvas or saved with preferences, and cleared when the extension restarts; **Clear token** returns to the default. You can also set `ACTIONS_METRICS_GH_TOKEN` in the Copilot process environment before launching the extension; the canvas token takes precedence, and clearing it returns to that environment token. These overrides apply to github.com and ghe.com hosts; GitHub Enterprise Server hosts still use stored `gh` credentials. The token needs runner inventory permission for the selected organization. Do not commit tokens to the repository.

## Installation

The extension lives in this repository at `.github/extensions/actions-metrics/`, so a clone is all that is needed — Copilot CLI discovers it automatically and it loads for anyone working in the repo. Nothing to build and no dependencies to install.

To use it outside this repository, copy the directory to `~/.copilot/extensions/actions-metrics/`.

Ask Copilot to open the dashboard, or open the **Actions metrics** canvas from the panel list.

## Settings

**Collection** and **Display** have separate drafts, pending-change counts,
**Reset** and **Apply** buttons. Opening or applying one does not apply or
discard the other's edits. Untouched fields follow live updates; conflicting
edits show a warning. A target change discards drafts written for the old target.

**Collection** contains the collection period, event, branch, workflow,
repository filters, runner inventory, billable time and run limit. Changing
these fetches a new dataset. Its **Execution** settings change request
concurrency for the next collection only, without collecting immediately.
It bounds both workflow run-page requests and per-run data requests. Run
discovery reads the first page, then fetches only the remaining advertised pages
needed by the run limit in parallel, preserving page order. Set concurrency to
**1** for sequential requests; servers without a last-page link also use that
path. Recent run metadata is read afresh; historical run discovery can use
the one-hour cache described below.
**Display** contains dataset period filtering, report labels/grouping/buckets,
self-hosted filtering, capacity targets, runner projections and explorer row
limits. These re-read the retained snapshot without GitHub requests;
they cannot be applied before a dataset is loaded or during collection.

In **Collection**, optional **Collection start** and **Collection end**
select an inclusive-start, exclusive-end period by workflow run creation time.
The controls use your local timezone and send absolute timestamps to the CLI.
An empty start uses **Window** days back from the end; an empty end uses now.
API inputs `since` and `until` accept RFC3339 or `YYYY-MM-DD` (midnight UTC).
`since` overrides `days` (default 30). A custom end requires a CLI build with
`metrics collect --until`.

After loading, **Display → Dataset period filter** narrows the retained dataset
without GitHub requests. Optional `filterFrom` and `filterTo` are inclusive
start and exclusive end; an empty bound uses that side of the collected period.
Both must stay within the coverage shown below the group heading. Press
**Clear period filter**, then **Apply**, to restore the whole original dataset.
All tabs, agent summaries, job/step rows, single-run timelines and exports use
the same selected runs and their jobs, including historical attempts. Loaded
steps, runner projections and explorer rows are re-read when the filter changes.
Runner occupancy charts still clip job intervals to the selected window; step
durations and cost minutes retain whole executions, not partial-job estimates.
Inventory remains the current inventory, not a historical inventory.

Both period groups offer **Today**, **Yesterday**, **This week**, **Last week**,
**This month**, **Last month**, **Last 7 days** and **Last 30 days** presets.
Calendar boundaries use your local timezone, with weeks starting on Monday;
rolling days are exact 24-hour periods. Presets only populate their own draft:
press that editor's **Apply** to use them. Current collection periods keep the
end empty, meaning now when applied; completed periods have a fixed exclusive
end. Rolling collection presets set **Window** to 7 or 30 and clear both
dates, so subsequent refreshes still cover that many days.
Dataset presets select only the intersection with collected coverage.
Partial coverage is marked in the preset menu and shows the requested and
available dates, explicitly identifying missing dates as not analysed.
Presets with no overlap are disabled. Manually entered dataset bounds still
reject dates outside coverage; they are not silently clipped.

Collection changes clear the dataset filter unless new bounds are explicitly
provided. Dataset filters are not saved as user-global preferences.
`metrics.meta.dataset.window` describes the selected period,
`collectionWindow` the original coverage, and `sourceId` the retained collection
identity; `runs`/`jobs` are selected counts and `collectedRuns`/`collectedJobs`
are original counts. Invalid, reversed, future collection bounds and filters
outside coverage report errors rather than silently widening or swapping dates.

## Tabs

| Tab | What it reports |
| --- | --- |
| **Workflow runs** | Run volume and outcome per day, per-workflow reliability, trigger events, the slowest runs, and the jobs that failed most. |
| **Self-hosted runners** | The registered fleet, how busy each runner was, and the labels they carry. |
| **Queue & capacity** | Queue time per runs-on label set, label demand against capacity, and the pool size each label set needs to hold a target wait. |
| **Runner activity** | Concurrency over time, a per-runner busy heatmap, and one small chart per runner so a single runner's day can be read on its own. |
| **Step timeline** | Per-step statistics across the newest runs of one workflow file, a typical Gantt timeline, trends, run samples, and a single-run job/step Gantt with waiting bars. |
| **Job explorer** | Raw job rows projected in the browser, with faceted filters that apply instantly. |
| **Usage & cost** | GitHub-hosted execution estimates by billing SKU, CPU, RAM and architecture, with known subtotals and unpriced job counts per workflow. |

The Job explorer's **Row budget** accepts 500 to 1,000,000 job rows, with a
default of 20,000. It controls the rows held in the browser, not the shared
dataset or fleet metrics. Raising it increases memory use and processing time.
Row payloads remain JSON, but serialization and worker decoding use bounded
batches to avoid the JavaScript single-string limit.

The **Workflow** column of **Workflows** links to the workflow file on the
repository's default branch, opening the selected GitHub host in a new tab.
This works for both repository and organization targets. Dynamically generated
workflows, such as Copilot and Dependabot, and rows without a file path remain
plain text because there is no repository workflow file to link.

## Hosted runner names

Hosted instance names are grouped by their stable runner type across listings,
aggregation and runner filters. For example, `ubuntu-latest-large-123` becomes
`ubuntu-latest-large` when its `RunnerID` is `123`; `GitHub Actions 123` becomes
`GitHub Actions`. Other runner types remain separate. Self-hosted and unknown
runner names are unchanged, and an unmatched numeric suffix is never guessed
to be an instance ID.

The original `RunnerID` remains in job rows, step rows and run timelines.
Hover over a runner name in the Job explorer job table to see the instance ID.
Grouping a runner type does not identify its hardware or change its price.

## Usage and cost

Standard workflow labels and current hosted-runner definitions, including
enterprise pools inherited through organization runner groups,
select [USD list prices](https://docs.github.com/en/billing/reference/actions-runner-pricing),
including Larger, arm64 and GPU variants. Each completed job is rounded up to
whole minutes. Standard runners are free in public repositories; Larger runners
are billed even there. Self-hosted infrastructure costs are excluded.

Skipped jobs and cancellations without runner allocation, a started
non-skipped step or positive per-job usage are excluded from cost counts,
minutes and unknown-price coverage. Cancellations after execution began remain
included. The shared job
rows carry `ExecutionStarted`; timestamps and requested labels alone do not
prove execution.

Custom pool labels are matched to runner-definition names, not ephemeral job
runner IDs. Reading definitions and groups requires organization administration
or runner/runner-group read permissions. Inherited pools are read through the
organization's runner-group endpoints without enterprise-wide management access.
Missing permissions, visibility, ambiguous labels or unsupported hardware
produce **Unknown** prices (`null` in agent JSON), never an assumed standard
rate. The window and workflow tables expose a known subtotal and unpriced jobs.
Machine tables show runner type separately from price availability. Unknown
values for positively identified self-hosted runners display
**Unknown (self-hosted)**; jobs without runner-type evidence remain **Unknown**.
Self-hosted infrastructure costs are still excluded, and inclusion in the
self-hosted fleet filter alone does not establish a runner's type.
Current pool specifications and repository visibility cannot prove historical
hardware or visibility. Included minutes, discounts, storage and historical
price changes are excluded; estimates are not invoices.

Repository targets estimate costs from collected jobs. Organization targets
use the CLI cost section when **Read billable time** is enabled. That section
requires a machine-aware `gh runner-kit` build; older OS-only reports remain
unpriced with an update notice. The current-billing-cycle timing API reports
OS totals without machine SKUs, so it displays minutes only, not estimated
dollars. The CLI and independently installable canvas bundle the same versioned
price catalog; a regression test checks the copies for equality.

## Step timeline

Every tab uses one retained `metrics collect --all-attempts --pricing`
snapshot. **Read billable time** additionally enables `--usage`.
Native summaries and cost estimates use its jobs; fleet reports, steps,
job rows, runner projections, exports and single-run timelines read the same
snapshot without independent API collections. Saturated run searches split
the period to avoid GitHub's 1,000-result search cap. Refresh replaces the
dataset and invalidates dependent views. `metrics.meta.dataset` records its
identity, window, job/run counts, attempt scope and coverage warnings.
Current-billing-cycle workflow totals are deliberately not collected: their
period is outside this execution dataset and the card says so explicitly.
Cost minutes sum each completed job's rounded-up minutes; Step total run
sums unrounded execution durations. Parallel jobs and reruns contribute
separately in both, so neither measures workflow wall-clock time.

The **Step timeline** tab selects the newest retained runs of one workflow
and reads `metrics steps --input` for those jobs. Job denominators come from
the shared job rows. The workflow selector uses workflow file names, such as `ci.yml`;
GitHub display names like `Build and Test` are not accepted by the CLI. The
footnote always reports how many runs were analysed, the observed time range,
whether the run budget truncated the sample, and the attempt scope.

**Runs** defaults to 500 and accepts 0–5000. Set it to **0** to remove the
run-count limit and read every available run of the selected workflow within
the analysis window; positive values sample that many newest runs per
repository. Editing the value does not fetch immediately: press **Load steps**
to apply it. This is a local view budget, not a new API collection. It cannot
expand beyond the global window or max-runs budget. Missing historical job
data still produces warnings.

**Include all attempts** is off by default, preserving GitHub's latest-attempt
job listing (including carried-over jobs). Turn it on to include every attempt
of each sampled run, including failures or timeouts later replaced by a
successful rerun. Every available attempt is already retained in the shared
snapshot. Carried-over jobs are counted once, not duplicated. The run budget
still counts workflow runs, not attempts.

Changing the option only edits the next view; press **Load steps** to
apply it without collecting again. The choice survives panel updates while it is pending.
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
`gh runner-kit job timeline --input`; the **Copy mermaid** button asks the CLI for the
Mermaid output of the same run.

In **Typical timeline**, bars show median step durations. Blue means no
observed step failures, gray marks infrastructure steps, and red marks steps
with failures. Nonzero failure rates use a minimum 30% red blend for visibility,
increasing continuously to solid red at 100%; failures take precedence over the
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

The **Runner** row uses searchable checkbox facets, like Job explorer, for
**Kind**, **Runs-on**, **Group** and **Name**. Each facet accepts multiple
values: values within one facet are ORed, while different facets are ANDed.
An empty selection means all values. Names match literally, including `*`;
runs-on sets match the complete label set, ignoring label order and case.
Selected values have removable chips; **Clear runner filter** clears every
runner facet. Filter changes re-aggregate loaded rows without GitHub requests;
**Load steps** reads retained snapshot rows.

The **Runners** card reflects the same repository, job, status and runner
filters as the sample statistics and run list. It groups matching jobs by
`runs-on` label set with wait/run percentiles, **Total run** and failure rate.
Clicking a pool row toggles that label set in **Runs-on**.
Total run sums completed job execution times,
excluding wait; parallel jobs and included attempts are added separately,
so it is cumulative runner time rather than elapsed wall-clock time.
Jobs without complete execution timestamps are omitted from the total;
no completed timing samples display a dash, not zero.
Hover over **Total run** to see the total in minutes, with up to two decimal places.
Non-hosted pools start collapsed. Click **+** next to a label set to expand
individual runners by name, with the same job counts, wait/run percentiles,
total run time and failure rate. GitHub-hosted jobs remain aggregated, including
in mixed pools. Jobs without an assigned runner appear as **(unassigned)**
without a selectable name.

Click an individual runner's name or row to toggle its exact name in **Name**,
without implicitly selecting its kind or label set. Other selections remain.
Pool and individual summaries are filtered, but facet choices still cover all
sampled jobs in the selected repository, so hidden runners or pools can be
added through the checkboxes. Expansion stays open across filter updates.
Saved scalar filters remain supported; a saved wildcard name appears as a
separate removable **Name pattern** chip.

The selected step is also broken down by label set, the run list
shows runs containing matching jobs, not only runs where every job matches.
The single-run Gantt shows each job's runner name and group and is not
narrowed by the runner facets.

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

Choose **Succeeded on re-run (all attempts)** to find jobs whose latest
execution succeeded after an observed earlier `failure`, `timed_out` or
`startup_failure` in the same run. Both the failed and successful attempts
remain in statistics, runner totals, trends and the run list; successful
steps inside a failed job also remain. Matching uses the exact repository,
workflow file, run ID and original job name, before merging matrix variants
or applying runner filters. A different matrix variant's success does not
recover a failed job. Existing repository, job and runner filters still apply
to the selected history and can narrow which attempts are shown.

This option automatically uses all attempts and locks **Include all attempts**
on while selected, without overwriting the normal attempt preference. Clearing
the status filter restores that preference. It reuses the retained shared
dataset; switching attempt scope may read local step rows, but makes no new
GitHub requests. Missing historical data cannot establish a recovery; a
cancellation alone does not qualify. Ambiguous same-name jobs within an attempt
are excluded with a collection warning. For a run in the loaded run list, its
single-run Gantt keeps the recovered job on both failed and successful attempts.
An independently opened run outside that list reports unavailable recovery
membership rather than guessing. Use `jobStatus: "rerun_success"` in
`get_step_metrics` or `POST /api/steps` for the same filter, optionally with
`reuseRows: true`; it overrides latest-only display even when
`includeAllAttempts` is false.

Use **Step conditions (AND)** to combine multiple step outcomes, for example
**A = failure AND B = success**. Choose a **Step** and **Conclusion**, then
press **Add condition** for each requirement. Merely editing these two choices
does not change the filter. All condition chips must match within the **same
job execution in the same attempt**. Remove a chip to drop one requirement, or
use **Clear step conditions** to remove them all.

Loading a different workflow with **Load steps** clears conditions, including
legacy failed-step selections, and resets the condition composer. Reloading the
same workflow preserves them. Other filters and view settings are unchanged;
merely editing the workflow selection does not affect the loaded sample.

Matching jobs retain all their steps, including successful and skipped steps,
subject to the existing step and infrastructure display settings. Conditions
check step conclusions, not the enclosing job's conclusion: a successful job
can contain a failed `continue-on-error` step. `failure`, `success`, `skipped`,
`cancelled` and `timed_out` are distinct outcomes; a missing or unfinished step
does not satisfy a success condition.

Names are exact and case-sensitive; `*` is literal. Repeated names are separate
choices by their occurrence within the job, not by the step number. The second
`Upload` is distinct from a literal `Upload #2`. Choices and outcome counts cover
the selected repository's loaded sample independently of job, status, runner
and display filters, including steps that have never failed. Saved zero-match
conditions remain visible and removable.

Adding, removing or clearing conditions reuses loaded rows without CLI calls,
saves per target, and applies to statistics, trends, typical timelines, runner
totals and run samples. Exact repository, workflow, run, attempt and job
identities are checked before matrix merging: a sibling job, another matrix
variant or a successful retry cannot supply a missing condition. The current
attempt scope is preserved; enable **Include all attempts** and **Load steps**
to search earlier attempts. With **Succeeded on re-run (all attempts)**,
recovery is classified from full history first, then these conditions narrow
which attempts remain.

For `get_step_metrics` or `POST /api/steps`, use this payload:

```json
{
  "workflow": "ci.yml",
  "includeAllAttempts": true,
  "stepConditions": [
    { "name": "A", "conclusion": "failure" },
    { "name": "B", "conclusion": "success" }
  ],
  "reuseRows": true
}
```

Each condition requires a nonempty `name` and `conclusion`; optional
`occurrence` defaults to 1. Conclusions are normalized to lowercase.
`stepConditions: []` or `null` clears conditions. When `stepConditions` is
omitted, legacy `failedStep: { name: "Compile", occurrence: 1 }` still means
one failure condition, and saved legacy selections migrate automatically.
An explicit empty conditions array overrides any old `failedStep` value, so
clearing cannot reactivate it. Identical conditions are deduplicated.

Responses echo normalized `stepConditions`. `stepConditionFacets` entries
contain `name`, `occurrence`, distinct job-attempt `count`, and `conclusions`
with `{ "value": "success", "count": 1 }`-style outcome counts.
`failedStep` and `failedStepFacets` remain available for compatibility;
`failedStep` is non-null only for a single failure condition.
The single-run Gantt checks all conditions against each job's own steps,
including for manually opened runs, without removing its other steps.
**Copy mermaid** remains unfiltered. The condition composer appears only when
the provider supports it; an older provider retains the legacy failure selector
until reloaded.

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

**Refresh** replaces the shared dataset, reusing CLI disk caches for completed jobs,
historical attempt metadata and billable usage. Step, Explorer and projections then
read that new dataset. **Shift+click** Refresh to bypass the CLI cache
(`gh runner-kit metrics collect --refresh`).

Rate-limited collections resume automatically one second after the reported reset
time while a panel remains on the target. Repeated rate limits schedule another
retry. Automatic retries keep the original collection period and reuse caches,
even when the interrupted collection was a hard refresh. A manual Refresh starts a
new period unless `until` is explicit. The last complete dataset remains visible
until the replacement collection succeeds.

Manual collection, changed collection settings or credentials, closing the last
panel for a target, and extension shutdown cancel its pending retry. Reopening a
paused target can schedule it again; extension restarts lose in-memory retry state
and start a new collection. They do not discard CLI disk caches.

The **Collection progress** card streams the current stage, repository ordinal,
processed/total listings, cache hits, fresh reads and skipped records. A progress
bar is relative to the current stage only: organization-wide totals are not known
at startup, so no whole-collection percentage or ETA is invented. Skipped records
are processed but unavailable, not successful reads.

During **Finding workflow runs**, the card shows the current search period
(UTC), search ordinal and unique runs discovered in the current repository.
Run discovery precedes reading cached job lists. Complete UTC days ending at
least 24 hours ago can reuse a disk listing cache for at most one hour.
The latest 24 hours and partial boundary days are always fetched afresh.
Adjacent misses are searched together, so quiet cold collections do not require
one request per day. Saturated searches prefer UTC-midnight boundaries and save
each fully covered historical day immediately. If a later search fails or the
collection is interrupted, the next attempt can reuse completed days while they
remain within the one-hour TTL; it does not have to finish the whole window
before saving any discovery work. Incomplete days and capped prefixes are not
marked complete. Each day's freshness starts at its earliest contributing
request; completing a larger ancestor search does not extend it.
Caches are separated by credentials, host, repository, branch, event and
workflow. The first collection still reads historical runs; later collections
and extension restarts can reuse them until expiry. Historical reruns, status
changes and deletions can take up to one hour to appear. **Shift+click Refresh**
bypasses listing caches as well as per-run caches.

`runSearch.cachedWindows` and the **cached days** count show reused UTC days,
not newly saved checkpoints; the initial collection can still show zero while
saving days for a later attempt. An entirely historical cached window can use zero
searches. Large windows split into multiple searches; counters update between
searches, not on every API page. Discovered IDs are deduplicated across searches,
but are not yet the final selected total and have no percentage.
While collecting, elapsed time and time since the last collector update tick
every second, even when no new telemetry arrives. The latter is an update age,
not proof that the collector has stalled. Older progress-enabled CLI builds
still show these timers and explain when run-search counters are unavailable.

After a rate limit, the last reported counters stay visible with the retry time
and countdown. The next ordinary Refresh shows the new attempt separately from
the last interrupted stage; counts are never added across attempts, and a rolling
window may change the totals. Available cached completed job/usage listings are
reused. Completed historical metadata is cached separately from jobs; an attempt
counts as cached only when both are reused. Uncached listings may require several
pages, and older CLI versions may still request metadata for cached job lists.
Hard refresh, a changed collection query or changed
credentials clears the previous attempt's counters. Display-only changes retain
the source collection's progress.

Detailed counters require `gh runner-kit metrics collect --progress`; older
versions remain usable with an explicit update notice and stage messages instead
of fabricated counters. Progress and retry history are in-memory and clear on
extension restart. An API/cache-complete event does not mark the source dataset
complete until snapshot processing and dashboard reports succeed.

Raw snapshots are decoded and filtered by the Go CLI's offline `metrics snapshot`
command, not converted into a single Node.js string. Only compact metadata and
run/job row streams enter the extension, so snapshots larger than Node's
single-string limit remain usable. Period filtering also stays in Go, preserving
exact int64 IDs, carried-over jobs, historical attempts, usage and inventory.
Neither operation makes GitHub requests or lowers the selected run coverage.

Dashboard statistics and chart scales scan values with a fixed function-argument
count, so hundreds of thousands of samples do not overflow the JavaScript call
stack. All selected runs and jobs still contribute; no sampling or run cap is
introduced.

The panel stops sending requests to a host as soon as one of them is refused for a rate limit:

- The remaining reports of that collection are skipped and the collection fails as a whole, so the last complete dashboard stays on screen beside a *Rate limited* banner rather than being replaced by mostly empty cards.
- Every request to that host is held back until the limit resets — the reset time reported by `GET /rate_limit`, or one minute for a secondary rate limit — so pressing Refresh in the meantime fails at once without spending budget.
- Before collecting, the panel asks `GET /rate_limit`, which does not count against the limit, and does not start while the budget is exhausted.

## Agent actions

| Action | What it does |
| --- | --- |
| `refresh` | Re-collect the current window, reusing completed job lists and historical metadata. Pass `bypassCache: true` to ignore caches for this attempt. Fails with `rate_limited` during cooldown and schedules automatic resume with caches. |
| `set_filters` | Change the target, the window, the filters, the collection limits or the projection settings, and re-collect. Every field is optional. |
| `get_metrics` | Read what is on screen as structured JSON, by section. |
| `get_collection_progress` | Read collection status, current attempt and last interrupted stage, counters, error code, reset time and scheduled `autoRetryAt`. Takes no input, does not wait for collection and makes no GitHub requests. |
| `trace_runner` | Rebuild the concurrency timeline from the jobs of the runners matching a query, and draw a per-runner heatmap. |
| `get_step_metrics` | Collect Step timeline statistics for one workflow file across a capped number of newest runs, optionally including all attempts (`includeAllAttempts`, default false), filtering an exact `repository` (`OWNER/REPO`, empty/default: all), focusing a job, merging matrix variants, hiding infrastructure steps, filtering by job status/conclusion or runner facets (`runnerKinds`, `runsOnSets`, `runnerGroups`, `runnerNames`), and returning jobs, steps, timeline, trend or filtered runners JSON. Legacy scalar runner filters remain supported. |
| `show_run_timeline` | Open one workflow run ID or URL as a single-run job/step Gantt and return the `gh runner-kit job timeline --format json` payload. |
| `export_metrics` | Publish the window through `gh runner-kit metrics export`, as Prometheus text or JSON. |

`get_step_metrics` with `section: "runners"` returns each pool's non-hosted
`individuals`, grouped by `name`, with the same statistics as the parent.
Hosted-only pools return an empty list. Optional array inputs select multiple
values: `runnerKinds` uses exact raw kinds (`hosted`, `self-hosted`, `unknown`),
`runsOnSets` contains comma-separated label sets, `runnerGroups` contains exact
group names and `runnerNames` contains exact names, with literal asterisks.
All arrays default to empty, meaning no restriction in that facet. Values
within a facet are ORed, including any legacy scalar value; facets are ANDed.
`POST /api/steps` uses the equivalent `runnerFilter.kinds`, `.labelSets`,
`.groups` and `.names` arrays. Pass `reuseRows: true` to reuse loaded rows.

Legacy `runnerKind` defaults to `all`; `self-hosted` includes unidentified
non-hosted jobs, matching the CLI. Legacy `runsOn`, `runnerGroup` and `runner`
default to empty. `runner` supports `*` wildcards unless `runnerExact: true`
(default false). HTTP requests use the corresponding `runnerFilter.kind`,
`.labels`, `.group`, `.name` and optional `.nameExact` fields.

A section that could not be collected reports why rather than returning zeros, so the agent can tell "nothing ran" apart from "this was never measured".

The **Partial data** banner starts collapsed and shows the warning count.
Click its heading to inspect every warning; the open state survives panel
updates. Collection errors remain visible. **Load job rows** reads the current
shared dataset and receives completion updates for that dataset revision;
loading or filtering Explorer rows does not start a separate API collection.

## Stored state

User-global preferences — the last target and the filters of each target — persist under `$COPILOT_HOME/extensions/actions-metrics/artifacts/` (`~/.copilot/...` when `COPILOT_HOME` is unset). Canvas tokens are not saved there. Nothing is written into the repository.

## Development

The opt-in large-snapshot regression creates compressed synthetic data exceeding
Node's actual string limit and checks metadata loading plus filtered rewriting.
It needs a current CLI build and additional memory:

```sh
go build -o gh-runner-kit .
RUNNER_KIT_BINARY="$PWD/gh-runner-kit" RUNNER_KIT_LARGE_SNAPSHOT_TEST=1 node --test .github/extensions/actions-metrics/test/snapshot.test.mjs
```

The opt-in large-row regression serializes and decodes one million synthetic job
rows above Node's single-string limit. It also requires additional memory:

```sh
RUNNER_KIT_LARGE_ROW_TEST=1 \
  node --test .github/extensions/actions-metrics/test/rowpayload.test.mjs
```

Plain ES modules with no build step and no dependencies.

- `extension.mjs` — the canvas declaration, the agent actions, and the JSON projection the agent reads.
- `lib/` — runs on the extension process: the `gh runner-kit` bridge (`runnerkit.mjs`), the `gh` wrapper and rate limit cooldown (`gh.mjs`), shared snapshot ownership (`dataset.mjs`), aggregation (`metrics.mjs`), the canonical query model (`query.mjs`), the loopback HTTP server (`server.mjs`), and the stores.
- `public/` — runs in the iframe: rendering, charts, and the Job explorer.
- `shared/` — imported by both sides, so a field cannot be spelled one way on the server and another in the browser.

Tests use the Node.js built-in runner and never reach GitHub:

```sh
node --test .github/extensions/actions-metrics/test/
```

After editing `public/`, reload the panel — it is served per request, with no caching. After editing `extension.mjs` or `lib/`, reload the extension. `shared/` needs both: the browser re-reads it on a panel reload, but the extension process imports it too and holds it until it restarts.

> [!IMPORTANT]
> `stdout` carries JSON-RPC. Never `console.log` from `extension.mjs` or `lib/` — use `session.log`.

# Actions metrics

A Copilot CLI canvas extension that turns `gh runner-kit metrics` into an interactive dashboard for one repository or a whole organization.

The CLI answers one question per invocation and prints a table. This panel runs the reports together over a single window, keeps them in step, and lets you change the window, the filters and the grouping without rebuilding the commands by hand. Every number on screen is also available to the agent as structured JSON, so you can ask about a chart instead of reading it.

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated for every host you point the panel at.
- The `runner-kit` extension itself:

  ```sh
  gh extension install srz-zumix/gh-runner-kit
  ```

  The panel probes the installed binary and names the reports it cannot run, so an older version degrades rather than fails.

Reading self-hosted runner inventories needs the runner scopes; without them the panel still reports everything derived from workflow runs and jobs, and says which inventory it had to skip.

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
| **Job explorer** | Raw job rows projected in the browser, with faceted filters that apply instantly. |
| **Usage & cost** | Billable time GitHub-hosted runners consumed, split by runner class, and the estimated cost per workflow. |

## Scope

Point the panel at a repository or at an organization. The two are not equivalent:

- An **organization** target covers every repository it owns. The reports `gh runner-kit` aggregates across repositories are available; the per-job cards the dashboard derives itself (queue time, runner usage, cost estimates) are collected one repository at a time and are hidden rather than shown as zero.
- Use **Include repos** / **Exclude repos** to narrow an organization. They are applied before collection, so they also cut the API traffic. They are organization-only, and they are cleared when you switch to a different owner, because a pattern written for one owner can never match another.

## Agent actions

| Action | What it does |
| --- | --- |
| `refresh` | Re-collect the current window. |
| `set_filters` | Change the target, the window, the filters, the collection limits or the projection settings, and re-collect. Every field is optional. |
| `get_metrics` | Read what is on screen as structured JSON, by section. |
| `trace_runner` | Rebuild the concurrency timeline from the jobs of the runners matching a query, and draw a per-runner heatmap. |
| `export_metrics` | Publish the window through `gh runner-kit metrics export`, as Prometheus text or JSON. |

A section that could not be collected reports why rather than returning zeros, so the agent can tell "nothing ran" apart from "this was never measured".

## Stored state

User-global preferences — the last target and the filters of each target — persist under `$COPILOT_HOME/extensions/actions-metrics/artifacts/` (`~/.copilot/...` when `COPILOT_HOME` is unset). Nothing is written into the repository.

## Development

Plain ES modules with no build step and no dependencies.

- `extension.mjs` — the canvas declaration, the agent actions, and the JSON projection the agent reads.
- `lib/` — runs on the extension process: the `gh runner-kit` bridge (`runnerkit.mjs`), the `gh` wrapper (`gh.mjs`), collection (`collect.mjs`), aggregation (`metrics.mjs`), the canonical query model (`query.mjs`), the loopback HTTP server (`server.mjs`), and the stores.
- `public/` — runs in the iframe: rendering, charts, and the Job explorer.
- `shared/` — imported by both sides, so a field cannot be spelled one way on the server and another in the browser.

After editing `public/`, reload the panel — it is served per request, with no caching. After editing `extension.mjs` or `lib/`, reload the extension. `shared/` needs both: the browser re-reads it on a panel reload, but the extension process imports it too and holds it until it restarts.

> [!IMPORTANT]
> `stdout` carries JSON-RPC. Never `console.log` from `extension.mjs` or `lib/` — use `session.log`.

---
name: gh-runner-kit
description: GitHub CLI extension (gh runner-kit) for managing GitHub Actions self-hosted runners — listing runners, cordoning/uncordoning them to stop or resume job scheduling without deleting the registration, downloading/registering/running the actions/runner agent, and reporting fleet utilization, queue time, label demand, concurrency and per-workflow cost.
---

# gh-runner-kit

Reference for gh-runner-kit — a GitHub CLI extension for GitHub Actions
self-hosted runner operations: listing runners, controlling whether they receive
new jobs (cordon / uncordon), running the runner agent itself, and reporting how
the fleet is used.

Version: 0.1.0

## Prerequisites

### Installation

```bash
gh extension install srz-zumix/gh-runner-kit
```

### Authentication

```bash
gh auth login
```

Repository-level runner operations require repository admin permission.
Organization-level runner operations (including the `group` cordon strategy)
require organization owner permission.

## CLI Structure

```
gh runner-kit                # Root command
├── available                # List runners a repository can use
├── cordon                   # Stop runners from receiving new jobs
├── group                    # Organization runner groups
│   ├── create                # Create a runner group
│   ├── delete                # Delete a runner group
│   ├── list                  # List the runner groups of an organization
│   ├── repos                 # List the repositories that can use a group
│   ├── runner                # Runners of a runner group
│   │   ├── add                # Move a runner into a runner group
│   │   ├── list               # List the runners of a runner group
│   │   └── remove             # Remove a runner from a runner group
│   ├── update                # Update the settings of a runner group
│   └── view                  # Show the settings of a runner group
├── list                     # List self-hosted runners (organization by default)
├── metrics                  # Runner utilization and queue time reports
│   ├── concurrency           # Jobs running at the same time, per time bucket
│   ├── label                 # Demand and supply per single label
│   ├── queue                 # Wait time per runs-on label set
│   ├── runner                # Activity per runner, label set or group
│   ├── summary               # Fleet overview
│   └── workflow              # Failure rate, duration and retry rate per workflow
├── run                      # Download, register and run a runner agent
└── uncordon                 # Let cordoned runners receive jobs again
```

## Target Selection

`list`, `cordon` and `uncordon` target either an organization or a repository:

- `--type org` (default) — organization-level runners, using `--owner` or the
  owner of the current repository.
- `--type repo` — the runners registered to `--repo` (or the current
  repository). Passing `--repo` explicitly implies `--type repo`.

`available` always targets a repository, and every `group` subcommand always
targets an organization.

Every `group` subcommand that takes a `<group>` argument accepts either the
runner group name or its ID, and `group runner add` / `group runner remove`
accept the runner name or its ID the same way.

`available`, `list` and `group runner list` share the same `--status` filter.
The runner APIs only report `online` and `offline`, so `active` and `idle` are
derived from the `BUSY` field: `active` is an online runner running a job and
`idle` is an online runner waiting for one.

`cordon` and `uncordon` additionally select *which* runners to act on. Exactly
one selection flag is required:

- `--id ID` — a single runner by numeric ID.
- `--name NAME` — a single runner by name.
- `--label LABEL` — every runner carrying that label.
- `--all` (`uncordon` only) — every currently cordoned runner.

## Commands

### available

Lists every self-hosted runner a repository can schedule jobs on: the runners
registered to the repository itself plus the organization runners belonging to
each runner group visible to the repository (`all`, `private` for private
repositories, or `selected` when the repository is on the group's list).

```bash
gh runner-kit available [--repo [HOST/]OWNER/REPO] [--status online|offline|active|idle] \
  [--name-only] [--fields FIELD,...] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | `ID,NAME,OS,STATUS,BUSY,CORDONED,LABELS` | Table columns to display |
| `--format` | - | Output format: `json`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the runner names |
| `-R`, `--repo` | current repository | Select a repository |
| `--status` | all statuses | Keep only the runners in this status: `online`, `offline`, `active` or `idle` |
| `-t`, `--template` | - | Format JSON output using a Go template |

Reading the organization runner groups requires organization owner permission.
Runner groups are an organization feature, so only the repository-level runners
are listed for a user-owned repository.
Use `list --type repo` instead when only repository-level runners are needed.

### cordon

Marks self-hosted runners so no new jobs are scheduled on them, without deleting
the runner registration.

```bash
gh runner-kit cordon [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] \
  (--id ID | --name NAME | --label LABEL) \
  [--strategy group|label] [--group NAME] \
  [--group-visibility selected|all|private] [--label-prefix PREFIX] [--dryrun]
```

| Option | Default | Description |
| --- | --- | --- |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--group` | `gh-runner-kit-cordoned` | Name of the isolated runner group used by the `group` strategy |
| `--group-visibility` | `selected` | Visibility of the isolated runner group when it is created |
| `--id` | - | Select the runner to cordon by ID |
| `--label` | - | Select every runner that has this label |
| `--label-prefix` | `cordoned-` | Prefix applied to custom labels by the `label` strategy |
| `--name` | - | Select the runner to cordon by name |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |
| `--strategy` | `group` | Cordon strategy: `group` or `label` |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `org` or `repo` |

Strategies:

- `group` (default, **organization-level only**): moves the runner into an
  isolated runner group whose visibility is restricted, so no `runs-on:` in any
  repository can match it. The original runner group ID is recorded as a
  `cordoned-group-<id>` label so `uncordon` can restore it. When the original
  group cannot be determined, `cordoned-group-0` is recorded and `uncordon`
  returns the runner to the default group.
- `label`: renames the runner's custom labels with `--label-prefix` so
  `runs-on:` references using those custom labels no longer match. Built-in
  read-only labels (`self-hosted`, OS, architecture) are left untouched, so a
  workflow using only `runs-on: self-hosted` **can still match** the runner.
  Prefer the `group` strategy when full isolation is required.

Both strategies add a `cordoned` marker label, which is what `list` reports in
the `CORDONED` column and what `uncordon --all` selects on.

Runners that are already cordoned are skipped with a message on stderr.

### group create

Creates a runner group in an organization. The group is created without any
repository access, so grant it afterwards from the organization settings unless
`--visibility all` is used.

```bash
gh runner-kit group create <name> [--repo [HOST/]OWNER/REPO | --owner OWNER] \
  [--visibility selected|all|private] [--allows-public-repositories] [--dryrun] \
  [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

| Option | Default | Description |
| --- | --- | --- |
| `--allows-public-repositories` | `false` | Let public repositories use the runner group |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--format` | - | Output format: `json`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--visibility` | `selected` | Which repositories can use the runner group: `selected`, `all` or `private` |

Managing runner groups requires organization owner permission.

### group delete

Deletes an organization runner group. The runners of the group are not deleted;
they are returned to the default runner group.

```bash
gh runner-kit group delete <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] [--dryrun]
```

| Option | Default | Description |
| --- | --- | --- |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |

Managing runner groups requires organization owner permission.

### group list

Lists the runner groups configured in an organization. The organization is taken
from `--owner`, or from the owner of `--repo` or of the current repository.

```bash
gh runner-kit group list [--repo [HOST/]OWNER/REPO | --owner OWNER] \
  [--name-only] [--fields FIELD,...] \
  [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | `ID,NAME,VISIBILITY,DEFAULT,INHERITED` | Table columns to display |
| `--format` | - | Output format: `json`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the runner group names |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |
| `-t`, `--template` | - | Format JSON output using a Go template |

Available `--fields` values are `DEFAULT`, `ID`, `INHERITED`, `NAME`,
`PUBLIC_REPOSITORIES`, `RESTRICTED_TO_WORKFLOWS` and `VISIBILITY`; the given
order is the column order.

Reading runner groups requires organization owner permission.

### group repos

Lists the repositories that have access to an organization runner group. Only
runner groups whose visibility is `selected` have a repository access list.

```bash
gh runner-kit group repos <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] \
  [--name-only] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

| Option | Default | Description |
| --- | --- | --- |
| `--format` | - | Output format: `json`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the repository names |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |
| `-t`, `--template` | - | Format JSON output using a Go template |

### group runner add

Moves an organization self-hosted runner into a runner group. A runner belongs to
exactly one group, so it is removed from its current group.

```bash
gh runner-kit group runner add <group> <runner> \
  [--repo [HOST/]OWNER/REPO | --owner OWNER] [--dryrun]
```

| Option | Default | Description |
| --- | --- | --- |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |

Managing runner groups requires organization owner permission.

### group runner list

Lists the self-hosted runners belonging to an organization runner group. The
group is a required positional argument, given as a group name or a group ID.

```bash
gh runner-kit group runner list <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] \
  [--status online|offline|active|idle] [--name-only] [--fields FIELD,...] \
  [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | `ID,NAME,OS,STATUS,BUSY,CORDONED,LABELS` | Table columns to display |
| `--format` | - | Output format: `json`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the runner names |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |
| `--status` | all statuses | Keep only the runners in this status: `online`, `offline`, `active` or `idle` |
| `-t`, `--template` | - | Format JSON output using a Go template |

Reading runner groups requires organization owner permission.

### group runner remove

Removes an organization self-hosted runner from a runner group, returning it to
the default runner group.

```bash
gh runner-kit group runner remove <group> <runner> \
  [--repo [HOST/]OWNER/REPO | --owner OWNER] [--dryrun]
```

| Option | Default | Description |
| --- | --- | --- |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |

Managing runner groups requires organization owner permission.

### group update

Updates the settings of an organization runner group. Only the settings given on
the command line are changed, and at least one of `--name`, `--visibility` and
`--allows-public-repositories` is required.

```bash
gh runner-kit group update <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] \
  (--name NAME | --visibility selected|all|private | --allows-public-repositories) \
  [--dryrun] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

| Option | Default | Description |
| --- | --- | --- |
| `--allows-public-repositories` | unchanged | Let public repositories use the runner group |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--format` | - | Output format: `json`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name` | unchanged | Rename the runner group |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--visibility` | unchanged | Which repositories can use the runner group: `selected`, `all` or `private` |

Managing runner groups requires organization owner permission.

### group view

Shows the settings of an organization runner group as a field/value table.

```bash
gh runner-kit group view <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] \
  [--fields FIELD,...] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | all fields | Fields to display |
| `--format` | - | Output format: `json`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |
| `-t`, `--template` | - | Format JSON output using a Go template |

Available `--fields` values are the same as for `group list`.

### list

Lists self-hosted runners including their cordon status.
Organization-level runners are listed by default.

```bash
gh runner-kit list [--repo [HOST/]OWNER/REPO | --owner OWNER] \
  [--type org|repo] [--status online|offline|active|idle] \
  [--name-only] [--fields FIELD,...] \
  [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | `ID,NAME,OS,STATUS,BUSY,CORDONED,LABELS` | Table columns to display |
| `--format` | - | Output format: `json`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the runner names |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |
| `--status` | all statuses | Keep only the runners in this status: `online`, `offline`, `active` or `idle` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `org` or `repo` |

Table columns: `ID`, `NAME`, `OS`, `STATUS`, `BUSY`, `CORDONED`, `LABELS`.
Available `--fields` values are `BUSY`, `CORDONED`, `ID`, `LABELS`, `NAME`, `OS`
and `STATUS`; the given order is the column order.

`--jq` and `--template` require `--format json`.

`--type repo` requires a repository, so pass `--repo` or run inside one.

The runner list APIs do not report the runner group of each runner, so use
`group runner list` to list the runners of a runner group.

### metrics

Reports how the self-hosted runner fleet was used over a time window. All
subcommands share the same collection options and the same definitions.

Shared options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--concurrency` | `6` | Number of job requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | - | Output format: `json`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local job cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--refresh` | `false` | Ignore the cached jobs and fetch them again |
| `-R`, `--repo` | current repository | Select a repository |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `org` or `repo` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

Definitions to be aware of when reading the numbers:

- **Scope.** `--type` selects where the runner inventory is read from, but the
  workflow runs always come from a repository because the API has no
  organization-wide run listing. Use `--all-repos` to walk every repository of
  the organization, which issues many API requests.
- **Wait time.** Measured from job creation to job start, so it also covers the
  time spent waiting on `needs` dependencies and concurrency groups. It is an
  upper bound on the pure runner queue time.
- **Busy time.** The job's start-to-completion span, clipped to the aggregation
  window.
- **Utilization.** Busy time divided by the window length; `metrics summary`
  additionally multiplies the window by the number of registered runners. The
  API keeps no history of when a runner was online, so the denominator is
  wall-clock time and not runner uptime.
- **Failure rate.** Failed and timed out jobs divided by the jobs that produced
  a pass or fail outcome. Cancelled jobs are excluded from both sides; skipped
  jobs are excluded entirely.
- **Check runs.** Check runs published by apps share the check suite of a
  workflow run, so the jobs API returns them alongside the real jobs. They carry
  no `runs-on` labels and never occupied a runner, so they are excluded.
- **Hosted jobs.** Jobs identified as running on GitHub-hosted runners are
  excluded from every metric and only counted in `HOSTED JOBS`. A job is treated
  as hosted when its runner group is `GitHub Actions` or its labels are a
  standard `ubuntu-*` / `windows-*` / `macos-*` image and it did not run on a
  registered self-hosted runner.
- **Runner status.** `STATUS`, `CORDONED`, `ONLINE` and `BUSY` describe the
  fleet right now, not during the window.

Job lists of completed runs are cached under the user cache directory
(`~/Library/Caches/gh-runner-kit/metrics/` on macOS,
`~/.cache/gh-runner-kit/metrics/` on Linux) with `0700`/`0600` permissions, keyed
by host, owner, repository and run ID. Use `--refresh` to rewrite the entries and
`--no-cache` to bypass the cache entirely.

The table output always ends with a footer stating the window and the number of
runs, and warns when `--max-runs` truncated the data. Repositories the token
cannot read are reported as warnings on stderr and skipped instead of failing the
command.

### metrics concurrency

Reconstructs how many jobs occupied a runner at the same time, one fixed-width
time bucket at a time.

```bash
gh runner-kit metrics concurrency [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] \
  [--bucket DURATION] [--label LABEL]... [--days N | --since TIME] [--all-repos] [--format json]
```

| Option | Default | Description |
| --- | --- | --- |
| `--bucket` | `1h` | Width of one time bucket, such as `15m` or `1h` |
| `--label` | all labels | Keep only the jobs requesting this label. Repeatable |

Table columns: `START`, `END`, `JOBS`, `PEAK`, `RUNNERS`, `BUSY`, `UTIL`.

Rows are in chronological order. `PEAK` is the highest number of jobs running at
the same instant inside the bucket, so comparing it against `RUNNERS` shows when
the fleet ran out of capacity. The last bucket is cut off at the end of the
window, and `UTIL` divides by the actual bucket length so that it stays
comparable.

`--label` narrows both sides: only the jobs whose `runs-on` set carries every
given label are counted, and only the runners that can serve that set.

### metrics label

Matches the labels the jobs requested against the labels the registered runners
carry, one single label at a time. Use `metrics queue` instead when the whole
`runs-on` set matters.

```bash
gh runner-kit metrics label [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] \
  [--days N | --since TIME] [--all-repos] [--max-runs N] [--format json]
```

Table columns: `LABEL`, `STATUS`, `JOBS`, `RUNNERS`, `WAIT P50`, `WAIT P95`,
`LAST JOB`.

`STATUS` is `orphan` when jobs asked for the label but no registered runner
carries it, `unused` when a runner carries the label but nothing requested it,
and `ok` otherwise. Orphan and unused rows are listed first. `RUNNERS` reflects
the current inventory, because the API keeps no history of runner labels.

### metrics queue

Groups the jobs by the `runs-on` label set they requested and reports how long
each set waited for a runner.

```bash
gh runner-kit metrics queue [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] \
  [--days N | --since TIME] [--all-repos] [--max-runs N] [--format json]
```

Table columns: `LABELS`, `KIND`, `JOBS`, `WAIT P50`, `WAIT P95`, `WAIT MAX`,
`RUNNERS`, `PEAK`, `SATURATION`.

`RUNNERS` counts the registered runners carrying every label of the set, `PEAK`
is the highest number of jobs of that set running at the same time, and
`SATURATION` is `PEAK / RUNNERS`. Saturation above `1.00` with a high `WAIT P95`
means the label set needs more runners; a low saturation with a high wait points
at the workflow definitions instead.

### metrics runner

Breaks the fleet activity down per runner, per label set or per runner group.

```bash
gh runner-kit metrics runner [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] \
  [--group-by name|label|group] [--days N | --since TIME] [--all-repos] [--format json]
```

| Option | Default | Description |
| --- | --- | --- |
| `--group-by` | `name` | Aggregate the jobs by this key: `name`, `label` or `group` |

Table columns: `KEY`, `STATUS`, `CORDONED`, `JOBS`, `BUSY`, `UTIL`, `FAIL`,
`WAIT P50`, `DUR P50`, `DUR P95`, `LAST JOB`.

Grouping by name gives every registered runner a row, including the ones that
picked up no work, which is how idle and cordoned capacity becomes visible.
Ephemeral runners get a fresh name on every job, so group them by `label` or
`group` instead.

### metrics summary

Summarizes how the fleet behaved over the window.

```bash
gh runner-kit metrics summary [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] \
  [--days N | --since TIME] [--all-repos] [--max-runs N] [--format json]
```

Reported metrics: `RUNNERS`, `ONLINE`, `BUSY`, `CORDONED`, `RUNS`, `JOBS`,
`HOSTED JOBS`, `WAIT P50`, `WAIT P95`, `DURATION P50`, `DURATION P95`,
`BUSY TIME`, `UTILIZATION`, `FAILURE RATE`, `PEAK CONCURRENCY`.

### metrics workflow

Breaks the collected jobs down per workflow.

```bash
gh runner-kit metrics workflow [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] \
  [--self-hosted-only] [--days N | --since TIME] [--all-repos] [--format json]
```

| Option | Default | Description |
| --- | --- | --- |
| `--self-hosted-only` | `false` | Exclude the jobs that ran on GitHub-hosted runners |

Table columns: `WORKFLOW`, `RUNS`, `JOBS`, `FAIL`, `RETRY`, `WAIT P50`,
`DUR P50`, `DUR P95`, `BUSY`, `LAST JOB`.

This is the only metrics report that includes GitHub-hosted jobs by default, so
that a workflow can be judged as a whole; pass `--self-hosted-only` to narrow it
down to the fleet. `RETRY` is the share of runs restarted at least once, which is
the only retry signal available: the job list of a run covers its last attempt
only, so a job retried inside one attempt is indistinguishable from a job that
ran once.

### run

Downloads the `actions/runner` agent (if not already present in `--dir`),
registers it with the target repository or organization, and runs it in the
foreground. Press `Ctrl+C` to stop the runner gracefully.

```bash
gh runner-kit run [--repo [HOST/]OWNER/REPO | --owner OWNER] \
  [--name NAME] [--labels LABELS] [--no-default-labels] \
  [--runner-group GROUP] [--dir DIR] [--work DIR] \
  [--version VERSION] [--replace] [--ephemeral] [--remove-on-exit]
```

| Option | Default | Description |
| --- | --- | --- |
| `--dir` | `.actions-runner` | Directory to install and run the runner agent in |
| `--ephemeral` | `false` | Register the runner as ephemeral (deregisters itself after one job) |
| `--labels` | runner name with `--no-default-labels` | Comma-separated list of custom labels to add to the runner |
| `--name` | hostname | Runner name |
| `--no-default-labels` | `false` | Register the runner without the default labels (`self-hosted`, OS and architecture) |
| `--owner` | current repository owner | Select an organization by owner name |
| `--remove-on-exit` | `false` | Delete the runner registration from GitHub after the agent stops |
| `--replace` | `false` | Replace any existing runner registration with the same name |
| `-R`, `--repo` | current repository | Select a repository |
| `--runner-group` | `Default` | Runner group to register the runner into (organization-level runners only) |
| `--version` | `latest` | `actions/runner` version to download |
| `--work` | `_work` | Working directory used by the runner agent |

Notes:

- A registration token is created automatically; no manual token handling is
  needed.
- With `--no-default-labels` the runner only carries the labels given by
  `--labels`, so make sure the workflow `runs-on` matches them. When `--labels`
  is omitted, the runner name is used as the label.
- `--runner-group` requires an organization target, so pass `--owner` and not
  `--repo`. The group must already exist; create it with `group create`.
- When `--dir` already contains a configured runner, configuration is skipped
  unless `--replace` is given, so `--runner-group` only takes effect while the
  runner is being registered.
- `--remove-on-exit` deletes the registration after the agent stops, including
  after `Ctrl+C`. The downloaded agent stays in `--dir`, so the next `run` only
  needs to register again. It is a no-op when the agent already deregistered
  itself, which is what an `--ephemeral` runner does after its job.
- The agent binary is selected from the current OS/architecture
  (`linux-x64`, `osx-arm64`, `win-x64`, etc.).

### uncordon

Reverses a previous cordon, restoring each runner's original runner group and/or
custom labels from the marker labels recorded by `cordon`.

```bash
gh runner-kit uncordon [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] \
  (--id ID | --name NAME | --label LABEL | --all) \
  [--label-prefix PREFIX] [--dryrun]
```

| Option | Default | Description |
| --- | --- | --- |
| `--all` | `false` | Select every currently cordoned runner |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--id` | - | Select the runner to uncordon by ID |
| `--label` | - | Select every runner that has this label |
| `--label-prefix` | `cordoned-` | Prefix that was applied to custom labels by the `label` strategy |
| `--name` | - | Select the runner to uncordon by name |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `org` or `repo` |

Use the same `--type` (and `--label-prefix`) as the matching `cordon` call,
otherwise the cordoned runners are not found or the prefixed labels cannot be
restored to their original names.

Runners that are not cordoned are skipped with a message on stderr.

## Global Options

| Option | Default | Description |
| --- | --- | --- |
| `--http-timeout` | `30s` | Timeout for each GitHub API request |
| `-L`, `--log-level` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `--read-only` | `false` | Run in read-only mode (prevents write operations) |

## Common Workflows

### Check which runners a repository can use

```bash
gh runner-kit available -R my-org/my-repo

# Only the runners that are currently online
gh runner-kit available -R my-org/my-repo --status online
```

### Inspect the runner groups of an organization

```bash
# List the runner groups
gh runner-kit group list --owner my-org

# List the runners of one of them
gh runner-kit group runner list gpu-runners --owner my-org --status online

# The group can also be selected by ID
gh runner-kit group runner list 3 --owner my-org
```

### Move runners into a dedicated runner group

```bash
# Create the group
gh runner-kit group create gpu-runners --owner my-org --visibility selected

# Move runners into it (check first with --dryrun)
gh runner-kit group runner add gpu-runners gpu-01 --owner my-org --dryrun
gh runner-kit group runner add gpu-runners gpu-01 --owner my-org

# Review the result
gh runner-kit group view gpu-runners --owner my-org
gh runner-kit group repos gpu-runners --owner my-org

# Move a runner back to the default group
gh runner-kit group runner remove gpu-runners gpu-01 --owner my-org
```

### Drain a runner before maintenance

```bash
# Check what would happen first
gh runner-kit cordon --owner my-org --name build-01 --dryrun

# Cordon it
gh runner-kit cordon --owner my-org --name build-01

# Confirm the cordon status
gh runner-kit list --owner my-org

# Bring it back after maintenance
gh runner-kit uncordon --owner my-org --name build-01
```

### Cordon a whole class of runners by label

```bash
gh runner-kit cordon --owner my-org --label gpu --dryrun
gh runner-kit cordon --owner my-org --label gpu
```

### Restore everything

```bash
gh runner-kit uncordon --owner my-org --all
```

### Cordon repository-level runners

The `group` strategy is organization-only, so repository-level runners must use
the `label` strategy:

```bash
gh runner-kit cordon -R owner/repo --name build-01 --strategy label
gh runner-kit uncordon -R owner/repo --name build-01
```

### Start an ephemeral runner for a repository

```bash
gh runner-kit run -R owner/repo --labels self-test --ephemeral
```

### Run a temporary runner and clean up its registration

```bash
# Ctrl+C stops the agent, then the registration is deleted from GitHub
gh runner-kit run -R owner/repo --labels self-test --remove-on-exit
```

### Decide whether the fleet needs more runners

```bash
# Overall picture for the last week
gh runner-kit metrics summary --owner my-org --days 7

# Which runs-on label sets are waiting, and are they short of runners?
gh runner-kit metrics queue --owner my-org --days 7

# Which runners are actually doing the work, and which are idle?
gh runner-kit metrics runner --owner my-org --days 7
```

### Find runners that are registered but never used

```bash
gh runner-kit metrics runner --owner my-org --days 30 --format json \
  -q '.[] | select(.Jobs == 0) | .Key'
```

### Find labels that no runner can serve

```bash
# Jobs asking for a label nothing carries can never start
gh runner-kit metrics label --owner my-org --days 30 --format json \
  -q '.[] | select(.Status == "orphan") | .Label'
```

### Find out when the fleet runs out of capacity

```bash
# Hour by hour peak against the fleet size
gh runner-kit metrics concurrency --owner my-org --days 7 --bucket 1h

# Only the buckets where every runner of the pool was taken
gh runner-kit metrics concurrency --owner my-org --days 7 --label linux --format json \
  -q '.[] | select(.Peak >= .Runners and .Runners > 0) | .Start'
```

### Find the workflows that cost the fleet the most

```bash
# Busiest workflows on self-hosted runners
gh runner-kit metrics workflow --owner my-org --days 7 --self-hosted-only

# Workflows that are restarted often
gh runner-kit metrics workflow --owner my-org --days 30 --format json \
  -q '.[] | select(.RetryRate > 0.2) | {Workflow, RetryRate}'
```

## Troubleshooting

| Symptom | Cause / Resolution |
| --- | --- |
| `--strategy group is only supported for organization-level runners` | The repository runner type was targeted with the default `group` strategy. Use `--type org`, or pass `--strategy label`. |
| `--runner-group is only supported for organization-level runners` | `run` was given `--runner-group` with a repository target. Pass `--owner` instead of `--repo`. |
| `--type repo requires a repository` | `--type repo` was used outside a repository. Pass `--repo owner/name`. |
| `no runners matched` | No runner carried the given `--label` (or nothing is cordoned for `--all`). Verify with `list`, and check that `--type` matches the `cordon` call. |
| `runner ... is already cordoned` / `is not cordoned` | The runner is skipped; no action is required. |
| `runner "..." not found` | `--name` did not match any runner. Names are matched exactly; check `list`. |
| `runner group "..." not found in ...` | The group name or ID did not match any organization runner group. Check `group list`; names are matched exactly. |
| `runner "..." not found in ...` | The runner name or ID did not match any organization runner. Check `list --type org`. |
| `at least one of the flags in the group [name visibility allows-public-repositories] is required` | `group update` was called without any setting to change. |
| The runner group of a runner is not listed by `list` | The runner list APIs do not return `runner_group_id`. Use `group runner list` to list the runners of a group. |
| Jobs still run after `--strategy label` | Workflows using only `runs-on: self-hosted` still match, because built-in labels are not renamed. Use `--strategy group` for full isolation. |
| `PUT .../runner-groups/0/runners/...: 404 Not Found` | The runner was cordoned by an older version that recorded `cordoned-group-0`. Current versions return such runners to the default group; re-run `uncordon`. |
| `collecting workflow runs requires a repository` | A `metrics` command was run outside a repository without `--repo`. Pass `--repo owner/name`, or `--all-repos` to walk the whole organization. |
| `metrics` reports `JOBS 0` but `HOSTED JOBS` is high | Every job ran on GitHub-hosted runners. The metrics only cover self-hosted activity. |
| `metrics` utilization looks far too low | The denominator is the whole window multiplied by the registered runners, including offline ones. Use `metrics runner` to see the per-runner breakdown. |
| `metrics` warns that `--max-runs` was reached | The window holds more runs than the limit. Raise `--max-runs`, or narrow the scope with `--branch`, `--event` or `--workflow`. |
| `metrics` is slow the first time | Each run costs one job request. Results are cached per run, so subsequent invocations over the same window are much faster. |
| `metrics` percentiles look implausibly low | Older caches may still hold the check runs that are now excluded. Re-run with `--refresh`. |
| `metrics concurrency` shows `RUNNERS 0` | `--label` matched no registered runner, or the runner inventory could not be read. Check `metrics label` for orphan labels and the warnings on stderr. |
| `metrics concurrency` returns one row per minute | `--bucket` was set too small for the window. Widen it, for example `--bucket 1h`. |
| `metrics label` lists a label as `unused` that is clearly in use | The jobs requesting it fall outside the window or were dropped by `--max-runs`. Widen `--days` or raise `--max-runs`. |
| `metrics workflow` shows `RETRY 0.0%` although jobs were re-run | Only whole-run restarts are visible. Re-running a single job stays inside the same attempt and cannot be detected. |
| `metrics workflow` counts more jobs than the other reports | It includes GitHub-hosted jobs by default. Pass `--self-hosted-only`. |
| Labels are not restored by `uncordon` | `--label-prefix` differs from the value used for `cordon`. |

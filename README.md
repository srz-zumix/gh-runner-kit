# gh-runner-kit

`gh-runner-kit` is a GitHub CLI extension for managing GitHub Actions self-hosted runners.

It provides commands to list runners, cordon/uncordon them to control job scheduling without deleting the registration, and to download, register, and run the runner agent itself.

## Installation

```sh
gh extension install srz-zumix/gh-runner-kit
```

## Shell Completion

Shell completion scripts for bash, zsh, fish, and PowerShell can be generated with the `completion` command.

```sh
gh runner-kit completion <shell>
```

Run `gh runner-kit completion --help` for details on how to load the script for your shell.

## Usage

### List self-hosted runners available to a repository

```sh
gh runner-kit available [--repo [HOST/]OWNER/REPO] [--status online|offline|active|idle] [--name-only] [--fields FIELD,...] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

List every self-hosted runner a repository can schedule jobs on: the runners registered to the repository itself plus the organization runners belonging to each runner group that is visible to the repository.

Use `--status` to keep only the runners in one status, and `--fields` to choose the table columns. The runner APIs only report `online` and `offline`, so `--status active` and `--status idle` match the online runners that are respectively running a job and waiting for one.

Listing the organization runner groups requires organization owner permission. Runner groups are an organization feature, so only the repository-level runners are listed for a user-owned repository.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | `ID,NAME,OS,STATUS,BUSY,CORDONED,LABELS` | Table columns to display: `{BUSY\|CORDONED\|ID\|LABELS\|NAME\|OS\|STATUS}` |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the runner names |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--status` | all statuses | Keep only the runners in this status: `{online\|offline\|active\|idle}` |
| `-t`, `--template` | - | Format JSON output using a Go template |

### Add a self-hosted runner to an organization runner group

```sh
gh runner-kit group runner add <group> <runner> [--repo [HOST/]OWNER/REPO | --owner OWNER] [--dryrun]
```

Move an organization self-hosted runner into a runner group. The `<group>` and `<runner>` arguments are required and select the runner group and the runner by name or by ID. A runner belongs to exactly one group, so it is removed from its current group.

Managing runner groups requires organization owner permission.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |

### Cordon self-hosted runners so they stop receiving new jobs

```sh
gh runner-kit cordon [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] (--id ID | --name NAME | --label LABEL) [--strategy group|label] [--group NAME] [--group-visibility selected|all|private] [--label-prefix PREFIX] [--dryrun]
```

Cordon marks self-hosted runners so that no new jobs will be scheduled on them, without deleting the runner registration.

Runners are selected with `--id`, `--name` or `--label`. Exactly one of them is required, and `--label` cordons every runner that carries the given label.

Organization-level runners are targeted by default. Use `--type repo` to target the runners registered to a repository instead; passing `--repo` explicitly implies `--type repo`.

Two strategies are available:

- `group` (default, organization-level only): moves the runner into an isolated runner group with restricted visibility so no `runs-on:` in any repository can match it.
- `label`: renames the runner's custom labels with a `cordoned-` prefix so `runs-on:` references using those custom labels no longer match. This does not remove the built-in `self-hosted`/OS/architecture labels, so a workflow using only `runs-on: self-hosted` can still match the runner.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--group` | `gh-runner-kit-cordoned` | Name of the isolated runner group used by the `group` strategy |
| `--group-visibility` | `selected` | Visibility of the isolated runner group when it is created: `{selected\|all\|private}` |
| `--id` | - | Select the runner to cordon by ID |
| `--label` | - | Select every runner that has this label |
| `--label-prefix` | `cordoned-` | Prefix applied to custom labels by the `label` strategy |
| `--name` | - | Select the runner to cordon by name |
| `--owner` | current repository owner | Select an organization by owner name (for organization-level runners) |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--strategy` | `group` | Cordon strategy: `{group\|label}` |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |

### Create an organization runner group

```sh
gh runner-kit group create <name> [--repo [HOST/]OWNER/REPO | --owner OWNER] [--visibility selected|all|private] [--allows-public-repositories] [--dryrun] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Create a runner group in an organization. The `<name>` argument is required.

The group is created without any repository access, so grant it afterwards from the organization settings unless `--visibility all` is used.

Managing runner groups requires organization owner permission.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--allows-public-repositories` | `false` | Let public repositories use the runner group |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--visibility` | `selected` | Which repositories can use the runner group: `{selected\|all\|private}` |

### Delete an organization runner group

```sh
gh runner-kit group delete <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] [--dryrun]
```

Delete an organization runner group. The `<group>` argument is required and selects the runner group by name or by ID.

The runners of the group are not deleted; they are returned to the default runner group.

Managing runner groups requires organization owner permission.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |

### Download, register and run a self-hosted runner agent

```sh
gh runner-kit run [--repo [HOST/]OWNER/REPO | --owner OWNER] [--name NAME] [--labels LABELS] [--no-default-labels] [--runner-group GROUP] [--dir DIR] [--work DIR] [--version VERSION] [--replace] [--ephemeral] [--remove-on-exit]
```

Run downloads the `actions/runner` agent (if not already present in `--dir`), registers it with the target repository or organization, and runs it in the foreground. Press `Ctrl+C` to stop the runner.

Use `--no-default-labels` to register the runner with only the labels given by `--labels`. The runner name is used as the label when `--labels` is omitted.

Use `--runner-group` to register an organization runner into an existing runner group instead of the default one.

Use `--remove-on-exit` to delete the runner registration from GitHub once the agent has stopped, leaving the downloaded agent in `--dir`.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--dir` | `.actions-runner` | Directory to install and run the runner agent in |
| `--ephemeral` | `false` | Register the runner as ephemeral (it deregisters itself after one job) |
| `--labels` | runner name with `--no-default-labels` | Comma-separated list of custom labels to add to the runner |
| `--name` | hostname | Runner name |
| `--no-default-labels` | `false` | Register the runner without the default labels (`self-hosted`, OS and architecture) |
| `--owner` | current repository owner | Select an organization by owner name (for organization-level runners) |
| `--remove-on-exit` | `false` | Delete the runner registration from GitHub after the agent stops |
| `--replace` | `false` | Replace any existing runner registration with the same name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--runner-group` | `Default` | Runner group to register the runner into (organization-level runners only) |
| `--version` | `latest` | `actions/runner` version to download |
| `--work` | `_work` | Working directory used by the runner agent |

### List organization runner groups

```sh
gh runner-kit group list [--repo [HOST/]OWNER/REPO | --owner OWNER] [--name-only] [--fields FIELD,...] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

List the runner groups configured in an organization.

The organization is taken from `--owner`, or from the owner of `--repo` or of the current repository. Reading runner groups requires organization owner permission.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | `ID,NAME,VISIBILITY,DEFAULT,INHERITED` | Table columns to display: `{DEFAULT\|ID\|INHERITED\|NAME\|PUBLIC_REPOSITORIES\|RESTRICTED_TO_WORKFLOWS\|VISIBILITY}` |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the runner group names |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `-t`, `--template` | - | Format JSON output using a Go template |

### List self-hosted runners

```sh
gh runner-kit list [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--status online|offline|active|idle] [--name-only] [--fields FIELD,...] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

List self-hosted runners, including their cordon status.

Organization-level runners are listed by default. Use `--type repo` to list the runners registered to a repository instead; passing `--repo` explicitly implies `--type repo`. Use `--status` to keep only the runners in one status, and `--fields` to choose the table columns. The runner APIs only report `online` and `offline`, so `--status active` and `--status idle` match the online runners that are respectively running a job and waiting for one.

The runner list APIs do not report the runner group of each runner, so use `gh runner-kit group runner list` to list the runners of a runner group.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | `ID,NAME,OS,STATUS,BUSY,CORDONED,LABELS` | Table columns to display: `{BUSY\|CORDONED\|ID\|LABELS\|NAME\|OS\|STATUS}` |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the runner names |
| `--owner` | current repository owner | Select an organization by owner name (for organization-level runners) |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--status` | all statuses | Keep only the runners in this status: `{online\|offline\|active\|idle}` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |

### List the repositories that can use an organization runner group

```sh
gh runner-kit group repos <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] [--name-only] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

List the repositories that have access to an organization runner group. The `<group>` argument is required and selects the runner group by name or by ID.

Only runner groups whose visibility is `selected` have a repository access list.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the repository names |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `-t`, `--template` | - | Format JSON output using a Go template |

### List the self-hosted runners of an organization runner group

```sh
gh runner-kit group runner list <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] [--status online|offline|active|idle] [--name-only] [--fields FIELD,...] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

List the self-hosted runners belonging to an organization runner group. The `<group>` argument is required and selects the runner group by name or by ID.

The organization is taken from `--owner`, or from the owner of `--repo` or of the current repository. Reading runner groups requires organization owner permission.

Use `--status` to keep only the runners in one status, and `--fields` to choose the table columns. The runner APIs only report `online` and `offline`, so `--status active` and `--status idle` match the online runners that are respectively running a job and waiting for one.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | `ID,NAME,OS,STATUS,BUSY,CORDONED,LABELS` | Table columns to display: `{BUSY\|CORDONED\|ID\|LABELS\|NAME\|OS\|STATUS}` |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name-only` | `false` | Print only the runner names |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--status` | all statuses | Keep only the runners in this status: `{online\|offline\|active\|idle}` |
| `-t`, `--template` | - | Format JSON output using a Go template |

### Remove a self-hosted runner from an organization runner group

```sh
gh runner-kit group runner remove <group> <runner> [--repo [HOST/]OWNER/REPO | --owner OWNER] [--dryrun]
```

Remove an organization self-hosted runner from a runner group. The `<group>` and `<runner>` arguments are required and select the runner group and the runner by name or by ID. The runner is returned to the default runner group.

Managing runner groups requires organization owner permission.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |

### Recommend how many runners each runs-on label set needs

```sh
gh runner-kit metrics capacity [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--target-wait DURATION] [--target-utilization RATIO] [--days N | --since TIME] [--all-repos] [--branch BRANCH] [--event EVENT] [--workflow FILE] [--max-runs N] [--concurrency N] [--no-cache] [--refresh] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Size every `runs-on` label set against a target queue time.

`LOAD` is the offered load in Erlangs: the number of runners the label set kept busy on average across the window. `RECOMMENDED` is the smallest pool that keeps both the modelled mean queue time at or below `--target-wait` and the utilization at or below `--target-utilization`, and `DELTA` is how many runners to add, or to remove when negative.

The model is an M/M/c queue, which assumes jobs arrive independently of each other and that any runner of the pool can serve any of its jobs. Workloads driven by a scheduled burst or by fan-out inside a single workflow break the first assumption, so compare `EST WAIT` against the measured `WAIT P95` before acting on `DELTA`.

Jobs that ran on GitHub-hosted runners are excluded.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--concurrency` | `6` | Number of job requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local job cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--refresh` | `false` | Ignore the cached jobs and fetch them again |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `--target-utilization` | `0.7` | Highest share of the time a runner may be busy, greater than 0 and at most 1 |
| `--target-wait` | `1m0s` | Mean queue time the recommended pool aims for, such as `60s` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

### Show how many jobs ran at the same time over the window

```sh
gh runner-kit metrics concurrency [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--bucket DURATION] [--label LABEL]... [--days N | --since TIME] [--all-repos] [--branch BRANCH] [--event EVENT] [--workflow FILE] [--max-runs N] [--concurrency N] [--no-cache] [--refresh] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Reconstruct the number of jobs that occupied a runner at the same time from their start and completion timestamps, one time bucket at a time.

`PEAK` is the highest number of jobs running at the same instant inside the bucket, and comparing it against `RUNNERS` shows whether the fleet ran out of capacity and when. `UTIL` is the busy time of the bucket divided by the bucket length multiplied by `RUNNERS`, so it stays comparable across buckets even though the last one is cut off at the end of the window.

`--label` keeps only the jobs whose `runs-on` set carries every given label, and counts only the runners that can serve that set. Jobs that ran on GitHub-hosted runners are excluded.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--bucket` | `1h` | Width of one time bucket, such as `15m` or `1h` |
| `--concurrency` | `6` | Number of job requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--label` | all labels | Keep only the jobs requesting this label. Repeatable |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local job cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--refresh` | `false` | Ignore the cached jobs and fetch them again |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

### Report the billable time GitHub-hosted runners consumed

```sh
gh runner-kit metrics cost [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--rate OS=PRICE]... [--days N | --since TIME] [--all-repos] [--branch BRANCH] [--event EVENT] [--workflow FILE] [--max-runs N] [--concurrency N] [--no-cache] [--refresh] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Report the billable time of the collected workflow runs, broken down by operating system.

GitHub only bills the jobs it hosted, so self-hosted jobs contribute nothing to this report. What it shows is therefore both the current hosted spend and what moving the same work to self-hosted runners would avoid. Public repositories run on hosted runners for free, so their billable time is reported as zero.

`EST COST` multiplies the billable minutes by the per-minute price of the operating system. The defaults are the public prices of the standard two core runners (`UBUNTU` `0.008`, `WINDOWS` `0.016`, `MACOS` `0.08` USD), so pass `--rate` to match a plan or a larger runner, for example `--rate ubuntu=0.016`.

This command reads the usage of every run, which costs one API request per run, so keep `--max-runs` in mind. The per run job listing is skipped because the report does not need it, and completed runs are cached like they are for the other reports.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--concurrency` | `6` | Number of usage requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--rate` | see above | Override the per-minute price of an operating system, as `OS=PRICE`. Repeatable |
| `--refresh` | `false` | Ignore the cached usage and fetch it again |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

### Publish the fleet metrics for monitoring

```sh
gh runner-kit metrics export [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--summary] [--days N | --since TIME] [--all-repos] [--branch BRANCH] [--event EVENT] [--workflow FILE] [--max-runs N] [--concurrency N] [--no-cache] [--refresh] [--format prometheus|json] [--jq EXPRESSION] [--template TEMPLATE]
```

Publish the fleet overview, the queue time of every `runs-on` label set and the demand for every label in a form a monitoring system can ingest, which is what a scheduled workflow needs.

The default `--format prometheus` writes a Prometheus text exposition to standard output, ready to be served by a static file or pushed to a Pushgateway. Durations are expressed in seconds and ratios in the `0..1` range. `--format json` emits the same report as a single JSON document instead.

`--summary` additionally appends a Markdown version of the report to the file named by `$GITHUB_STEP_SUMMARY`, so the numbers show up on the workflow run page. It fails outside GitHub Actions, where that variable is not set.

Jobs that ran on GitHub-hosted runners are excluded from the job metrics.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--concurrency` | `6` | Number of job requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | `prometheus` | Output format: `{json\|prometheus}` |
| `-q`, `--jq` | - | Filter JSON output using a jq expression. Requires `--format json` |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local job cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--refresh` | `false` | Ignore the cached jobs and fetch them again |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `--summary` | `false` | Also append a Markdown report to `$GITHUB_STEP_SUMMARY` |
| `-t`, `--template` | - | Format JSON output using a Go template. Requires `--format json` |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

### Compare the demand for each label against the runners that carry it

```sh
gh runner-kit metrics label [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--include-unused] [--days N | --since TIME] [--all-repos] [--branch BRANCH] [--event EVENT] [--workflow FILE] [--max-runs N] [--concurrency N] [--no-cache] [--refresh] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Match the labels the jobs requested against the labels the registered runners carry, one label at a time.

`STATUS` is `orphan` when jobs asked for the label but no runner carries it, so those jobs cannot start until a runner picks the label up. Orphan rows are listed first.

Labels no job requested in the window are left out, because a large fleet carries many of them. Pass `--include-unused` to list them as `unused`, which usually points at a typo or at a label that outlived its workflow.

`RUNNERS` is the current inventory, because the API keeps no history of the labels a runner used to carry. Jobs that ran on GitHub-hosted runners are excluded.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--concurrency` | `6` | Number of job requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `--include-unused` | `false` | List the labels no job requested in the window |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local job cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--refresh` | `false` | Ignore the cached jobs and fetch them again |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

### Show how long each runs-on label set waited

```sh
gh runner-kit metrics queue [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--days N | --since TIME] [--all-repos] [--branch BRANCH] [--event EVENT] [--workflow FILE] [--max-runs N] [--concurrency N] [--no-cache] [--refresh] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Group the jobs by the `runs-on` label set they requested and report how long each set waited for a runner.

`RUNNERS` counts the registered runners that carry every label of the set, `PEAK` is the highest number of jobs of that set which ran at the same time, and `SATURATION` is `PEAK` divided by `RUNNERS`. A saturation above `1.00` combined with a high `WAIT P95` means the label set asked for more runners at once than it has, so adding capacity would cut the wait time. A low saturation with a high wait instead points at the jobs themselves, for example at `needs` dependencies or concurrency groups, because the wait time is measured from job creation and not from the moment the job became runnable.

Jobs that ran on GitHub-hosted runners are excluded.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--concurrency` | `6` | Number of job requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local job cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--refresh` | `false` | Ignore the cached jobs and fetch them again |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

### Show per runner activity

```sh
gh runner-kit metrics runner [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--group-by name|label|group] [--days N | --since TIME] [--all-repos] [--branch BRANCH] [--event EVENT] [--workflow FILE] [--max-runs N] [--concurrency N] [--no-cache] [--refresh] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Break the fleet activity down per runner, per `runs-on` label set or per runner group.

Grouping by name gives every registered runner a row, including the ones that picked up no work at all, which is how idle and cordoned capacity becomes visible. Ephemeral runners get a fresh name on every job, so group them by label or by group instead.

Utilization divides the busy time of the row by the length of the aggregation window, and `STATUS` and `CORDONED` describe the runner right now rather than during the window. Jobs that ran on GitHub-hosted runners are excluded.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--concurrency` | `6` | Number of job requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `--group-by` | `name` | Aggregate the jobs by this key: `{name\|label\|group}` |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local job cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--refresh` | `false` | Ignore the cached jobs and fetch them again |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

### Show a self-hosted runner fleet overview

```sh
gh runner-kit metrics summary [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--days N | --since TIME] [--all-repos] [--branch BRANCH] [--event EVENT] [--workflow FILE] [--max-runs N] [--concurrency N] [--no-cache] [--refresh] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Summarize how the self-hosted runner fleet behaved over a time window.

The runner counts describe the fleet right now, because the API keeps no history of when each runner was online. Every job metric covers the window selected by `--days` or `--since` and excludes the jobs that ran on GitHub-hosted runners.

Wait time is measured from the moment a job was created until it started, so it also includes the time the job spent waiting on `needs` dependencies and concurrency groups. Utilization divides the total busy time by the window length multiplied by the number of registered runners, and the failure rate counts failed and timed out jobs against the jobs that produced a pass or fail outcome.

Check runs published by apps share the check suite of a workflow run, so the jobs API returns them alongside the real jobs. They carry no `runs-on` labels and never occupied a runner, so they are excluded.

The footer always states the window and the number of runs the report is based on.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--concurrency` | `6` | Number of job requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local job cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--refresh` | `false` | Ignore the cached jobs and fetch them again |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

### Show the failure rate and the duration of each workflow

```sh
gh runner-kit metrics workflow [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] [--self-hosted-only] [--days N | --since TIME] [--all-repos] [--branch BRANCH] [--event EVENT] [--workflow FILE] [--max-runs N] [--concurrency N] [--no-cache] [--refresh] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Break the collected jobs down per workflow.

Workflows are grouped by their repository and workflow file, so two workflows that share a display name, whether they live in different repositories (common under `--all-repos`) or are different files in the same repository, are reported on separate rows. The `REPOSITORY` and `PATH` columns identify each row (a dash is shown when that metadata is unavailable).

`RETRY` is the share of runs that were restarted at least once, which is the only retry signal the API exposes: the job list of a run only ever covers its last attempt, so a job that was retried inside a single attempt cannot be told apart from a job that ran once. `FAIL` counts the jobs that failed or timed out against the jobs that reached a verdict, so cancelled jobs do not make a workflow look broken.

Unlike the other metrics reports this one includes the jobs that ran on GitHub-hosted runners, so that a workflow can be judged as a whole. Pass `--self-hosted-only` to narrow it down to the fleet, and `--workflow` to collect a single workflow file to begin with.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all-repos` | `false` | Collect the workflow runs of every repository in the organization |
| `--branch` | all branches | Keep only the workflow runs of this branch |
| `--concurrency` | `6` | Number of job requests to issue in parallel |
| `--days` | `7` | Aggregate over the last N days. Mutually exclusive with `--since` |
| `--event` | all events | Keep only the workflow runs triggered by this event |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--max-runs` | `300` | Stop after retrieving this many workflow runs per scope. `0` retrieves every run |
| `--no-cache` | `false` | Do not read or write the local job cache |
| `--owner` | current repository owner | Select an organization by owner name |
| `--refresh` | `false` | Ignore the cached jobs and fetch them again |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--self-hosted-only` | `false` | Exclude the jobs that ran on GitHub-hosted runners |
| `--since` | - | Aggregate since this time, as `YYYY-MM-DD` or RFC3339. Mutually exclusive with `--days` |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |
| `--workflow` | all workflows | Keep only the runs of this workflow file, such as `ci.yml` |

### Show the settings of an organization runner group

```sh
gh runner-kit group view <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] [--fields FIELD,...] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Show the settings of an organization runner group. The `<group>` argument is required and selects the runner group by name or by ID.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--fields` | all fields | Fields to display: `{DEFAULT\|ID\|INHERITED\|NAME\|PUBLIC_REPOSITORIES\|RESTRICTED_TO_WORKFLOWS\|VISIBILITY}` |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `-t`, `--template` | - | Format JSON output using a Go template |

### Uncordon self-hosted runners so they can receive new jobs again

```sh
gh runner-kit uncordon [--repo [HOST/]OWNER/REPO | --owner OWNER] [--type org|repo] (--id ID | --name NAME | --label LABEL | --all) [--label-prefix PREFIX] [--dryrun]
```

Uncordon reverses a previous cordon operation, restoring each runner's original runner group and/or custom labels based on the marker labels recorded by `cordon`. Runners whose original runner group could not be recorded are returned to the default runner group.

Runners are selected with `--id`, `--name`, `--label` or `--all`. Exactly one of them is required, and `--all` uncordons every currently cordoned runner.

Organization-level runners are targeted by default. Use `--type repo` to target the runners registered to a repository instead; passing `--repo` explicitly implies `--type repo`.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--all` | `false` | Select every currently cordoned runner |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--id` | - | Select the runner to uncordon by ID |
| `--label` | - | Select every runner that has this label |
| `--label-prefix` | `cordoned-` | Prefix that was applied to custom labels by the `label` strategy |
| `--name` | - | Select the runner to uncordon by name |
| `--owner` | current repository owner | Select an organization by owner name (for organization-level runners) |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `--type` | `org` (`repo` when `--repo` is given) | Runner type to target: `{org\|repo}` |

### Update the settings of an organization runner group

```sh
gh runner-kit group update <group> [--repo [HOST/]OWNER/REPO | --owner OWNER] (--name NAME | --visibility selected|all|private | --allows-public-repositories) [--dryrun] [--format json] [--jq EXPRESSION] [--template TEMPLATE]
```

Update the settings of an organization runner group. The `<group>` argument is required and selects the runner group by name or by ID.

Only the settings given on the command line are changed, and at least one of `--name`, `--visibility` and `--allows-public-repositories` is required.

Managing runner groups requires organization owner permission.

Options:

| Option | Default | Description |
| --- | --- | --- |
| `--allows-public-repositories` | unchanged | Let public repositories use the runner group |
| `-n`, `--dryrun` | `false` | Show what would be done without making any changes |
| `--format` | - | Output format: `{json}`. Table output is used when not specified |
| `-q`, `--jq` | - | Filter JSON output using a jq expression |
| `--name` | unchanged | Rename the runner group |
| `--owner` | current repository owner | Select an organization by owner name |
| `-R`, `--repo` | current repository | Select a repository using the `[HOST/]OWNER/REPO` format |
| `-t`, `--template` | - | Format JSON output using a Go template |
| `--visibility` | unchanged | Which repositories can use the runner group: `{selected\|all\|private}` |

## Global Options

| Option | Default | Description |
| --- | --- | --- |
| `--http-timeout` | `30s` | Timeout for each GitHub API request |
| `-L`, `--log-level` | `info` | Set log level: `{debug\|info\|warn\|error}` |
| `--read-only` | `false` | Run in read-only mode (prevent write operations) |

## Development

```sh
go mod tidy
go build ./...
go test ./...
```

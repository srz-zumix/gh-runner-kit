---
description: Inspect GitHub Actions without runner-kit
run-name: "Actions inspection baseline / ${{ inputs.correlation || github.run_id }}"
on:
  workflow_dispatch:
    inputs:
      checks:
        description: Comma-separated reliability,performance,configuration
        type: string
        default: reliability,performance,configuration
      days:
        description: Rolling days when since is omitted
        type: string
        default: "7"
      since:
        description: Optional inclusive RFC3339 start
        type: string
      until:
        description: Optional exclusive RFC3339 end
        type: string
      daily_limit:
        description: Maximum unique runs per intersecting UTC day
        type: string
        default: "1000"
      expected_sha:
        description: Expected trusted default-branch revision (optional for standalone runs)
        type: string
      correlation:
        description: Coordinator dispatch identifier (optional)
        type: string
permissions:
  contents: read
  actions: read
  copilot-requests: write
engine: copilot
concurrency:
  group: actions-inspection-baseline-${{ github.run_id }}
  job-discriminator: ${{ github.run_id }}
timeout-minutes: 15
max-ai-credits: 50
network:
  allowed: [defaults]
imports:
  - uses: shared/actions-inspection/common.md
    with:
      backend: baseline
---

# Independent baseline inspection

Use the shared inspection instructions. This backend must not install or invoke
runner-kit. Do not fetch additional evidence: collection has already completed.

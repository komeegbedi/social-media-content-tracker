# TODO

## Non-blocking maintenance warnings

- [ ] **Upgrade the Cloud Functions Node runtime before October 31, 2026.** Node 20 is deprecated and scheduled for decommissioning on **2026-10-31**. Select a Firebase-supported successor, update every runtime declaration and related tooling, verify locally, and deploy before the deadline.
- [ ] **Review the recurring GCR `cleanup-image` warning.** The warning is currently benign and costs only a few cents per month. Confirm whether an image cleanup policy should be configured; otherwise document the accepted cost and warning so it is not mistaken for a deployment failure.

## Implementation prompt

```text
Address the two non-blocking Firebase maintenance warnings in this repository:

1. Node 20 runtime deprecation
   - Node 20 is scheduled to be decommissioned on 2026-10-31.
   - Inspect all Cloud Functions runtime declarations, package engine constraints, CI/deployment configuration, dependencies, and documentation.
   - Check the current official Firebase documentation and select a supported successor runtime.
   - Upgrade the runtime consistently, update incompatible dependencies or code only where necessary, and preserve existing function behaviour.
   - Run the relevant unit tests, lint/build checks, and Firebase emulator tests.
   - Report any deployment prerequisites or compatibility risks. Do not deploy unless explicitly asked.

2. Recurring GCR cleanup-image warning
   - Determine exactly what emits the warning and whether the project already has an Artifact Registry/GCR image cleanup policy.
   - Estimate the practical impact. The current observation is a benign recurring cost of only a few cents per month.
   - Recommend either a safe cleanup policy with a retention window that will not interfere with Cloud Functions rollbacks, or explicitly document why accepting the warning and cost is preferable.
   - Do not delete images or change live cloud resources unless explicitly authorized.

Keep the work narrowly scoped. Before editing, summarize the files and cloud settings involved. After editing, provide a concise change summary, verification results, remaining manual steps, and any official documentation used. The task is complete only when the repository is ready for the runtime upgrade and the cleanup-image warning has a documented, actionable disposition.
```

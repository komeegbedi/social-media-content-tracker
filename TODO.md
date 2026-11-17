# TODO

## Cloud Functions Node runtime

- The runtime is upgraded from `nodejs20` to `nodejs22` in `firebase.json` and
  `functions/package.json` (Node 20 is decommissioned on 2026-10-31). Remaining:
  - Deploy the Cloud Functions on the new runtime before the deadline.
  - Install Node 22 locally for emulator and deploy parity (the dev machine is still on Node 20).

## Recurring GCR `cleanup-image` warning

- `firebase deploy` logs a benign "Unhandled error cleaning up build images" warning
  (a few cents/month of orphaned Cloud Build images). Decide between:
  - Configuring an Artifact Registry cleanup policy with a retention window that will not
    interfere with Cloud Functions rollbacks, or
  - Documenting the accepted cost so the warning is not mistaken for a deployment failure.

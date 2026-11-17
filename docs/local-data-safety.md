# Local emulator data safety

Why this exists: on 2026-11-16 the Mac restarted (a macOS update). macOS clears
`/private/tmp` at boot, and every development-emulator export lived there. The
development emulators were running without saving on exit, so their data,
including hand-made content, was lost. Nothing in this document touches
production.

## Where things live

| What | Where | Cleared by |
|---|---|---|
| Backups (all kinds) | `~/IFC-local-backups/` (override: `IFC_BACKUP_ROOT`) | nothing automatic; never inside the repo, `/tmp`, `/private/tmp` or the OS temp dir (checked) |
| Dev emulator snapshots | `~/IFC-local-backups/dev-emulators/<project>/<UTC stamp>-<kind>/` | only retention (below) |
| Isolated review exports | `~/IFC-local-backups/isolated-review/` | nothing automatic |
| Source snapshots | `~/IFC-local-backups/source-snapshots/` | nothing automatic |
| Emulators' own temp files | a private `ifcdev-*` / `ifcemu-*` / `ifcverify-*` folder in the OS temp dir | the process that created it |
| Test runs | `.emulator-test-tmp/<project>-<time>/` (git-ignored) | never the backup root |

Backups contain account data (Auth exports) and test passwords: they stay outside
the repository and are never committed. `.env*` files and `functions/.secret.local`
are excluded from source snapshots.

## Development emulators

```sh
npm run dev:emulators          # = node scripts/dev-emulators.mjs
```

* Loads the newest **verified** snapshot (or `--from <folder>`). With none, it says
  so and starts empty.
* Every 10 minutes (`--every`) takes a `periodic` snapshot; every 6th
  (`--verify-every`) is restored into a separate throwaway emulator and compared
  (`verify.json`). Periodic snapshots matter because an abrupt restart skips the
  shutdown export.
* On Ctrl+C it exports into a new `on-exit` folder and restore-checks it.
* Nothing is ever overwritten. Retention removes only verified, tool-named
  `periodic` / `on-exit` snapshots beyond the newest 12, and always leaves at
  least 3 verified ones. `manual`, `pre-restart`, unverified and foreign folders
  are never removed automatically.

Before risky work, take a manual snapshot of running emulators:

```sh
node scripts/emulator-backup.mjs snapshot --config firebase.json --project <id> --bucket <bucket> \
  --firestore 127.0.0.1:8080 --auth 127.0.0.1:9099 --storage 127.0.0.1:9199 \
  --dest ~/IFC-local-backups/dev-emulators/<id> --kind manual --verify
```

Check any export: `node scripts/emulator-backup.mjs verify <folder> --project <id> --bucket <bucket>`.

## Separation (tested in `test/emulatorBackup.test.js`)

| Environment | Project | Ports |
|---|---|---|
| Development | `ifc-social-media-tracker` | `firebase.json` (8080, 9099, 9199, 5001, …) |
| Automated suites | `demo-*` (refused otherwise) | 84xx / 94xx / 54xx (`scripts/emulator-test.mjs`) |
| Isolated review | `demo-academy-e2e` | 8390, 9590, 9690, 5390, hub 4430 |
| Restore verification | as exported | 8470, 9471, 9472, hub 4470 |

* No two environments share a port (tested).
* The test runner deletes only the `ifcemu-*` temp folder it created, through a
  guard that refuses anything else or anything overlapping the backup root
  (tested).
* A backup root inside the repo, `/tmp`, `/private/tmp` or the OS temp dir is
  refused (tested).

Run: `npm run test:safety`.

## Self-test (2026-11-17, throwaway project `demo-persist-check`)

1. A periodic snapshot was taken and verified (restored copy identical).
2. The emulators and the launcher were killed with `kill -9` (no shutdown export).
3. The restart loaded that verified snapshot; a Firestore document, its
   sub-document, an Auth user and a Storage object were all back.
4. Ctrl+C wrote a new `on-exit` export, restore-checked; the earlier snapshot was
   kept.

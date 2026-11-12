# IFC Creatives Board

**Plan. Create. Review. Publish.** A content operating system for the **IFC (Immanuel Fellowship Church) Creative Team** — replacing a Google Sheet and a WhatsApp group with a focused, mobile-first web app for planning, producing, reviewing, and posting content.

> [!NOTE]
> **Project status.** The full app runs in **production on Firebase** — the React client on Hosting and the notification/reminder/email **backend** on Cloud Functions (2nd gen, Node 22). The client (URL-driven navigation, notification deep-linking, QA-as-a-department, the capacity engine, UID-based assignment authorization) and the backend (immediate + scheduled notifications, web push, and Resend transactional email with an admin **"Resend account usage"** diagnostics panel) are **implemented, tested, and deployed**. See [Roadmap](#roadmap) and [Deployment](#deployment).

---

## Table of contents

- [Project Overview](#project-overview)
- [Screenshots](#screenshots)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Core Features](#core-features)
- [Architecture](#architecture)
- [Design Principles](#design-principles)
- [Development Guidelines](#development-guidelines)
- [Testing](#testing)
- [Deployment](#deployment)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Project Overview

### What it is

IFC Creatives Board tracks every piece of content — a reel, a poster/graphic, or a photo set — from **idea → production → QA → approval → posting**. Each item has a clear owner, a support crew, content links, an approval history, and an activity timeline, with a lightweight "wins" layer that celebrates finished work.

### The problem it solves

The team previously coordinated through a shared Google Sheet and a WhatsApp group. That meant:

- People didn't know what they owned or what to do next.
- Content links (Drive files) were scattered across chat.
- Approvals happened informally and were easy to lose.
- Leaders couldn't see what needed attention, so deadlines slipped.

### Who it's for

A mostly-volunteer church creative team working **primarily from their phones**: contributors (shoot / edit / design / coordinate), QA reviewers, a captions/upload crew, department leads, and admins. The tone is intentionally encouraging — this is not a heavyweight project-management tool.

### Key features

- A system-driven **7-stage workflow** that always knows the next action and next owner.
- **Auto-assignment** that balances real, effort-weighted workload across the team.
- **Role-aware dashboards** — everyone sees what's relevant to them.
- A **notification and reminder engine** that keeps the team proactive even when the app is closed.
- **Recurring-event planning** tied to the church calendar.
- A **mobile-first** experience with offline-friendly data and dark mode.
- **IFC Creative Academy** ("Learn") — six learning categories, courses (link-only video, portrait covers, server-graded quizzes, saved progress, discussions), quick guides and learning paths. *(On the `creative-academy` branch; see [docs/academy.md](docs/academy.md).)*

---

## Screenshots

> _Screenshots are intentionally omitted from this repository to avoid exposing team members' names and private content links._
>
> _Placeholders: Home dashboard · Workflow board · Task detail · Plan Content editor · Team Load · Admin._

---

## Tech Stack

| Layer | Choice |
| --- | --- |
| **Frontend** | React 18 + Vite (JSX, no TypeScript) |
| **Routing** | React Router v6 (`createBrowserRouter`, URL-driven) |
| **Styling** | Plain CSS with custom properties (light/dark theming) |
| **State** | React hooks + Firestore real-time subscriptions (no Redux/Zustand) |
| **Database** | Cloud Firestore (real-time listeners, offline persistence) |
| **Authentication** | Firebase Auth (Email/Password + Google) |
| **Authorization** | Firestore Security Rules (`firestore.rules`) — the source of truth |
| **Backend** | Firebase Cloud Functions (2nd gen, Node 22) — a thin notification/reminder/email layer |
| **Notifications** | Firebase Cloud Messaging (web push) + in-app Notification Center |
| **Email** | [Resend](https://resend.com) transactional email, sent from Cloud Functions |
| **Hosting** | Firebase Hosting (SPA) |
| **Tooling** | `firebase-tools` (emulators + deploy), `firebase-admin` (seed/import), `luxon` (timezone math), `jsdom` (test DOM) |

The client owns the UI and every interactive write. **Authorization and data integrity are enforced server-side by Firestore rules** — never by the UI. The only server-side application code is the notification backend, which reacts to Firestore changes and runs a scheduled dispatcher.

---

## Project Structure

A deliberately small, flat codebase. Most "components" are functions inside `App.jsx`; shared logic lives in focused, framework-free modules that are easy to test.

```
.
├── index.html                 # Vite entry; viewport, theme-color, pre-paint theme script
├── firebase.json              # Hosting + Firestore rules/indexes + Functions + emulator config
├── firestore.rules            # Server-side authorization (source of truth)
├── firestore.indexes.json     # Composite indexes
│
├── src/
│   ├── main.jsx               # Bootstraps React + the router; initTheme() + error capture
│   ├── App.jsx                # The app shell: most pages + real-time hooks
│   ├── AdminScreen.jsx · EmailUsage.jsx · MentionComposer.jsx · RevisionComposer.jsx ·
│   │                          #   AdminOverrideDialog.jsx · ProfileDrawer.jsx · … (extracted feature UIs)
│   ├── workflowTransition.js · emailUsageDoc.js · notificationPolicy.js · importPlan.js ·
│   │                          #   adminActions.js · … (pure, framework-free logic modules)
│   ├── firebase.js            # Firebase init + emulator wiring (the "service" layer)
│   ├── nav.js                 # Pure URL ⇄ screen mapping (routes, overlays, migration)
│   ├── navHooks.js            # React adapters over the router + nav.js (useNav, scroll)
│   ├── data.js                # Pure logic: workflow, auto-assign, capacity, search, matching
│   ├── events.js              # Recurrence engine + ministry events
│   ├── notifications.js       # Notification Center hook + preference helpers
│   ├── push.js                # FCM web-push enrollment
│   ├── logging.js             # Error capture, issue reporting, route tracking
│   ├── theme.js               # Light/dark theme (system pref + persistence)
│   ├── releases.js            # "What's New" release notes
│   ├── styles.css             # All styles + the light/dark design tokens
│   └── *.test.js              # Node unit tests (see Testing)
│
├── functions/                 # Cloud Functions — the notification/reminder/email backend
│   ├── index.js               # Entry: global options + exports
│   ├── lib.js                 # Shared helpers (idempotent writes, notifyUsers, recipients, timezone)
│   ├── emailService.js        # Resend send (templates, idempotent POST /emails, delivery log)
│   ├── emailQuota.js          # App-owned send caps (2,800/mo · 90/day) + atomic reservation + admin alerts
│   ├── resendObservationV1.js # Display-only "last observed" Resend account-usage model (writes emailUsageV1)
│   ├── resendQuotaMath.js     # Pure quota-header parsing + strict numeric validation
│   ├── resendUsage.js         # Legacy provider-usage cache (dormant; superseded by resendObservationV1)
│   ├── getEmailUsage.js       # Admin-only callable: read the sanitized last-observed usage
│   ├── onTaskWrite.js         # Assignment/status notifications; reminder materialization
│   ├── onCommentCreate.js     # @mention notifications
│   ├── onUserWrite.js         # New registration → admins; approval → user
│   ├── onFcmTokenWrite.js     # Privacy-safe push-device rollup on the user doc
│   ├── dispatchReminders.js   # Hourly reminder dispatcher + leadership digest
│   ├── retryDeliveries.js     # Retry sweep for unsettled email deliveries
│   ├── weeklyTaskCheck.js     # Saturday 9 PM team check-in
│   ├── cleanupRetention.js    # Daily retention pruning
│   ├── adminOverride.js       # Admin-only callable: audited status override (never a QA decision)
│   ├── bulkAssign.js · removeUser.js   # Admin-only callables: server-trusted (re)assignment + removal
│   └── sendTestEmail.js       # Admin-only callable to verify the email pipeline
│       # + focused helpers: assignmentIdentity, assignmentRecipients, mentions,
│       #   notificationPolicy, reminderSchedule, deliveryCore, removalSaga, taskDetach
│
└── scripts/
    ├── seed.js                # Seed the emulator with demo users + tasks + notifications
    ├── import-csv.js          # Import a CSV into Firestore
    ├── backfill-assignee-uids.js  # One-off: backfill assigneeUids on existing tasks
    └── verify-headers.mjs     # Hosting security-header check (npm run test:headers)
```

**Mental model for newcomers:**

- **Pages & components** → functions in `src/App.jsx` (`Home`, `MyDay`, `BoardList`, `Mine`, `Team`, `Admin`, `TaskDetail`, `TaskEditor`, …), with larger feature UIs extracted into their own files (`AdminScreen.jsx`, `EmailUsage.jsx`, `MentionComposer.jsx`, …) so their states are DOM-testable.
- **Navigation** → `src/nav.js` (pure) + `src/navHooks.js` (`useNav`).
- **Business logic** → pure, framework-free modules (`src/data.js`, `events.js`, `nav.js`, `workflowTransition.js`, `emailUsageDoc.js`, `notificationPolicy.js`, …) — no React, no Firebase, unit-testable.
- **Services** → `src/firebase.js` and `functions/`.

---

## Getting Started

### Prerequisites

- **Node 20+** for the app and tests, and a **JDK** (the Firebase emulators require Java). **Cloud Functions target the Node 22 runtime** (`firebase.json` + `functions/package.json`) — install Node 22 locally for emulator and deploy parity.
- `firebase-tools` is pinned to **v13** as a local dev dependency (v14+ needs Java 21). No global CLI install is required.

> [!NOTE]
> The Vitest UI tests use `jsdom@24`, which is CommonJS-clean on Node 20. `jsdom@25+` can fail under Node 20's test loader; bump it only after the local toolchain moves to Node 22+.

### Installation

```bash
npm install                       # app deps + firebase-tools + firebase-admin
npm install --prefix functions    # Cloud Functions deps
```

### Environment variables

Configuration lives in **three tiers**. Keep them separate, and never place a secret in frontend config.

**1 — Public frontend config** (`.env`, gitignored; copy from `.env.example`). All `VITE_*` values ship to the browser and are public by design — security is enforced by Auth + rules, so these are **not** secrets.

| Variable | Purpose |
| --- | --- |
| `VITE_FIREBASE_API_KEY` … `VITE_FIREBASE_APP_ID` | Firebase web config (Console → Project settings) |
| `VITE_FIREBASE_VAPID_KEY` | FCM Web Push public key. Blank ⇒ push disabled |
| `VITE_FIREBASE_APPCHECK_KEY` | App Check reCAPTCHA v3 site key. Blank ⇒ App Check skipped |
| `VITE_USE_EMULATOR` | `true` routes Auth/Firestore/Functions to the local emulator |

**2 — Server-only config** (`functions/.env`, optional; all values have safe defaults).

| Variable | Purpose | Default |
| --- | --- | --- |
| `IFC_APP_URL` | Base URL for email deep-links | production URL |
| `IFC_REPLY_TO` | Monitored inbox for email Reply-To | *(unset)* |
| `RESEND_MONTHLY_EMAIL_LIMIT` | App-owned monthly email cap (UTC calendar month) | `2800` |
| `RESEND_DAILY_SAFETY_LIMIT` | App-owned daily runaway guard (clamped to the plan's 100/day) | `90` |

**3 — Google Cloud secret** (never in any `.env` or frontend code).

| Secret | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key, stored in **Google Cloud Secret Manager**, bound to functions via `secrets: [resendApiKey]`. Read server-side only; never logged. |

> [!WARNING]
> `.env` is gitignored. Never put real secrets in `VITE_*` variables — they ship to the browser. The Resend key lives **only** in Secret Manager.

### Running locally

Run the whole app against the **Firebase Emulator Suite** with seeded data. Production is never touched.

```bash
# Terminal A — emulators (Auth, Firestore, Functions, Pub/Sub, Storage, UI on :4000)
npm run emulators

# Terminal B — seed demo data, then start the dev server
npm run seed
VITE_USE_EMULATOR=true npm run dev     # http://localhost:5173
```

Seeded logins (shared password `password123`):

| Login | Role |
| --- | --- |
| `jane@example.com` | Admin |
| `john@example.com` | Member · QA |
| `sam@example.com` | Member · Captions/Upload |
| `riley@example.com` | Pending (approval screen) |

The seed also creates fictional Academy courses (`alex@example.com` is an instructor + department lead; `sam@example.com` has started a course). Re-run `npm run seed` anytime to reset. Scheduled functions don't fire on a timer in the emulator — invoke `dispatchReminders` manually to test reminder delivery.

### Production build

```bash
npm run build      # Vite production build → dist/
npm run preview    # serve the built bundle locally
```

### Deployment

See [Deployment](#deployment) for the full process. In short: `npm run deploy` publishes Hosting + Firestore rules + indexes; Cloud Functions deploy separately and require the Blaze plan.

---

## Core Features

Each feature below describes **what it does**, not how it's coded.

### Content planning

Plan a reel, poster, or photo set with an owner, a support crew, priority, shoot/post dates, a creative brief, and reference links. Dates are validated (post date on or after shoot date; no past dates on new content).

### Workflow

A system-driven **7-stage pipeline**: Planned → In Progress → In Review → Changes Requested → Approved → Ready to Post → Posted, grouped into four phases (Planning · Creating · Review · Posting) for the progress bar. The app derives the **next action and next owner** for every task — contributors never pick the next step manually. Reaching **Posted auto-archives** the task: it drops from every active surface but remains in Search, the Archive filter, and Admin.

### Team management & roles

Roles are flags on a user's profile; a person can hold several. Dashboards adapt to the role.

| Role | How it's set | Experience |
| --- | --- | --- |
| **Admin** | `role: "admin"` | Manages the **application**: people, imports, settings, issues, and workflow corrections. Admin does **not** grant content-review authority. |
| **Contributor** | default | My Day shows what needs attention; My Work separates leading vs supporting. |
| **QA reviewer** | `qa: true` | Grants **content-review authority** (Approve / Request changes). A **department**, not a production role — see below. |
| **Caption / Upload** | `captions: true` | Work that begins after approval — captions, ready-to-post, overdue. |
| **Department Lead** | `lead: true` + `department` | Receives the leadership follow-up digest. |

**Admin and QA are separate capability axes — not a hierarchy.**

- **Admin** manages the system and can perform explicit, audited administrative overrides.
- **QA** makes normal content-review decisions (Approve / Request changes).
- An Admin does **not** automatically inherit QA review authority. A user who is both may review because **`qa === true`**, not because they are an Admin.
- **Administrative override** is an exceptional, audited recovery operation (see below) — never a QA decision.

Normal review authorization is a single predicate — `canMakeReviewDecision(user, task)` = active **and** approved **and** `qa === true` **and** `task.status === "In Review"` — used by the UI **and** mirrored by the Firestore rules boundary (`isQA()` = approved + `qa == true`, with **no** admin bypass). The rules deny an Admin-only user the In Review → Approved / Changes Requested transition directly; an Admin reaches those only through the audited override callable.

| User type | Approve | Request changes | Administrative override |
| --- | --- | --- | --- |
| Member | No | No | No |
| Admin only | No | No | Yes |
| QA only | Yes | Yes | No |
| Admin + QA | Yes | Yes | Yes |

**Administrative override.** When an Admin must correct or recover the workflow — including forcing a status that is normally a QA decision — they use a deliberate **Administrative override** control (visually separated from the QA panel, never the Approve/Request-changes buttons). It requires selecting a destination status and a non-empty reason, shows a confirmation with the current status, destination, and reason, and runs through the `adminOverrideStatus` **Cloud Function** (server-controlled). The server records an explicit **`admin_override`** activity + immutable `auditEvents` record with the authenticated Admin's uid + name, the previous and resulting statuses, the reason, and a **server** timestamp — so the history clearly says *administratively overridden*, never *QA-approved*. Client-supplied identity, timestamps, and audit fields are never trusted.

**QA is a distinct department, not another production role.** Reviewers land on a review-focused **Reviews** screen and approve or request changes only while an item is in review. They can **observe** all of production — search any task, read task detail, and view Team capacity — but can never **operate** it: QA carries no production skills or availability, is never staffed as owner/crew, never appears in auto-assignment or recommendations, and never counts toward production capacity. This holds even for an admin who is also QA (admin governs what you manage; QA governs the department you belong to). The exclusions run through central predicates (`isProductionMember` / `isAssignable`) and the user-doc invariant is enforced in Firestore rules.

### Production workflow authorization (the assigned team)

Production is driven by a task's **assigned team**, not the owner alone. The **project owner and every assigned production crew member** — shooter, editor, designer, coordinator, any role — can drive the forward production steps and attach the required deliverable links. The production **role is irrelevant**: an assigned shooter can Start work, an assigned editor can add the editing link and Submit for QA. This is enforced in **Firestore security rules**, not just the UI.

| Actor | Start work / Submit / Resubmit (→ In Progress / In Review) | Approve / Request changes (QA) | Ready to Post / Posted | Edit content links & blocker | Change assignment identity | Admin override |
| --- | --- | --- | --- | --- | --- | --- |
| **Assigned** owner or crew (any role) | **Yes** — submit needs the type's required link | No | No | **Yes** | No | No |
| **Unassigned** member | No | No | No | No | No | No |
| **QA** only (`qa: true`) | No | **Yes** | No | No | No | No |
| **Captions** (`captions: true`) | No | No | **Yes** | No | No | No |
| **Admin** only | **Yes** — normal workflow events, *not* `admin_override` | No | **Yes** | **Yes** | **Yes** | **Yes** |
| **Admin + QA** | Yes | **Yes** | Yes | Yes | Yes | Yes |

- **Assigned production members cannot approve their own work** — In Review → Approved / Changes Requested is `qa === true` only (see the QA matrix above).
- **Admins drive the normal forward workflow with normal actions** (Planned → In Progress, → In Review, Changes Requested → In Review, Approved → Ready to Post, → Posted); these are recorded as **normal workflow events**, never `admin_override`. Override stays reserved for exceptional corrections (backward moves, stage skips, forcing a QA outcome without QA).
- **Required links are validated at the security boundary** — submitting to QA (→ In Review) is denied unless the content type's deliverable link(s) are present (`Reel` → video · `Poster` → ig + landscape · `Photography` → photos). Submit persists the link **and** status together in one concurrency-safe transaction that re-reads the task, so status never advances without its link and two simultaneous actions can't lose activity history.
- **Content links & blocker** are production data — editable only by an assignee or an Admin; everyone else sees them read-only.

Authorization is a pair of shared predicates used by the UI **and** mirrored by the rules: `isTaskAssignee(task, user)` and `canAdvanceProduction(task, user)` (in `src/data.js` ↔ `pIsTaskAssignee` / `pCanAdvanceProduction` in `firestore.rules`). QA, captions, Admin, and override remain **separate** capabilities.

### Stable assignment identity (UID-based)

Authorization is by **stable user id**, never by display-name comparison — so **renaming a user never removes their access**. Each task carries, alongside the display names (kept for rendering + back-compat):

- `ownerUid` — the owner's uid
- `support[].uid` — each crew member's uid
- `assigneeUids` — the authoritative deduped uid set the **security rules** read

These are maintained consistently across creation, editing, duplication, import, auto-assignment, bulk assignment, and user removal/reassignment. When a display name is a **duplicate**, **ineligible** (pending / removed / disabled / QA), or has **no matching active user**, it is **left unresolved and reported** — never silently mapped to the wrong person; an admin confirms the assignment. Existing uids are **authoritative across renames**: a valid stored uid is preserved (its display name is merely refreshed), never re-derived from a name — so a rename keeps access and another user later taking the old name cannot inherit it.

**Server paths never trust client-supplied uids.** The stable identity is re-derived on the trusted server for every write that isn't a plain client edit: **CSV import** stamps `ownerUid` / `support[].uid` / `assigneeUids` through the same resolution as normal creation (deterministic doc ids are hashed from the raw row, so stamping never affects idempotency); **bulk assignment** re-resolves each crew member by name to the *server's* user record and rewrites the uid from it (rejecting duplicate-name ambiguity and inactive/QA people), so a request pairing a valid name with a foreign uid can't authorize that uid; **assignment notifications** resolve recipients by `ownerUid` / `support[].uid` (name only as a legacy fallback), so a rename never mis-fires an "assigned" notice and a duplicate name never notifies the wrong person.

**Migration / rollout.** Existing tasks are backfilled with `scripts/backfill-assignee-uids.js` (dry-run by default; `--write` to apply; `--prod` for production). The rules keep a **legacy owner-name fallback keyed on field *presence*** — used **only** when a task has no `assigneeUids` field at all; a present-but-empty `assigneeUids: []` authorizes **nobody** (no name fallback), so a fully-migrated task with no assignees is closed rather than open. This lets the backfill run with zero downtime. The script reports **coverage** — once every *active* task's assignees resolve to a uid (0 unresolved), the legacy fallback in `firestore.rules` (`pIsTaskAssignee`) can be removed to make authorization strictly UID-only.

**Concurrency-safe transitions.** Every workflow advance runs through **one shared implementation** (`src/workflowTransition.js` → `planTransition`) that the client transaction *and* the emulator regression test both execute — no simulation drift. It re-reads the task inside a transaction against an expected source status: already at the destination → **idempotent success** (no duplicate activity event); at an unexpected status → **stale, no write** (the client is told to refresh); otherwise the status and its deliverable link persist together with exactly **one** self-attributed activity entry. Firestore's write-contention retry re-invokes the callback, so the loser of a race re-reads the winner's status and becomes an idempotent no-op — proven by concurrent Planned→In Progress and In Progress→In Review regression tests (exactly one `started`/`qa_sent` event; no lost history).

**Each transition records its exact event type.** The rules pin every stage to its activity type, and a missing / wrong / forged type is denied: `Planned→In Progress` = `started`, `In Progress`/`Changes Requested`→`In Review` = `qa_sent`, `In Review→Approved` = `approved`, `In Review→Changes Requested` = `changes_requested`, `Approved→Ready to Post` = `ready`, `Ready to Post→Posted` = `posted`. Every appended entry must carry the caller's own uid, a client-authored `admin_override` is always rejected (override is server-authored only), and the entry's **capability is attributed to the action, not the profile**: a QA decision records `qa`; an Admin driving production/posting records `admin`; a captions user posting records `captions`; an assigned owner/crew driving production records `member`.

### Auto-assignment

`autoAssign` filters eligible people (skill · location · availability) **first**, then balances by real, effort-weighted active workload across the whole board — so the genuinely lightest qualified person is chosen, not merely whoever appears on fewer rows. When picking a crew member manually, the editor shows that person's current load *before* you add them.

### Team Load & capacity

The Team Load screen measures the **effort of a person's current responsibilities**, not the number of rows their name appears on. Load is effort-weighted (e.g. editing counts more than coordination), phase-aware (a responsibility activates and clears automatically as the task moves), timeline-placed (this week / next week / later), and normalized to each person's availability into a coarse band (Available → Light → Balanced → Busy → High). The same engine powers auto-assignment and the assign-time hint.

### Notifications & reminders

An in-app **Notification Center** (bell, unread badge, mark-read, click-through) with per-user preferences. A server-side engine sends the right message to the person who owns the next action, across in-app / push / email channels. **Email is reserved for blocked, required, or escalation cases** so routine activity never fills inboxes. Each task carries a reminder schedule; a scheduled dispatcher delivers due reminders and a daily leadership digest.

**Every notification deep-links to exactly what it's about** — the task (scrolled to its review or comments section), an event, a filtered Workflow list, or **Admin → People** with the pending person highlighted for an approval request. Destinations come from one resolver (`notificationDestination`) driven by structured metadata, never by parsing text, and are mirrored server-side for push/email. See [Architecture](#architecture).

**Resend account usage (admin diagnostics).** The Email settings panel shows the **last observed** Resend account usage, captured from the quota headers on each accepted send and stored in a sanitized `adminDiagnostics/emailUsageV1` doc. It is **display-only and decoupled from enforcement** (sending is governed by the app-owned caps, not this reading); it makes no assumption about Resend's reset boundary, auto-updates via an admin-only listener after each app send, and **Refresh** only re-reads the saved observation — it never calls Resend. The app's own UTC month/day counters are shown separately as internal telemetry, never as a provider limit.

### Recurring events

A real recurrence engine generates upcoming church events (e.g. Cross Over Service on the last day of the month, Praise & Testimony Night on the last Friday, a bi-monthly vigil) with no hardcoded dates. Admins create and edit their own recurring series in **Admin → Events**. Home cards show the next date, days remaining, and per-occurrence content status, with **Create content** / **View content** actions.

### Import with intelligent name matching

Bulk-create tasks from a CSV or the team's Google Sheet. Owners and crew without accounts import as **Pending**. The importer reconciles shortened, alternate, and misspelled names against real accounts (e.g. "Jon" → Jonathan Smith), auto-resolving only clear, unambiguous matches and asking an admin to confirm the rest. Confirmed mappings are remembered for next time.

> [!NOTE]
> Import is currently **hidden behind a build flag** (`ENABLE_CSV_IMPORT`, wired through `AdminScreen.jsx`). Flip it to expose the Import tab for a launch or bulk load.

### Admin & reporting

A leadership dashboard with quick actions, severity-coded health cards ("needs attention", "ready to move"), a cross-task activity feed, people management, and an issues log. Any signed-in user can file a bug or feature request; runtime errors are captured automatically. Everything lands in the Firestore `issues` collection for admin triage.

### Mobile experience

A floating "liquid-glass" bottom nav and header, a single controlled scroll region (no iOS rubber-banding), role-aware navigation, safe-area handling for the iPhone URL bar, and dark mode with a three-way preference (Match system · Light · Dark). Data renders instantly from an offline cache and syncs in the background.

---

## Architecture

### High-level

A single-page React app talks **directly to Firestore** for all reads and writes. Real-time listeners keep every connected client in sync. A thin Cloud Functions backend reacts to data changes and dispatches notifications — it never sits between the client and the database.

```
                 ┌─────────────────────────────────────────┐
   Firebase Auth │  React SPA (Firebase Hosting)            │
   ───────────▶  │   • URL-driven navigation (React Router) │
                 │   • real-time Firestore listeners        │
                 └───────────────┬─────────────────────────┘
                                 │ reads/writes (gated by rules)
                                 ▼
                        ┌─────────────────┐
                        │  Cloud Firestore│◀───── Firestore Security Rules
                        └───────┬─────────┘        (authorization source of truth)
                                │ document triggers
                                ▼
                 ┌─────────────────────────────────────────┐
                 │  Cloud Functions (notification backend)  │
                 │   • immediate notifications on write     │
                 │   • hourly reminder dispatcher           │
                 │   • push (FCM) · email (Resend)          │
                 └─────────────────────────────────────────┘
```

### Authentication & gating

`App()` renders a gating ladder: **loading → signed-out → no profile → pending approval → the app**. A user's profile lives in `users/{uid}`; new sign-ups start as `pending` until an admin approves them. Sessions persist across reloads and restarts (Firebase's default local persistence) until the user signs out.

### Routing (URL-driven)

The URL is the **single source of truth** for what's on screen. `src/nav.js` maps between locations and screens; `src/navHooks.js` exposes a `useNav()` adapter that the UI uses instead of touching history directly.

| Path | Screen |
| --- | --- |
| `/` | Home |
| `/my-day` | My Day |
| `/workflow` | Workflow (`?event=<id>` scopes to one occurrence) |
| `/my-work` | My Work |
| `/team` | Team |
| `/admin` | Admin (`?section=…`) |
| `/content/:contentId` | Content detail |

Overlays are URL-backed query parameters (`?compose=new`, `?edit=<id>`, `?panel=profile|notifications|search`) so that opening a modal pushes one history entry and **Android/browser Back closes it before leaving the page**. Legacy `?task=` / `?tab=` links migrate once to canonical URLs. Unsaved edits are protected by React Router's `useBlocker` plus a `beforeunload` guard. Firebase Hosting rewrites all routes to `index.html`, so deep links and refresh work everywhere.

### Data & real-time sync

Three hooks in `App.jsx` power live data: `useAuthUser()`, `useProfile(uid)`, and `useCollection(path, canRead)`. Writes go straight to Firestore and are validated by rules; `onSnapshot` listeners stream the result back to every client. A persistent IndexedDB cache renders data instantly on repeat visits and works offline.

**Primary collections:** `users` · `tasks` · `eventSeries` · `issues` · `notifications` · `reminderInstances` · `settings/notifications` · `emailDeliveries` · `systemUsage` · `adminDiagnostics` · `auditEvents`. Server-owned collections (`reminderInstances`, `emailDeliveries`, `systemUsage`, `adminDiagnostics`, `auditEvents`) are admin-read and never client-writable.

### Notification backend

To keep the app proactive when no one has it open, Cloud Functions react to Firestore and dispatch notifications:

- **Immediate** — `onTaskWrite` (assignment, status transitions), `onCommentCreate` (@mentions), `onUserWrite` (registration → admins, approval → user).
- **Scheduled** — an **hourly** dispatcher drains a materialized `reminderInstances` queue, claiming each instance with an atomic lease so overlapping runs can't double-send, and emits a daily **leadership follow-up digest**. A **weekly** Saturday check-in nudges the team about Sunday.
- **Channels** — in-app is the system of record; push and email are per-user opt-in. Email is reserved for blocked/required/escalation cases and is quota-guarded (atomic reservation, priority shedding, monthly/daily caps).

All notification writes use deterministic IDs and idempotency keys. Timezone math (`America/Winnipeg` ⇄ UTC) uses `luxon`.

---

## Design Principles

- **Mobile-first.** The team works from phones. Layout, navigation, and touch targets are designed for small screens first, then enhanced for desktop.
- **URL-driven navigation.** The URL is the single source of truth. Every meaningful screen and overlay is addressable, shareable, and back-button-friendly.
- **Authorization lives in the rules.** The UI is a convenience; Firestore Security Rules are the enforcement boundary. Never rely on hiding a button.
- **Keep pure logic pure.** Business logic in `data.js` / `events.js` / `nav.js` has no React or Firebase dependencies, so it's trivially testable and reusable.
- **Offline-friendly.** Persistent local cache means the app opens instantly and keeps working through flaky mobile connections.
- **Accessible by default.** Semantic markup, labelled icon-only controls, focus management on navigation, focus-trapped modals, and a global `prefers-reduced-motion` reset.
- **Simplicity over complexity.** No Redux, no component framework, no premature abstractions. One shell, focused modules, plain CSS tokens.
- **Encouraging, not heavyweight.** The product celebrates progress and shows people only what's relevant to them.

---

## Development Guidelines

- **Component organization.** Pages and components are functions in `src/App.jsx`. Extract into a module only when logic is pure and reusable (as with `nav.js` / `navHooks.js`).
- **State management.** Prefer Firestore subscriptions and derived state over local caches. **Never keep two independent sources of truth** — navigation state is derived from the URL, not mirrored into React state.
- **Routing conventions.** Use `useNav()` — never call `history` or compare pathnames directly. Normal navigation **pushes** a history entry; use **replace** only for redirects, normalization, and legacy-link migration. Minor UI state (dropdowns, accordions, toasts) stays local and never touches history.
- **Naming.** Match the surrounding code: descriptive camelCase, semantic CSS tokens (no raw hex in new rules), and consistent terminology (a "task" is a piece of content; "crew" is the support team).
- **Error handling.** Uncaught errors, promise rejections, and render crashes are captured by `logging.js` + an `ErrorBoundary` into the `issues` collection with full context. Surface real failures — don't mask them.
- **Performance.** Data is already in memory via subscriptions; avoid redundant reads. Animate transform/opacity only. The icon set is imported per-symbol; route-level code-splitting is the planned next optimization.
- **Accessibility.** Every icon-only button needs a label; modals trap focus and restore it on close; motion respects `prefers-reduced-motion`.

---

## Testing

The project has no lint or type-check tooling (plain JSX). Pure logic and Cloud Functions run on **Node's built-in test runner**; rendered components run on **Vitest + jsdom**.

| Command | What it checks |
| --- | --- |
| `npm run build` | Frontend production build (Vite) — the compile/lint gate |
| `npm test` (`node --test src/*.test.js`) | Pure frontend unit tests — **474** across 39 files |
| `npm run test:ui` (Vitest + jsdom) | Rendered-component tests (`*.ui.test.jsx`) — **176** across 15 files |
| `npm run test:functions` | Cloud Functions unit tests — **186** — plus `node --check functions/index.js` |
| `npm run test:emulator` | Backend integration against a throwaway Firestore emulator (`test/*.test.js`) — **243** across 22 files |
| `npm run verify` | Runs build + all four suites in sequence |

Also available: `npm run test:headers` (Hosting security-header check), `npm run test:trigger` (a functions-triggered mention test) and `npm run test:academy` (Academy **Firestore + Storage** rules against throwaway Firestore + Storage emulators — the Storage suite needs both because `storage.rules` reads Firestore). There is no separate lint step — the project is plain JSX (no TypeScript), so a clean `npm run build` is the compile/lint gate.

**Frontend suites** cover the recurrence engine, content Title-Case, task-UX helpers, the **capacity engine**, date validation, theme resolution, stylesheet **guards** (input contrast; capacity expand-in-place), **QA-as-a-department** rules (production exclusions, capabilities), the pure **navigation mapping** including **notification destinations** (`nav.test.js`), and a **jsdom history-integration** suite (`nav.integration.test.js`) that drives the real router through push/back/forward, overlay-close-on-Back, launcher-replace, legacy-link migration, and the unsaved-form blocker.

**Testing philosophy:**

- **Push pure logic into framework-free modules and test it directly under Node.** This is why `data.js`, `events.js`, and `nav.js` avoid React and Firebase.
- **Test behavior and contracts, not implementation.** Navigation tests assert what the user experiences (Back returns to the previous screen), not internal call order.
- **Guard against silent regressions.** The contrast test fails the build if an input becomes invisible against its surface; the nav tests fail if a legacy link stops migrating.

**Backend integration** is exercised against the running Emulator Suite with `firebase-admin` scripts (seed, assert, clean up) — assignment/QA/approval flows, idempotency, dispatcher lease de-duplication, and email quota behavior.

> [!NOTE]
> The emulator **skips real Resend calls** for trigger-driven email, so development never spends quota. Only the admin test-email callable sends for real — use a real inbox or `delivered@resend.dev`.

---

## Deployment

> [!IMPORTANT]
> There are two environments: **local (emulator)** and **production**. There is no separate staging environment — validate against the emulator before deploying.

### Production (Hosting, rules, indexes)

One-time, in the [Firebase console](https://console.firebase.google.com/): enable **Email/Password** and **Google** sign-in, and create the **Firestore database** (production mode).

```bash
npx firebase login    # one-time, interactive
npm run deploy        # builds, then deploys Hosting + Firestore rules + indexes
```

Publishes to `https://<project-id>.web.app`. Firebase Hosting's SPA rewrite (already configured) serves `index.html` for every route.

> [!WARNING]
> Set `.env` `VITE_USE_EMULATOR=false` before a production build, or the deployed app will point at a local emulator.

### Cloud Functions (notification backend)

Requires the **Blaze** (pay-as-you-go) plan.

1. Upgrade to **Blaze** and set a **GCP budget/billing alert** (cost is ~cents/month at this scale, but non-zero).
2. For push: enable **Cloud Messaging** and add a **VAPID key** to `.env`.
3. For email: verify the **Resend** sending domain and confirm the **`RESEND_API_KEY`** secret exists in Secret Manager.
4. Deploy: `npx firebase deploy --only functions`. Hourly and daily schedules register automatically.

> [!NOTE]
> **The notification backend is deployed in production** (2nd-gen Cloud Functions on Node 22, region `northamerica-northeast1`). The one-time setup below was completed for the live environment — keep it as the reference for a fresh environment or a re-bootstrap. Scoped redeploys use `firebase deploy --only functions:<name>`.

**One-time production setup (completed for the live environment; reference for a fresh one):**

- [ ] Blaze plan enabled + billing alert set
- [ ] `RESEND_API_KEY` in Secret Manager; functions granted access
- [ ] Resend sending domain verified
- [ ] VAPID key in `.env`; App Check key registered (optional)
- [ ] Firestore indexes and security rules deployed
- [ ] `IFC_APP_URL` set to the production URL
- [ ] Send a test email and confirm acceptance
- [ ] iPhone PWA test: Add to Home Screen → open → enable push → receive a notification
- [ ] First **admin** bootstrapped (register in-app, then set `role: "admin"`, `status: "approved"` on the `users/{uid}` doc)

**Rollback:** revert Hosting in the console (or redeploy a previous build); disable a misbehaving function with `firebase functions:delete <name>`.

### Troubleshooting

**Google sign-in fails on iOS/Safari with _"missing initial state … sessionStorage"_.**
The app is served from `*.web.app` (or a custom domain) while Firebase Auth's OAuth
handler runs on `*.firebaseapp.com` — **different origins**. Safari's storage
partitioning gives the handler its own `sessionStorage`, so the sign-in state
written before the redirect is invisible when the handler reads it. There is no
client-side workaround; the auth handler must be **same-origin** with the app.

Fix (one-time, in the Google Cloud console — Firebase can't do it for you):

1. **Google Cloud Console → APIs & Services → Credentials →** the OAuth 2.0
   Client ID *"Web client (auto created by Google Service)"*.
2. Add to **Authorized redirect URIs**: `https://<your-app-domain>/__/auth/handler`
   (e.g. `https://ifc-social-media-tracker.web.app/__/auth/handler`).
3. Add to **Authorized JavaScript origins**: `https://<your-app-domain>`.
4. Confirm the domain is listed under **Firebase Console → Authentication →
   Settings → Authorized domains**.
5. Set `VITE_FIREBASE_AUTH_DOMAIN` to `<your-app-domain>`, rebuild, and redeploy.

> Skipping step 1 and just changing `authDomain` returns **`redirect_uri_mismatch`**.
> The most robust long-term setup is a **custom domain** used as both the app URL
> and `authDomain`.

---

## Roadmap

Each item is marked **implemented**, **tested** (unit/integration), and **deployed** (live in production) where they differ. The web client deploys with Hosting; the Cloud Functions backend deploys separately — both are now live.

### Completed — implemented, tested, and live

- System-driven 7-stage workflow with auto-archive on Posted
- Effort-weighted **workload & capacity engine** powering Team capacity + auto-assignment
- **QA as a department** — review-focused landing (Reviews), read-only production visibility, and hard production exclusions (never staffed, recommended, or counted in capacity), enforced by central predicates
- Role-aware dashboards (Home, My Day, My Work, Team, Admin)
- **URL-driven navigation** with Android/browser back-button support, launcher-replace policy, and unsaved-change protection
- **Notification deep-linking** — every notification opens the exact task section, event, filtered list, or Admin → People pending approval it refers to
- Recurring-event engine + admin-managed event series
- Intelligent name matching for imports
- In-app Notification Center + per-user preferences
- **Mobile-first design system** (glass nav/header, single-scroll shell, dark mode)
- Offline persistence, logging/error capture, "What's New" + feature requests
- **Notification/reminder backend** (2nd-gen Cloud Functions) with **web push** and **Resend transactional email** — immediate + scheduled notifications, atomic email-quota reservation, and a retry sweep; deployed to production
- **Resend account-usage display** — display-only "last observed" provider usage in the admin Email panel (decoupled from enforcement; no reset-boundary assumptions)
- **UID-based assignment authorization** — stable `ownerUid` / `support[].uid` / `assigneeUids`, enforced in Firestore rules (rename-safe; a legacy owner-name fallback remains until backfill coverage is 100%)

### Planned

- **Department-lead dashboards** and a dedicated **Events calendar** page
- **Preferred names / nicknames** on the profile (the import-side matcher is the first half)
- **Capacity engine v2** — content-complexity multiplier, time-span responsibilities, tunable/versioned weights, stage-level cycle-time insight (never ranking individuals)
- **Passwordless auth** (magic link / email code / passkeys) to ease volunteer onboarding
- **Content-performance analytics** (Instagram / Facebook / YouTube) and calendar/Drive integrations
- **PWA & performance** — route-level code-splitting, richer offline support
- Bulk admin actions; recurring content templates; AI caption suggestions
- **Strictly UID-only authorization** — once `scripts/backfill-assignee-uids.js` reports 100% coverage on active tasks, remove the legacy owner-name fallback in `firestore.rules` (`pIsTaskAssignee`) so task authorization is UID-only. Also unblocks a per-task `reviewerId`.

---

## Contributing

1. **Branch** off `main` (`feature/…` or `fix/…`).
2. **Develop against the emulator** (`npm run emulators` + `VITE_USE_EMULATOR=true npm run dev`). Never test against production data.
3. **Keep the split:** pure logic in `data.js` / `events.js` / `nav.js` (no React/Firebase), UI in `App.jsx`. Match the surrounding style.
4. **Authorization changes go in `firestore.rules`** — and must be enforced there, not just in the UI. The emulator hot-reloads rules; test both allow and deny paths.
5. **Verify before opening a PR:** `npm run build` is clean, `node --test src/*.test.js` passes, and you've exercised the change in the running app.
6. **Open a PR** and request review before merging.

**Code quality expectations:** clear over clever, consistent terminology, no secrets in frontend config, accessible controls, and tests for new pure logic.

---

## License

This is a **private, internal project** for the IFC Creative Team. No open-source license is granted; the repository is not intended for public redistribution.

> _Flagged for the maintainer: there is no `LICENSE` file and `package.json` declares no `license` field. Add one (even `"UNLICENSED"`) to make the intent explicit._

# IFC Creatives Board

**Plan. Create. Review. Publish.** A content operating system for the **IFC (Immanuel Fellowship Church) Creative Team** — replacing a Google Sheet and a WhatsApp group with a focused, mobile-first web app for planning, producing, reviewing, and posting content.

> [!NOTE]
> **Project status.** The core app runs in production on Firebase Hosting. Two bodies of work are complete in the codebase but **not yet deployed**: the notification/reminder backend (Cloud Functions, "v1.1") and the URL-driven navigation refactor (on a feature branch). See [Roadmap](#roadmap) and [Deployment](#deployment).

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
| **Backend** | Firebase Cloud Functions (2nd gen, Node 20) — a thin notification/reminder layer |
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
│   ├── App.jsx                # The app: all pages/components + real-time hooks
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
├── functions/                 # Cloud Functions — the notification/reminder backend
│   ├── index.js               # Entry: global options + exports
│   ├── lib.js                 # Shared helpers (idempotent writes, recipients, timezone)
│   ├── emailService.js        # Resend email (templates, idempotent send, delivery log)
│   ├── emailQuota.js          # Monthly/daily send limits + atomic reservation
│   ├── onTaskWrite.js         # Assignment/status notifications; reminder materialization
│   ├── onCommentCreate.js     # @mention notifications
│   ├── onUserWrite.js         # New registration → admins; approval → user
│   ├── onFcmTokenWrite.js     # Privacy-safe push-device rollup on the user doc
│   ├── dispatchReminders.js   # Hourly reminder dispatcher + leadership digest
│   ├── weeklyTaskCheck.js     # Saturday 9 PM team check-in
│   ├── cleanupRetention.js    # Daily retention pruning
│   └── sendTestEmail.js       # Admin-only callable to verify the email pipeline
│
└── scripts/
    ├── seed.js                # Seed the emulator with demo users + tasks + notifications
    └── import-csv.js          # Import a CSV into Firestore
```

**Mental model for newcomers:**

- **Pages & components** → functions in `src/App.jsx` (`Home`, `MyDay`, `BoardList`, `Mine`, `Team`, `Admin`, `TaskDetail`, `TaskEditor`, …).
- **Navigation** → `src/nav.js` (pure) + `src/navHooks.js` (`useNav`).
- **Business logic** → `src/data.js` and `src/events.js` (no React, no Firebase — unit-testable).
- **Services** → `src/firebase.js` and `functions/`.

---

## Getting Started

### Prerequisites

- **Node 18+** and a **JDK** (the Firebase emulators require Java).
- `firebase-tools` is pinned to **v13** as a local dev dependency (v14+ needs Java 21). No global CLI install is required.

> [!NOTE]
> Tests use `jsdom@24`, which is CommonJS-clean on Node 20. `jsdom@25+` can fail under Node 20's test loader; bump it only after moving to Node 22+.

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
| `RESEND_MONTHLY_EMAIL_LIMIT` | Internal monthly email cap | `2800` |
| `RESEND_DAILY_SAFETY_LIMIT` | Daily runaway guard | `250` |

**3 — Google Cloud secret** (never in any `.env` or frontend code).

| Secret | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key, stored in **Google Cloud Secret Manager**, bound to functions via `secrets: [resendApiKey]`. Read server-side only; never logged. |

> [!WARNING]
> `.env` is gitignored. Never put real secrets in `VITE_*` variables — they ship to the browser. The Resend key lives **only** in Secret Manager.

### Running locally

Run the whole app against the **Firebase Emulator Suite** with seeded data. Production is never touched.

```bash
# Terminal A — emulators (Auth, Firestore, Functions, Pub/Sub, UI on :4000)
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

Re-run `npm run seed` anytime to reset. Scheduled functions don't fire on a timer in the emulator — invoke `dispatchReminders` manually to test reminder delivery.

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
| **Admin** | `role: "admin"` | Full control: tasks, approvals, imports, issues, settings. |
| **Contributor** | default | My Day shows what needs attention; My Work separates leading vs supporting. |
| **QA** | `qa: true` | A review queue with Approve / Request changes; only QA/admin can approve (enforced in rules). |
| **Caption / Upload** | `captions: true` | Work that begins after approval — captions, ready-to-post, overdue. |
| **Department Lead** | `lead: true` + `department` | Receives the leadership follow-up digest. |

### Auto-assignment

`autoAssign` filters eligible people (skill · location · availability) **first**, then balances by real, effort-weighted active workload across the whole board — so the genuinely lightest qualified person is chosen, not merely whoever appears on fewer rows. When picking a crew member manually, the editor shows that person's current load *before* you add them.

### Team Load & capacity

The Team Load screen measures the **effort of a person's current responsibilities**, not the number of rows their name appears on. Load is effort-weighted (e.g. editing counts more than coordination), phase-aware (a responsibility activates and clears automatically as the task moves), timeline-placed (this week / next week / later), and normalized to each person's availability into a coarse band (Available → Light → Balanced → Busy → High). The same engine powers auto-assignment and the assign-time hint.

### Notifications & reminders

An in-app **Notification Center** (bell, unread badge, mark-read, click-through) with per-user preferences. A server-side engine sends the right message to the person who owns the next action, across in-app / push / email channels. **Email is reserved for blocked, required, or escalation cases** so routine activity never fills inboxes. Each task carries a reminder schedule; a scheduled dispatcher delivers due reminders and a daily leadership digest. See [Architecture](#architecture).

### Recurring events

A real recurrence engine generates upcoming church events (e.g. Cross Over Service on the last day of the month, Praise & Testimony Night on the last Friday, a bi-monthly vigil) with no hardcoded dates. Admins create and edit their own recurring series in **Admin → Events**. Home cards show the next date, days remaining, and per-occurrence content status, with **Create content** / **View content** actions.

### Import with intelligent name matching

Bulk-create tasks from a CSV or the team's Google Sheet. Owners and crew without accounts import as **Pending**. The importer reconciles shortened, alternate, and misspelled names against real accounts (e.g. "Jon" → Jonathan Smith), auto-resolving only clear, unambiguous matches and asking an admin to confirm the rest. Confirmed mappings are remembered for next time.

> [!NOTE]
> Import is currently **hidden behind a build flag** (`ENABLE_CSV_IMPORT = false` in `App.jsx`). Flip it to expose the Import tab for a launch or bulk load.

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

**Primary collections:** `users` · `tasks` · `eventSeries` · `issues` · `notifications` · `reminderInstances` · `settings/notifications` · `emailDeliveries` · `systemUsage`. Server-owned collections (`reminderInstances`, `emailDeliveries`, `systemUsage`) are admin-read and never client-writable.

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

The project has no lint or type-check tooling (plain JSX). Tests run on Node's built-in test runner.

| Command | What it checks |
| --- | --- |
| `npm run build` | Frontend production build (Vite) |
| `node --test src/*.test.js` | **All frontend unit tests (124)** |
| `node --test functions/emailService.test.js` | Email normalize/validate + provider-error classification |
| `node --check functions/*.js` | Cloud Functions syntax (CommonJS, no build step) |

**Frontend suites** cover the recurrence engine, content Title-Case, task-UX helpers, the **capacity engine**, date validation, theme resolution, a stylesheet **contrast guard**, the pure **navigation mapping** (`nav.test.js`), and a **jsdom history-integration** suite (`nav.integration.test.js`) that drives the real router through push/back/forward, overlay-close-on-Back, legacy-link migration, and the unsaved-form blocker.

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
> **The notification backend has not been deployed yet** — it is verified only against the emulator. Work through the checklist below before the first production deploy.

**Pre-deploy checklist:**

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

---

## Roadmap

### Completed

- System-driven 7-stage workflow with auto-archive on Posted
- Effort-weighted **workload & capacity engine** (v1.2) powering Team Load + auto-assignment
- Role-aware dashboards (Home, My Day, My Work, Team, Admin)
- Recurring-event engine + admin-managed event series
- Intelligent name matching for imports
- In-app Notification Center + preferences
- Notification/reminder **backend** and Resend **email** (built + emulator-verified; _deploy pending_)
- **Mobile-first design system** (glass nav/header, single-scroll shell, dark mode)
- **URL-driven navigation** with Android back-button support (built on a feature branch; _merge + deploy pending_)
- Offline persistence, logging/error capture, "What's New" + feature requests

### In Progress

- Deploying the notification backend and web push to production (verify on the live site)
- Merging and deploying the URL-driven navigation refactor

### Planned

- **Department-lead dashboards** and a dedicated **Events calendar** page
- **Preferred names / nicknames** on the profile (the import-side matcher is the first half)
- **Capacity engine v2** — content-complexity multiplier, time-span responsibilities, tunable/versioned weights, stage-level cycle-time insight (never ranking individuals)
- **Passwordless auth** (magic link / email code / passkeys) to ease volunteer onboarding
- **Content-performance analytics** (Instagram / Facebook / YouTube) and calendar/Drive integrations
- **PWA & performance** — route-level code-splitting, richer offline support
- Bulk admin actions; recurring content templates; AI caption suggestions

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

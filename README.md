# StudioBoard

A content operating system for the **IFC (Immanuel Fellowship Church) social media team** — replacing a Google Sheet + WhatsApp workflow with a focused web app for planning, producing, reviewing, and posting content.

> **For contributors:** what do I need to do?
> **For leads:** what needs attention?
> **For admins:** how is the team doing?
> **For the team:** what have we accomplished?

---

## Project Overview

**What it is.** StudioBoard tracks each piece of content (a reel, poster/graphic, or photo set) from idea → production → QA → approval → posting, with ownership, content links, approvals, and a celebration/visibility layer on top.

**The problem it solves.** The team previously ran on a shared Google Sheet plus a WhatsApp group. That meant:
- People didn't know what they were responsible for or what to do next.
- Content links (Drive files) were scattered across chat.
- Approvals happened informally and were easy to lose.
- Leaders couldn't see what needed attention; deadlines slipped.

**Target users.** A mostly-volunteer church creative team — contributors (shoot/edit/design/coordinate), QA reviewers, a captions/upload crew, department leads, and admins — working **primarily from their phones**. The experience is intentionally encouraging, not a heavyweight project tool.

> The app's data model and workflow are modeled on the team's existing Google
> Sheet (Content Title, Owner, Support Team, Status, QA Status, dates, links).
> The reference screenshot is kept out of this public repo to avoid exposing
> team members' names and links.

---

## Goals

- **Eliminate the WhatsApp workflow** — content links and discussion live on the task.
- **Improve ownership** — every task has a clear owner and support crew.
- **Centralize approvals** — a real QA step with approval history.
- **Improve accountability** — an activity timeline on every task.
- **Encourage the team** — a Home dashboard that celebrates progress.

---

## Tech Stack

| Layer | Choice |
| --- | --- |
| **Frontend** | React 18 + Vite (JSX, no TypeScript) |
| **Styling** | Plain CSS with CSS custom properties (light/dark theming) |
| **Backend** | None — serverless; the client talks directly to Firebase |
| **Authentication** | Firebase Auth (Email/Password + Google) |
| **Database** | Cloud Firestore (real-time listeners) |
| **Security** | Firestore Security Rules (`firestore.rules`) |
| **Hosting** | Firebase Hosting |
| **State management** | React hooks + Firestore real-time subscriptions (no Redux/Zustand) |
| **Tooling** | `firebase-tools` (emulators + deploy), `firebase-admin` (seed/import scripts) |

There is no custom server. Authorization and data integrity are enforced **server-side by Firestore rules**, not the client.

---

## Architecture

**Single-page app, real-time data.** React renders the UI; Firestore `onSnapshot` listeners stream live data so every connected client stays in sync. Writes go straight to Firestore and are gated by security rules.

**Data flow:**
```
Firebase Auth ──▶ user profile (users/{uid})
                      │
        gating ladder in App():
        loading → signed-out → no profile → pending approval → Board
                      │
   Board subscribes to:  users · tasks · issues  (useCollection)
                      │
   UI writes (status, links, approvals, …) ──▶ Firestore ──▶ rules ──▶ live update to all clients
```

**Routing.** There is no router. The app is one authenticated shell (`Board`) with a `tab` state switching between pages: **Home, My Day, Board, My Work, Team, Admin**. The current tab is also tracked in `logging.js` so it can be attached to error/issue reports.

**Real-time hooks** (defined in `App.jsx`):
- `useAuthUser()` — the current Firebase Auth user.
- `useProfile(uid)` — live subscription to the signed-in user's `users/{uid}` doc.
- `useCollection(path, canRead)` — live subscription to a whole collection, gated so it doesn't query before the user is allowed.

### Data models

**`users/{uid}`**
```
name, email
role: "member" | "admin"
status: "pending" | "approved"
qa: boolean          // QA reviewer            (admin-set; locked at sign-up)
captions: boolean    // captions / upload team (admin-set; locked at sign-up)
lead: boolean        // department lead        (admin-set; locked at sign-up)
department: "Graphic Design" | "Content Creation" | "Videography"
           | "Photography" | "Caption & Upload" | "QA" | ""   // admin-set
skills: ["shoot" | "edit" | "coordinate" | "design" | "shadow"]
location: ["479" | "828"]
deprioritize, limited, manualSchedule: boolean   // auto-assign tuning
createdAt
```

**`tasks/{id}`**
```
title, type ("Reel" | "Poster" | "Photography"), location ("479" | "828" | "Both")
owner            // a registered user's name, or "Pending" (imported)
ownerSuggested   // original sheet name when owner is Pending
support: [{ name, role, loc?, suggested? }]   // suggested = sheet name for a Pending slot
status: "Planned" | "In Progress" | "In Review" | "Changes Requested"
      | "Approved" | "Ready to Post" | "Posted"          // 7-stage workflow
priority: "Low" | "Medium" | "High"
blockedOn                                // "waiting on …" (the next step is system-derived)
brief, notes, relatedEvent, link
shootDate, postDate                      // ISO yyyy-mm-dd
links: { ig, landscape, video, photos }  // content deliverables, required before QA
caption                                  // set by captions/upload team after approval
postLink                                 // the published-post URL, at Ready to Post / Posted
comments: [{ who, txt, tm }]
reactions: { "👍": [names], … }
activity: [{ type, by, at, note }]       // timeline + approval history
createdAt, updatedAt
```

The **7 statuses** group into four phases for the progress bar — Planning (Planned), Creating (In Progress, Changes Requested), Review (In Review, Approved), Posting (Ready to Post, Posted) — and the **next action is system-driven** (`workflowAction` / `nextStep` in `data.js`), so contributors never pick the next step manually.

**`issues/{id}`** — bug/crash/feedback reports and auto-captured runtime errors (see [Logging & Monitoring](#logging--monitoring)).

---

## User Roles

Roles are flags/fields on the `users` doc; a person can hold more than one. Dashboards adapt to the role.

| Role | How it's set | Experience |
| --- | --- | --- |
| **Admin** | `role: "admin"` | Full control: create/edit/delete tasks, approve people, import, issues, everything. |
| **Contributor** | default (`role: "member"`) | My Day = "needs your attention"; My Work = leading vs supporting. |
| **QA** | `qa: true` | My Day shows the review queue (awaiting approval / returned / recently approved); can **Approve** or **Request changes**. Only QA/admin can move a task to *Approved* (enforced in rules). |
| **Caption / Upload** | `captions: true` | My Day shows approved-needs-captions / ready-to-post / overdue posts. Their work starts after approval. |
| **Department Lead** | `lead: true` + `department` | Assignable today (set in **Admin → People**; people are grouped by department on the roster). Per-department **dashboards** are still planned. |

---

## MVP Features

**Built today:**
- **Task management** — owner + support crew, priority, dates, brief, statuses (Planned → Posted), comments, reactions; an auto-assign helper that mirrors the team's crewing rules.
- **QA workflow** — QA role, Approve / Request changes (bounces back with a note), approval history.
- **Content links** — typed Drive links (IG + landscape for graphics, video for reels, folder for photography); **required before a task can be sent to QA**.
- **Activity timeline** — created / status changes / QA / approvals / comments, newest first.
- **Role-based dashboards** — Home (celebration), My Day (operational, role-aware), My Work, Team load.
- **Wins & metrics** — personal + team wins, avg approval time, most active contributors (folded into Home).
- **Upcoming events** — pastor birthdays + Mother's/Father's Day on Home, with content-prep lead times.
- **Global search & archive** — search every task across all statuses; posted/completed work moves to an Archive view.
- **CSV / Google Sheet import** with **intelligent name matching** — bulk-create tasks; unknown owners/crew import as **Pending**, and the importer reconciles shortened/alternate sheet names against real accounts (see [Intelligent Name Matching](#intelligent-name-matching-import-reconciliation)).
- **Issue reporting & error tracking** — see [Logging & Monitoring](#logging--monitoring).
- **Dark mode** — system preference + manual toggle, remembered.

**Planned (not yet built):**
- **Notifications** — in-app center for assignments, QA requests, approvals, overdue, mentions.
- **Department-lead dashboards** and a full **Events calendar** page (creating/editing events; today they're hardcoded in `events.js`).
- **Preferred names / nicknames** — store a legal name + a preferred name (e.g. "Oghenekome Egbedi" → display **"Kome"**) and show the preferred name everywhere; global search matches all forms. _(The import-side matching below already exists; this is the in-app display half.)_
- **Workload-aware crew suggestions** in the manual picker — rank people by skill match **and** current active-assignment count, steering work away from overloaded volunteers (`autoAssign`/`computeCapacity`/`userActiveTasks` already model this).
- **Self-service profiles** — let users edit their own name/nickname/email/avatar and trigger a password reset (needs a scoped rules change; members currently can't self-edit).
- **Simpler auth** — evaluate passwordless sign-in (magic link → email code → passkeys / Face ID / Touch ID) to cut password friction for volunteers.
- **Published-content performance** — pull IG/Facebook/YouTube stats into a Home "This week's performance" section (external integrations).
- **Bulk actions** on Admin → Content (multi-select archive/delete/assign).

---

## Intelligent Name Matching (import reconciliation)

Church volunteers sign up with their full name (e.g. *Oghenekome Egbedi*) but the Google Sheet refers to them by a short/alternate name (*Kome*). On import, StudioBoard tries to recognize that these refer to the same account, so tasks land on real people instead of staying "Pending."

**How it scores a match** (`matchUserScored` in `src/data.js` → `{ user, confidence, reason }`):

| Signal | Confidence | Example |
| --- | --- | --- |
| Remembered mapping (admin-confirmed before) | 100% | "Kome" once you've confirmed it |
| Exact full name | 100% | "Oghenekome Egbedi" |
| Email / email handle | 92–98% | `tofunmi@…` → Oluwatofunmi |
| Exact first name | 90% | "David" → David Okafor |
| Contained / partial token | ~65–88% | **"Kome" ⊂ Oghenekome**, **"Dola" ⊂ Dolabomi** |
| Initials | 78% | **"OE"** → Oghenekome Egbedi |

**Auto vs. confirm.** Strong matches (**≥ 90%** — exact, remembered, email, exact first name) resolve **automatically** during import. Fuzzy guesses (partial / initials) deliberately stay **Pending** so they're never silently mis-assigned.

**The "Match names" step.** Above the import preview, any fuzzy guesses appear for review:
```
“Kome” → Oghenekome Egbedi
71% match · partial name        [Assign] [Ignore]
```
- **Assign** resolves that name across all rows **and remembers it** — stored in `localStorage` under `sb-name-mappings` as `{ matchKey(name): userName }`.
- **Ignore** leaves the entry Pending.

**Remembered for next time.** Once confirmed, future imports containing that name auto-assign (the remembered mapping scores 100%). The preview re-derives live as confirmations are made (`reconcileNames` collects the still-pending names + best guesses; `rowToTask`/`parseSupport` accept the `mappings` map).

> **Current scope.** This is purely an **import reconciliation** system — it helps the app understand that different spellings of a name may be the same account. It is _not_ yet a stored preferred-name/nickname on the user profile (that's a planned feature above). Confirmed mappings live per-browser in `localStorage`, not in Firestore.

---

## Future Roadmap

- In-app **notifications** + (later) push notifications.
- **Department-lead** dashboards and a dedicated **Events** page (with event creation).
- **Preferred names / nicknames** stored on the profile (the import-side matcher is the first half).
- **Passwordless auth** (magic link / email code / passkeys) to ease volunteer onboarding.
- **Analytics / content performance** tracking (IG / Facebook / YouTube).
- **Integrations** — Google Drive, calendar sync.
- Continued **mobile** refinement; recurring content templates; AI caption suggestions.

---

## Logging & Monitoring

All monitoring data lives in the Firestore **`issues`** collection.

- **Automatic capture** — uncaught errors, unhandled promise rejections, and React render crashes are logged via `src/logging.js` + an `ErrorBoundary`, with full context: user id/email, route, action, message, stack, browser/device, viewport.
- **Manual reports** — any signed-in user can file a bug/crash/feedback note via **"Report an issue"** (sidebar, or the ⚠︎ button on mobile); the same context is attached automatically.
- **Admin review** — **Admin → Issues**: filter by Reports/Errors and Open/Resolved, expand the stack trace, mark resolved/reopen.
- **Security** — clients may only *create* issues under their own uid; only admins can read, triage, or delete (enforced in `firestore.rules`).

---

## Folder Structure

This is a small, deliberately flat codebase. Most "components" are functions inside `App.jsx`; shared logic is split into focused modules.

```
.
├── index.html                # Vite entry; viewport + theme-color meta
├── vite.config.js            # Vite + React plugin
├── firebase.json             # Hosting + Firestore rules + emulator config
├── .firebaserc               # Default Firebase project
├── firestore.rules           # Server-side authorization (source of truth)
├── sample-tasks.csv          # Import template
├── production-tasks.csv       # Snapshot of the live sheet for launch import
├── scripts/
│   ├── seed.js               # Seed the emulator (firebase-admin): users + tasks
│   └── import-csv.js         # Import a CSV file into Firestore (emulator/prod)
└── src/
    ├── main.jsx              # Bootstraps React; initTheme() + initErrorCapture()
    ├── App.jsx               # The app: all pages/components + the real-time hooks
    ├── firebase.js           # Firebase init + emulator wiring (the "service" layer)
    ├── data.js               # Pure logic & helpers (no React, no Firebase) — easy to test
    ├── events.js             # Ministry events (birthdays/holidays) + upcoming feed
    ├── logging.js            # Error capture, issue reporting, route tracking
    ├── theme.js              # Light/dark theme (system pref + persistence)
    └── styles.css            # All styles + the light/dark CSS variables
```

Conceptual mapping for newcomers:
- **Pages / components** → functions in `src/App.jsx` (`Home`, `MyDay`, `BoardList`, `Mine`, `Team`, `Admin`, `TaskDetail`, `TaskEditor`, `UserEditor`, `ImportPanel`, `IssueLog`, …).
- **Hooks** → `useAuthUser` / `useProfile` / `useCollection` in `App.jsx`.
- **Services** → `src/firebase.js` (Auth + Firestore); scripts under `scripts/`.
- **Utilities** → `src/data.js` (statuses, auto-assign, capacity, search, wins/metrics, CSV parsing, **intelligent name matching** — `matchUserScored` / `matchUser` / `reconcileNames`), `src/events.js`, `src/theme.js`, `src/logging.js`.

`src/data.js` is intentionally free of React and Firebase so its logic can be unit-tested or reused — most verification in development was done by importing it directly under Node.

---

## Setup Guide

### Prerequisites
- **Node 18+** and a **JDK** (the Firebase emulators need Java). `firebase-tools` is pinned to **v13** as a local dev dependency (v14+ requires Java 21); an npm `override` forces a CommonJS `uuid` so it runs on Node 20. No global CLI needed.

### Installation
```bash
npm install   # installs app deps + firebase-tools + firebase-admin
```

### Environment variables
Copy `.env.example` → `.env` and fill in the Firebase **web** config (these values are public by design — security is enforced by Auth + rules):
```
VITE_FIREBASE_API_KEY=…
VITE_FIREBASE_AUTH_DOMAIN=…
VITE_FIREBASE_PROJECT_ID=…
VITE_FIREBASE_STORAGE_BUCKET=…
VITE_FIREBASE_MESSAGING_SENDER_ID=…
VITE_FIREBASE_APP_ID=…
VITE_USE_EMULATOR=false        # true (or inline) to use the local emulator
```
`.env` is gitignored. Don't put real secrets in `VITE_*` vars — they ship to the browser.

### Local development (with the Firebase Emulator)
Run the whole app against the **Emulator Suite** with seeded fake data — production is never touched.

```bash
# Terminal A — emulators (Auth :9099, Firestore :8080, UI http://127.0.0.1:4000)
npm run emulators

# Terminal B — seed ~8 users + ~17 tasks, then run the app against the emulator
npm run seed
VITE_USE_EMULATOR=true npm run dev      # http://localhost:5173
```

Seeded logins (shared password `password123`):

| Login | Role |
| --- | --- |
| `grace@ifc.app` | Admin |
| `david@ifc.app` | Member · **QA** |
| `mike@ifc.app`  | Member · **Captions/Upload** |
| `joy@ifc.app`   | Pending (approval screen) |

Re-run `npm run seed` anytime to reset. If emulator ports get stuck: `pkill -9 -f firebase` and free 4000/4400/4500/8080/9099.

### Deployment (production)
> Pushes to the real Firebase project — review first.

One-time, in the [Firebase console](https://console.firebase.google.com/):
1. **Authentication → Sign-in method:** enable **Email/Password** and **Google**.
2. **Firestore Database:** create it (production mode).

Then:
```bash
npx firebase login    # one-time, interactive
npm run deploy        # builds, deploys Hosting + Firestore rules
```
Publishes to `https://<project-id>.web.app`.

**Bootstrap the first admin** (rules require this once): the first person registers in the app, then in the Firestore console set their `users/{uid}` doc to `role: "admin"`, `status: "approved"`. After that, approvals happen in-app via **Admin → People**.

**Launch with real content:** as the admin, **Admin → Import** → upload [`production-tasks.csv`](production-tasks.csv) (or paste the link-shared Google Sheet). Owners/crew without accounts import as **Pending** and are suggested to matching users when they sign up.

---

## Contributing Guide

1. **Branch** off `main` (`feature/…` or `fix/…`).
2. **Develop** against the emulator (`npm run emulators` + `VITE_USE_EMULATOR=true npm run dev`); never test against production data.
3. **Keep the split:** put pure logic in `src/data.js` (no React/Firebase) and verify it under Node; UI in `App.jsx`. Match the surrounding code style.
4. **Security changes** go in `firestore.rules` — and authorization must be enforced there, not just in the UI. The emulator hot-reloads the rules; test allow/deny paths.
5. **Verify** before opening a PR: `npm run build` is clean, and you've exercised the change in the running app.
6. **Open a PR** and request a review before merging.

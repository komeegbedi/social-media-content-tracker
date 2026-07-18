# IFC Creatives Board

**Plan. Create. Review. Publish.** The digital home of the **IFC (Immanuel Fellowship Church) Creative Team** — a content operating system replacing a Google Sheet + WhatsApp workflow with a focused web app for planning, producing, reviewing, and posting content.

> _Internal note: powered by StudioBoard architecture._

> **For contributors:** what do I need to do?
> **For leads:** what needs attention?
> **For admins:** how is the team doing?
> **For the team:** what have we accomplished?

---

## Project Overview

**What it is.** IFC Creatives Board tracks each piece of content (a reel, poster/graphic, or photo set) from idea → production → QA → approval → posting, with ownership, content links, approvals, and a celebration/visibility layer on top.

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
| **Backend** | Firebase Cloud Functions (2nd gen, Node 20) — a thin notification/reminder layer (`functions/`); the client still talks directly to Firestore for everything else |
| **Authentication** | Firebase Auth (Email/Password + Google) |
| **Database** | Cloud Firestore (real-time listeners) |
| **Messaging** | Firebase Cloud Messaging (web push) + **Resend** transactional email (called from Cloud Functions) |
| **Security** | Firestore Security Rules (`firestore.rules`) |
| **Hosting** | Firebase Hosting |
| **State management** | React hooks + Firestore real-time subscriptions (no Redux/Zustand) |
| **Tooling** | `firebase-tools` (emulators + deploy), `firebase-admin` (seed/import scripts), `luxon` (timezone math in functions) |

The client owns the UI and all interactive writes; authorization and data integrity are enforced **server-side by Firestore rules**. The only server-side code is the **notification backend** — it reacts to Firestore changes and runs a scheduled reminder dispatcher, so the app stays proactive even when no one has it open. See [Notifications & Reminders](#notifications--reminders-v11).

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
notifPrefs: { push, email, perType: { assigned, reminder, … } }   // self-editable
createdAt
```
Subcollection **`users/{uid}/fcmTokens/{token}`** — `{ token, ua, createdAt, lastSeen }` — web-push device tokens (one per device; a user manages only their own).

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
relatedEventSeriesId, relatedEventOccurrenceId, relatedEventDate  // links to ONE event occurrence
shootDate, postDate                      // ISO yyyy-mm-dd  (postDate = the due date)
reminders: [{ id, offset, when: "before"|"after", channels[], recipients[], enabled }]  // max 10
links: { ig, landscape, video, photos }  // content deliverables, required before QA
caption                                  // set by captions/upload team after approval
postLink                                 // the published-post URL, at Ready to Post / Posted
comments: [{ who, txt, tm }]             // legacy inline array (see comments subcollection below)
reactions: { "👍": [names], … }
activity: [{ type, by, at, note }]       // timeline + approval history
createdAt, updatedAt
```
Subcollection **`tasks/{id}/comments/{commentId}`** — `{ who, uid, txt, tm, mentions: [uid] }` — v1.1 comments live here so the server can reliably fire `@mention` notifications; the inline `comments[]` array remains for the existing timeline (migration is tracked).

**Notification collections (v1.1, written server-side):**

**`notifications/{id}`** — one in-app notification. `{ uid, type, title, body, taskId?, eventOccurrenceId?, read, channels, dedupeKey, createdAt }`. Deterministic id per (event, recipient) → idempotent. A user reads/marks-read only their own; clients can't create them.

**`reminderInstances/{id}`** — the materialized reminder queue drained by the scheduler. `{ taskId, reminderId, fireAt (UTC), recipients, channels, status: "pending"|"processing"|"processed"|"failed"|"skipped", leaseUntil, claimedBy, attempts, lastError, processedAt }`. Server-owned; admins may read for the delivery log.

**`settings/notifications`** — admin doc: `{ defaultReminders[], reminderHourLocal (9), leadershipAlertRoles }`.

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
| **Department Lead** | `lead: true` + `department` | Set in **Admin → People** (people are grouped by department on the roster). Receives the **leadership follow-up digest** (overdue / blocked / unassigned / pending approvals). Per-department **dashboards** are still planned. |

---

## MVP Features

**Built today:**
- **System-driven 7-stage workflow** — Planned → In Progress → In Review → Changes Requested → Approved → Ready to Post → Posted (grouped into 4 phases for the progress bar). The app derives the **next action / next owner** for each task; contributors never pick the next step manually.
- **Task management** — owner + support crew, priority, dates, creative brief, comments, reactions; an auto-assign helper that mirrors the team's crewing rules (skill + workload).
- **Flexible crew tasks** — Shooting / Editing / Getting People / Graphic Design / Shadowing, plus an **"Other"** type with a free-text custom label (e.g. Caption Writing, Voiceover, Lighting). Unknown roles from a CSV import keep their wording as *Other* instead of being mislabeled.
- **QA workflow** — QA role, Approve / Request changes (bounces back with a note), approval history.
- **Content links** — typed Drive links (IG + landscape for graphics, video for reels, folder for photography); **required before a task can be sent to QA**.
- **Activity timeline** — created / status changes / QA / approvals / comments, newest first.
- **Role-based dashboards** — Home (celebration), My Day (operational, role-aware), My Work (urgency-ordered), Team load.
- **Admin leadership dashboard** — quick actions, severity-coded health cards, "needs attention", "ready to move", and a cross-task **activity feed**.
- **Wins & metrics** — personal + team wins, avg approval time, most active contributors (folded into Home).
- **Recurring ministry events** — a real recurrence engine (`events.js`) generates the next occurrence of Cross Over Service (last day of month), Praise & Testimony Night (last Friday), the Bi-Monthly Mini Vigil (3rd Friday every other month), plus birthdays/holidays — no hardcoded monthly dates. Home cards show the next date, days remaining, and per-**occurrence** content status ("2 content pieces planned" vs "Content has not been planned yet") with **Create content** (pre-fills a task stamped with that occurrence) / **View content** actions.
- **Notifications** — an in-app **Notification Center** (bell + unread badge + panel, mark-read, click-through) with per-user **preferences** (push/email channels + per-type toggles), fed by a server-side notification engine (see [Notifications & Reminders](#notifications--reminders-v11)).
- **Global search & archive** — search every task across all statuses; posted/completed work moves to an Archive view.
- **CSV / Google Sheet import** with **intelligent name matching** — bulk-create tasks; unknown owners/crew import as **Pending**, and the importer reconciles shortened/alternate/ambiguous sheet names against real accounts (see [Intelligent Name Matching](#intelligent-name-matching-import-reconciliation)).
- **Issue reporting & error tracking** — see [Logging & Monitoring](#logging--monitoring).
- **Beta mode** — a dismissible in-app banner inviting bug/feedback reports during the test phase.
- **Mobile-first** — slim header + account drawer, role-aware nav, collapsible filters/sections, and safe-area handling so modals clear the iPhone Safari/Chrome URL bar.
- **Dark mode** — system preference + manual toggle, remembered.

**In progress (v1.1):**
- **Web push (FCM)** delivery — the in-app center, backend, and per-device token handling are built; enabling real push needs the Blaze plan + a VAPID key. iPhone/iPad push requires the app be added to the Home Screen first. **Email delivery via Resend is built and verified** (see [Email](#email-resend)).

**Planned (not yet built):**
- **Department-lead dashboards** and a full **Events calendar** page (creating/editing events; the recurrence rules currently live in `events.js`).
- **Preferred names / nicknames** — store a legal name + a preferred name (e.g. "Jonathan Smith" → display **"Jon"**) and show the preferred name everywhere; global search matches all forms. _(The import-side matching below already exists; this is the in-app display half.)_
- **Workload-aware crew suggestions** in the manual picker — rank people by skill match **and** current active-assignment count, steering work away from overloaded volunteers (`autoAssign`/`computeCapacity`/`userActiveTasks` already model this).
- **Self-service profiles** — let users edit their own name/nickname/email/avatar and trigger a password reset (needs a scoped rules change; members currently can't self-edit).
- **Simpler auth** — evaluate passwordless sign-in (magic link → email code → passkeys / Face ID / Touch ID) to cut password friction for volunteers.
- **Published-content performance** — pull IG/Facebook/YouTube stats into a Home "This week's performance" section (external integrations).
- **Bulk actions** on Admin → Content (multi-select archive/delete/assign).

---

## Intelligent Name Matching (import reconciliation)

Church volunteers sign up with their full name (e.g. *Jonathan Smith*) but the Google Sheet refers to them by a short/alternate name (*Jon*). On import, IFC Creatives Board tries to recognize that these refer to the same account, so tasks land on real people instead of staying "Pending."

**How it scores a match.** `matchCandidates(name, users, mappings)` in `src/data.js` scores **every** plausible user `0–1` with a reason, best first (collecting *all* candidates is what makes ambiguity detectable). It combines exact/email signals with genuine fuzzy matching (`nameSim`, backed by Levenshtein `editDistance`):

| Signal | Confidence | Example |
| --- | --- | --- |
| Remembered mapping (admin-confirmed before) | 100% | "Jon" once you've confirmed it |
| Exact full name | 100% | "Jonathan Smith" |
| Email / email handle | 92–98% | `jordan@…` → Jordan Lee |
| Exact first name | 90% | "Alex" → Alex Johnson |
| Contained name | ~65–84% | **"Sam" ⊂ Samuel** |
| Shared prefix | ~72–88% | **"Dan" → Daniel**, **"Dola" → Dolapo** |
| Shortened name w/ spelling drift | ~65–75% | **"Anji" → Anjolaoluwa** (shares "anj", drifts i↔o) |
| Typo / similar spelling | ~70–80% | **"Ester" → Esther** |
| Initials | 78% | **"JS"** → Jonathan Smith |

**Confidence tiers** (`matchTier`): **high ≥ 80%**, **medium ≥ 60%**, **low < 60%** (not suggested). The "Match names" step phrases them as *"Possible match: …"* (high) or *"Maybe this is …?"* (medium).

**Auto vs. confirm.** A name auto-resolves **only when there is a single, clearly-best match ≥ 90%** (exact / remembered / email / exact first name). Everything fuzzier, *and anything ambiguous*, stays **Pending** so a person is never silently mis-assigned.

**Ambiguity guard.** If two candidates are within `0.1` of each other (e.g. **"Esther"** when both *Esther Orizu* and *Esther Tunde* exist), `isAmbiguous()` flags it and refuses to auto-pick. The Match-names step shows a warning and asks the admin to choose:
```
⚠ Multiple people may match “Esther” — please choose the correct person:
[ Esther Orizu ]  [ Esther Tunde ]  [ Skip ]
```

**The "Match names" step.** Above the import preview, fuzzy/ambiguous guesses appear for review:
```
“Jon” → Possible match: Jonathan Smith
71% · shared prefix              [Assign] [Ignore]
```
- **Assign** (or picking a person in the ambiguous case) resolves that name across all rows **and remembers it** — stored in `localStorage` under `sb-name-mappings` as `{ matchKey(name): userName }`.
- **Ignore / Skip** leaves the entry Pending.

**Remembered for next time.** Once confirmed, future imports containing that name auto-assign (the remembered mapping scores 100%). The preview re-derives live as confirmations are made (`reconcileNames` returns `{ name, candidates, ambiguous }` per pending name; `rowToTask`/`parseSupport` accept the `mappings` map).

> **Current scope.** This is purely an **import reconciliation** system — it helps the app understand that different spellings of a name may be the same account. It is _not_ yet a stored preferred-name/nickname on the user profile (that's a planned feature above). Confirmed mappings live per-browser in `localStorage`, not in Firestore.

---

## Notifications & Reminders (v1.1)

To make the app **proactive** — telling the team what's due, who needs to act, and what leaders should follow up on, even when no one has it open — v1.1 adds a thin **Cloud Functions** backend (`functions/`, 2nd gen, Node 20, region `northamerica-northeast1`). It never replaces the Firebase architecture; it only reacts to Firestore and dispatches notifications.

**Architecture — one dispatcher, event triggers, Firestore as the ledger:**
```
 Client actions ─┐                        ┌─ in-app  (notifications/{id})
 (assign, QA,    │  Firestore triggers    │
  approve, …)    ├─▶ onTaskWrite /  ──────▶├─ web push (FCM)   ← v1.1 in progress
                 │   onUserWrite /         │
 Task due dates ─┘   onCommentCreate       └─ email (Trigger Email ext.) ← v1.1 in progress
                     (immediate notifs +
                      materialize reminders)
                                 ▲
 Hourly onSchedule dispatcher ───┘  claims due reminderInstances (atomic lease),
   fans out per channel, records outcomes, retries, emits leadership digest.
```

**Immediate (event-driven) notifications** — `onTaskWrite`: assignment (owner + crew), and status transitions → **In Review** (QA + admins), **Changes Requested** (owner), **Approved** (owner + caption team), **Ready to Post** (posting team). `onCommentCreate`: **@mentions**. `onUserWrite`: new registration → admins, and approval → the user (account/security messages bypass preferences).

**Reminders** — each task carries a **reminder schedule** (offset · before/after the due date · channels · recipients · enabled; **max 10**, defaulting from `settings/notifications`). When a task's due date or schedule changes, `onTaskWrite` **materializes** `reminderInstances` (fire time = **9:00 AM America/Winnipeg** on the due date ± offset, stored **UTC**), skipping past times and cancelling on Posted/archive.

**The dispatcher** (`dispatchReminders`, hourly) queries due instances, **atomically claims** each in a transaction (`pending → processing` + `leaseUntil`) so two overlapping runs can't double-send, resolves recipients **at send time** (honoring removed crew), writes idempotent notifications per channel, records the outcome, and retries transient failures. Once a day at the local morning hour it emits a **leadership follow-up digest** (overdue / blocked / no-owner / no-crew / awaiting review / pending registrations) to admins and department leads.

**Delivery & preferences** — in-app is always on; **push** and **email** are per-user opt-in (**Notification Center → ⚙**), stored in `users/{uid}.notifPrefs` (a scoped rule lets members edit only that field). Idempotency comes from deterministic notification ids; timezone-correct scheduling uses `luxon`.

> **Cost & reliability:** a **single** scheduled dispatcher (no per-task scheduler jobs), `minInstances: 0` (no idle cost), capped `maxInstances`, atomic leasing + idempotency keys, and structured logs. Deploying the functions requires the **Blaze** plan; set a **GCP billing alert**.

### Email (Resend)

Transactional email is sent with [**Resend**](https://resend.com) directly from Cloud Functions — `Cloud Function → Resend API → recipient`. No SMTP, SendGrid, Trigger Email extension, or `mail` collection.

- **Module:** [`functions/emailService.js`](functions/emailService.js) — branded HTML templates (subject, greeting with the recipient's first name, what changed, a CTA button deep-linking to the task/event, a plain-text fallback, and a "why you received this" note), preference checks, idempotent sending, and error classification.
- **Sender:** `IFC Creatives Board <notifications@ifcwpg.com>` (constant in `emailService.js`). The **sending domain must be verified in Resend**.
- **Reply-to:** configurable via the `IFC_REPLY_TO` function env var; **unset by default** (no address is invented) → no Reply-To header until a monitored IFC inbox is set.
- **API key:** read from **Google Cloud Secret Manager** secret **`RESEND_API_KEY`**, bound to each sending function via `secrets: [resendApiKey]` (`defineSecret` from `firebase-functions/params`). It is never exposed to the frontend, env files, or Firestore, and is never logged.
- **Email types:** account-awaiting-approval, account-approved, assigned/reassigned, QA requested, changes requested, approved, ready to post, due-date & overdue reminders, event reminders, and mentions — all reusing the same event system as in-app/push (no duplicate logic).
- **Preferences:** an email goes out only if the user is active, has a valid email, has `notifPrefs.email !== false`, and hasn't disabled that notification type (`notifPrefs.perType.<type>`). Existing users without prefs get sensible defaults (everything on). Reminders are never sent for Posted/archived tasks.
- **Duplicate prevention:** a deterministic `notificationId` is used as both the `emailDeliveries/{id}` doc id and the **Resend idempotency key**. Before sending, the record is **atomically claimed** in a transaction (`pending → processing → sent`) with a processing lease, so a retried trigger, a re-run schedule, overlapping instances, or a post-accept timeout can't send twice.
- **Delivery log — `emailDeliveries/{notificationId}`:** `{ notificationId, userId, recipientEmail, notificationType, taskId, eventId, provider: "resend", providerMessageId, idempotencyKey, status, attemptCount, createdAt, sentAt, failedAt, errorCode, errorMessage }`. Server-written; admin-readable (rule).
- **Errors & retries:** temporary failures (network, 429, 5xx) are retryable (record left recoverable); permanent failures (invalid recipient, other 4xx) are marked `failed` and not retried. Secrets/keys/tokens are never logged.
- **Local emulator:** the automatic (trigger-driven) flow **skips real Resend calls** in the Functions emulator (`FUNCTIONS_EMULATOR`), so seeding/dev never spends quota; the **admin test** callable still sends for real.
- **Test email:** an admin-only callable `sendTestEmail({ to })` (requires an authenticated admin + a valid recipient) sends *"Your IFC Creatives Board email notification system is working correctly."* and returns the Resend message id. Trigger it from **Notification settings → Admin · test email** (admins only). It never allows arbitrary public sending.

**Deploy (email/functions)** — the secret already exists in Secret Manager, so **do not** run `firebase functions:secrets:set RESEND_API_KEY`:
```bash
firebase deploy --only functions
```

**Key rotation:** create a new key in Resend → `firebase functions:secrets:set RESEND_API_KEY` (adds a new secret version) → `firebase deploy --only functions` to pick it up → revoke the old key in Resend.

**Troubleshooting:** _"RESEND_API_KEY is not configured"_ → the secret isn't bound/available on the deployed function (re-check `secrets: [resendApiKey]` + deploy). _"Invalid `to` field … use our testing address"_ → Resend rejects `example.com`; use a real address or `delivered@resend.dev`. _Domain not verified_ → verify `ifcwpg.com` in Resend. Delivery outcomes are in the `emailDeliveries` collection and the function logs (`firebase functions:log`).

#### Monthly usage safeguards

The Resend plan allows **3,000 emails/month**; the app caps *itself* well below that so tests, dashboard sends, retries and drift can't overrun the account. All limits are **trusted server-side configuration** — changing them requires a redeploy, and there is deliberately **no "send anyway" bypass** in the UI.

- **Limits** ([`functions/emailQuota.js`](functions/emailQuota.js), overridable via function env): `RESEND_MONTHLY_EMAIL_LIMIT = 2800` (200-email buffer under 3,000) and `RESEND_DAILY_SAFETY_LIMIT = 250` (runaway guard).
- **Usage records** (server-managed, admin-read only): `systemUsage/email-{YYYY-MM}` (monthly) and `systemUsage/emailDaily-{YYYY-MM-DD}` (daily). Period = **UTC calendar month/day** (one canonical definition). `{ provider, period, monthlyLimit, reservedCount, sentCount, failedCount, suppressedCount, alertedThresholds, lastUpdatedAt }`.
- **Atomic reservation:** before every send, one email is reserved inside a **Firestore transaction** that checks `sentCount + reservedCount < limit` — so concurrent function instances can't oversend (verified: 20 parallel reservations against a limit of 5 yield exactly 5). On accept → `reserved−−, sent++`; permanent failure → `reserved−−, failed++`; temporary failure → `reserved−−` (retryable); **uncertain outcome (timeout)** → left `unknown` and reconciled later (never blind-resent — the idempotency key would dedupe anyway).
- **Priority-based shedding:** emails are `critical` / `standard` / `low`. At **85%** low-priority emails are suppressed; at **95%** only critical send; at **100%** external email is paused for the period. **In-app notifications always continue** regardless. Suppressed emails are marked `suppressed_quota_limit` and never retried in a loop.
- **Admin alerts (in-app, one per threshold per period):** at **70 / 85 / 95 / 100%** monthly and when the daily limit is hit. These are **in-app only** — we never rely on email to warn about email.
- **Reminder batching:** the dispatcher combines a user's due reminders into **one digest email** (counts as a single send); in-app/push still fire per task. Reminders stop for Posted/archived tasks.
- **Usage dashboard:** admins see live usage under **Notifications → settings** (sent / reserved / limit / remaining / % / today vs daily limit / failed / suppressed; status **Normal · Approaching limit · Critical · Paused**).
- **Caveat:** emails sent outside the app (e.g. straight from the Resend dashboard) aren't counted here — which is exactly why the internal cap sits below 3,000. This counter is the app's own estimate until direct provider-usage sync exists.

### Retention, per-task reminders & App Check

- **Per-task reminder schedules:** admins edit a task's reminders in the Task editor (days offset · before/after due · channels · recipients · on/off; **max 10**). New content inherits the **default schedule** from `settings/notifications` (editable under **Notifications → settings → default reminder schedule**, with the send hour). The backend uses `task.reminders`, falling back to the default.
- **Retention cleanup** (`functions/cleanupRetention.js`, daily 03:00 Winnipeg): terminal `reminderInstances` > 90d, **read** `notifications` > 180d, `emailDeliveries` (sent/suppressed > 90d, else > 180d), `fcmTokens` not seen in 180d, and `systemUsage/emailDaily-*` > 90d (monthly usage kept). Bounded batches.
- **App Check (optional hardening):** set `VITE_FIREBASE_APPCHECK_KEY` (a reCAPTCHA v3 site key registered under Firebase Console → App Check) to enable it; it's a **no-op when unset and skipped against the emulator**, so local dev is unaffected. Enforce it per-service (Firestore, Functions) from the console once the key is live.

---

## Future Roadmap

- Finish **push + email** delivery for notifications (in-app center + backend are done); notification retention cleanup + App Check.
- **Department-lead** dashboards and a dedicated **Events** page (moving the recurrence rules into Firestore + event content templates).
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
├── firebase.json             # Hosting + Firestore rules/indexes + Functions + emulator config
├── .firebaserc               # Default Firebase project
├── firestore.rules           # Server-side authorization (source of truth)
├── firestore.indexes.json    # Composite indexes (notifications, reminderInstances, tasks)
├── sample-tasks.csv          # Import template
├── production-tasks.csv       # Snapshot of the live sheet for launch import
├── functions/                # Cloud Functions — the notification/reminder backend
│   ├── index.js              # Entry: global options (region/maxInstances) + exports
│   ├── lib.js                # Shared helpers (idempotent writes, recipients, push, Winnipeg↔UTC)
│   ├── emailService.js       # Resend transactional email (templates, idempotent send, delivery log)
│   ├── emailQuota.js         # Monthly/daily send limits, atomic reservation, priority shedding
│   ├── onTaskWrite.js        # Assignment + status notifications; reminder materialization
│   ├── onCommentCreate.js    # @mention notifications
│   ├── onUserWrite.js        # Pending→admins, approval→user
│   ├── dispatchReminders.js  # Hourly dispatcher (atomic lease) + leadership digest
│   ├── cleanupRetention.js   # Daily retention pruning of notification collections
│   └── sendTestEmail.js      # Admin-only callable to verify the email pipeline
├── scripts/
│   ├── seed.js               # Seed the emulator (firebase-admin): users + tasks + demo notifications
│   └── import-csv.js         # Import a CSV file into Firestore (emulator/prod)
└── src/
    ├── main.jsx              # Bootstraps React; initTheme() + initErrorCapture()
    ├── App.jsx               # The app: all pages/components + the real-time hooks
    ├── firebase.js           # Firebase init + emulator wiring (the "service" layer)
    ├── data.js               # Pure logic & helpers (no React, no Firebase) — easy to test
    ├── events.js             # Recurrence engine + ministry events (birthdays/holidays/services)
    ├── events.test.js        # Node unit tests for the recurrence engine
    ├── notifications.js      # Notification Center hook + preference helpers
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
npm install                 # app deps + firebase-tools + firebase-admin
npm install --prefix functions   # Cloud Functions deps (firebase-functions, firebase-admin, luxon)
```

### Configuration & required secrets

Configuration lives in **three tiers** — keep them straight, and never mix a secret into frontend config:

**1. Public frontend config** — `.env` (gitignored; copy from `.env.example`). All `VITE_*` values **ship to the browser** and are public by design (security is enforced by Auth + rules), so they are *not* secrets:

| Variable | Purpose |
| --- | --- |
| `VITE_FIREBASE_API_KEY` … `VITE_FIREBASE_APP_ID` | Firebase **web** config (Console → Project settings → SDK setup) |
| `VITE_FIREBASE_VAPID_KEY` | FCM Web Push public key (Console → Cloud Messaging → Web Push certificates). Blank ⇒ push disabled |
| `VITE_FIREBASE_APPCHECK_KEY` | App Check reCAPTCHA v3 **site** key. Blank ⇒ App Check skipped |
| `VITE_USE_EMULATOR` | `true` routes Auth/Firestore/Functions to the local emulator |

**2. Server-only config** — `functions/.env` (auto-loaded by the Firebase CLI at deploy; non-secret, so it may be committed — but gitignore it if unsure). All have safe defaults, so this file is **optional**:

| Variable | Purpose | Default |
| --- | --- | --- |
| `IFC_REPLY_TO` | Monitored inbox for email Reply-To | *(unset → no Reply-To)* |
| `IFC_APP_URL` | Base URL used in email deep-links | `https://ifc-social-media-tracker.web.app` |
| `RESEND_MONTHLY_EMAIL_LIMIT` | Internal monthly email cap (below the 3,000 plan) | `2800` |
| `RESEND_DAILY_SAFETY_LIMIT` | Daily runaway guard | `250` |

The application timezone (`America/Winnipeg`) and sender (`IFC Creatives Board <notifications@ifcwpg.com>`) are **code constants** in `functions/`.

**3. Google Cloud secret** — **never** in any `.env` or frontend code:

| Secret | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key, stored in **Google Cloud Secret Manager**, bound to functions via `secrets: [resendApiKey]`. Read only in `functions/emailService.js`; never logged. |

> `.env` is gitignored. Don't put real secrets in `VITE_*` vars — they ship to the browser. The Resend key lives **only** in Secret Manager.

### Local development (with the Firebase Emulator)
Run the whole app against the **Emulator Suite** with seeded fake data — production is never touched.

```bash
# Terminal A — emulators (Auth :9099, Firestore :8080, Functions :5001, Pub/Sub :8085, UI :4000)
npm run emulators                       # includes Cloud Functions — notifications fire locally

# Terminal B — seed ~8 users + ~17 tasks + demo notifications, then run the app
npm run seed
VITE_USE_EMULATOR=true npm run dev      # http://localhost:5173
```

The Functions emulator runs the notification triggers locally (no Blaze needed to test). Scheduled functions don't auto-run on a timer in the emulator — invoke `dispatchReminders` manually (Emulator UI, or a small `firebase-admin` script) to test reminder delivery.

Seeded logins (shared password `password123`):

| Login | Role |
| --- | --- |
| `jane@example.com`  | Admin |
| `john@example.com`  | Member · **QA** |
| `sam@example.com`   | Member · **Captions/Upload** |
| `riley@example.com` | Pending (approval screen) |

Re-run `npm run seed` anytime to reset. If emulator ports get stuck: `pkill -9 -f firebase` and free 4000/4400/4500/8080/9099.

### Deployment (production)
> Pushes to the real Firebase project — review first.

One-time, in the [Firebase console](https://console.firebase.google.com/):
1. **Authentication → Sign-in method:** enable **Email/Password** and **Google**.
2. **Firestore Database:** create it (production mode).

Then:
```bash
npx firebase login    # one-time, interactive
npm run deploy        # builds, deploys Hosting + Firestore rules + indexes
```
Publishes to `https://<project-id>.web.app`.

**Deploying the notification backend (Cloud Functions)** requires the **Blaze** (pay-as-you-go) plan:
1. Upgrade the project to **Blaze** and set a **GCP budget/billing alert** (functions cost ~cents/month at this scale, but are non-zero).
2. For push: **enable Cloud Messaging** and generate a **Web Push (VAPID) key** → add it to `.env` as `VITE_FIREBASE_VAPID_KEY`.
3. For email: confirm the **Resend** sending domain (`ifcwpg.com`) is verified and the **`RESEND_API_KEY`** secret exists in Secret Manager (it does — **do not** run `functions:secrets:set` unless deploy reports it missing).
4. Deploy: `npx firebase deploy --only functions` (or `functions,firestore` together). The hourly `dispatchReminders` and daily `cleanupRetention` schedules register automatically. On first deploy, grant the functions access to the `RESEND_API_KEY` secret when prompted.
> **Rollback:** revert Hosting in the console (or redeploy a previous build); disable a misbehaving function with `firebase functions:delete <name>` or by removing its export and redeploying.

### Deployment preparation checklist (v1.1)

> **v1.1 has NOT been deployed.** Everything below is verified against the Firebase Emulator Suite only. Work through this before the first production deploy:

- [ ] **Blaze** billing plan enabled + **GCP budget/billing alert** set
- [ ] `RESEND_API_KEY` present in **Secret Manager**; functions granted access
- [ ] **Resend domain `ifcwpg.com` verified**
- [ ] **VAPID key** in `.env`; **App Check** reCAPTCHA site key registered + enforced per service (optional)
- [ ] **Firestore indexes** deployed (`firestore.indexes.json`) and **security rules** deployed
- [ ] Functions **runtime `nodejs20`**, region **`northamerica-northeast1`**
- [ ] `IFC_APP_URL` set to the production URL (email deep-links); `IFC_REPLY_TO` set if a monitored inbox exists
- [ ] Confirm **email limits** (`RESEND_MONTHLY_EMAIL_LIMIT` / `RESEND_DAILY_SAFETY_LIMIT`) and **retention** windows
- [ ] Send a **test email** (Notifications → settings → Admin · test email) and confirm Resend acceptance
- [ ] **iPhone PWA test**: Add to Home Screen → open → enable push → receive a notification
- [ ] Production **admin account** bootstrapped (below); a couple of **test accounts** for QA

**Bootstrap the first admin** (rules require this once): the first person registers in the app, then in the Firestore console set their `users/{uid}` doc to `role: "admin"`, `status: "approved"`. After that, approvals happen in-app via **Admin → People**.

**Launch with real content:** as the admin, **Admin → Import** → upload [`production-tasks.csv`](production-tasks.csv) (or paste the link-shared Google Sheet). Owners/crew without accounts import as **Pending** and are suggested to matching users when they sign up.

---

## Testing

The project has no lint/type-check tooling (plain JSX, no TypeScript). The commands that exist and are verified to work:

| Command | What it checks |
| --- | --- |
| `npm run build` | Frontend production build (Vite) |
| `node --test src/events.test.js` | Recurrence-engine unit tests (last-day, last-Friday, 3rd-Friday every-other-month from Aug 21 2026, leap Feb, boundaries, exceptions/dedupe) |
| `node --check functions/*.js` | Cloud Functions syntax (no build step — CommonJS) |
| `npm --prefix functions ls --depth=0` | Functions dependency validation |

**Emulator integration tests.** The notification backend is exercised against the running Emulator Suite with `firebase-admin` scripts (they seed and assert, then clean up). Start the emulators (`npm run emulators`), then run a script that drives the flow. Covered scenarios (all verified): task assigned / QA / changes / approved / ready / mention; preference-disabled recipients; duplicate-trigger idempotency; dispatcher delivery, **atomic-lease** de-dup under concurrent runs, and Posted-task cancellation; email quota reservation, **priority shedding** (low @85%, non-critical @95%), monthly + daily limits, threshold alerts, and **no oversell under parallel load**; and security (unauthenticated / non-admin `sendTestEmail`, server-only writes to `systemUsage` / `emailDeliveries` / `reminderInstances`, cross-user preference writes).

> **Testing Resend safely:** the emulator **skips real Resend calls** for the automatic (trigger-driven) flow, so seeding/dev never spends quota. Only the admin **test-email** callable sends for real — use a real inbox or `delivered@resend.dev`, never an `@example.com` address (Resend rejects it). The API key is read from Secret Manager via your local credentials; it is never printed.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| **Push permission denied** | The user declined the browser prompt. Re-enable notifications for the site in browser settings, then reload. |
| **iPhone push unavailable** | iOS/iPadOS only allow web push for **Home-Screen-installed** PWAs. Add to Home Screen, open from the icon, *then* enable push. |
| **No service worker / token errors** | Ensure `public/firebase-messaging-sw.js` is served at the site root and `VITE_FIREBASE_VAPID_KEY` is set. Invalid FCM tokens are pruned server-side automatically. |
| **App Check failures** | Only occurs when a site key is set + enforcement is on. Verify the reCAPTCHA key and that App Check is registered for each enforced service. Unset the key to disable. |
| **"RESEND_API_KEY is not configured"** | The secret isn't bound/accessible on the function. Confirm `secrets: [resendApiKey]` and that access was granted on deploy. |
| **Resend "Invalid `to` field"** | `@example.com` is rejected — use a real address or `delivered@resend.dev`. Also confirm the domain is verified. |
| **Email quota reached** | Expected at the internal cap — emails are `suppressed_quota_limit`; **in-app notifications continue**. Raise the limit via `RESEND_MONTHLY_EMAIL_LIMIT` (redeploy) if appropriate. |
| **Duplicate notifications** | Shouldn't happen — writes use deterministic ids + idempotency keys. Check that a caller isn't using a non-deterministic `keyBase`. |
| **Reminder not generated** | Reminders only materialize for tasks with a `postDate`, aren't in the past, and aren't Posted/archived. Check the task's `reminders` (or the default schedule). |
| **Recurring occurrence missing** | Verify the series rule + `start`/`everyX`/`anchor` in `src/events.js`; the engine skips off-phase months and dates before `start`. |
| **Firestore index errors** | Deploy `firestore.indexes.json`. The composite indexes are `notifications(uid, createdAt desc)` and `reminderInstances(status, fireAt)`. |
| **Emulator connection issues** | Confirm `VITE_USE_EMULATOR=true` and ports 8080/9099/5001/8085/4000 are free (`pkill -9 -f firebase`). |
| **Missing Cloud Function secret access** | On deploy, grant the function access to `RESEND_API_KEY`, or re-run the access grant in the console. |

---

## Security

- **Secrets never in the frontend.** The Resend key lives only in Secret Manager and is read server-side; FCM/Firebase web config are *public* by design. A repo secret scan is part of release prep.
- **Firestore rules enforce authorization** (`firestore.rules`), not the UI. Server-owned collections — `reminderInstances`, `emailDeliveries`, `systemUsage` — are **admin-read, never client-writable**. `notifications` are readable/markable only by their owner; a member may self-edit **only** `notifPrefs`.
- **Admin-only operations:** the `sendTestEmail` callable requires an authenticated admin and a valid recipient — there is **no arbitrary/public email endpoint**. Usage counters and email limits **cannot be changed from the frontend** (server-only writes; limits are code/env, requiring a redeploy).
- **Idempotency & duplicate protection:** deterministic notification ids + Resend idempotency keys; atomic transaction claims for the dispatcher and email quota so concurrent instances can't double-send or oversell.
- **App Check** (optional) can be enforced per service once a reCAPTCHA key is provisioned.

---

## Contributing Guide

1. **Branch** off `main` (`feature/…` or `fix/…`).
2. **Develop** against the emulator (`npm run emulators` + `VITE_USE_EMULATOR=true npm run dev`); never test against production data.
3. **Keep the split:** put pure logic in `src/data.js` (no React/Firebase) and verify it under Node; UI in `App.jsx`. Match the surrounding code style.
4. **Security changes** go in `firestore.rules` — and authorization must be enforced there, not just in the UI. The emulator hot-reloads the rules; test allow/deny paths.
5. **Verify** before opening a PR: `npm run build` is clean, and you've exercised the change in the running app.
6. **Open a PR** and request a review before merging.

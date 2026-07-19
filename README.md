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
pushDeviceCount, pushUpdatedAt   // server-maintained push summary (no raw tokens)
createdAt
```
Subcollection **`users/{uid}/fcmTokens/{token}`** — `{ token, ua, createdAt, lastSeen }` — web-push device tokens (one per device; a user manages only their own). A server trigger rolls these up into `pushDeviceCount`/`pushUpdatedAt` on the parent doc so admins can see push status without the tokens ever being exposed.

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

**`eventSeries/{id}`** — admin-managed recurring events (approved-read, admin-write). `{ name, emoji, rule (monthly | yearly | nth-weekday | last-weekday | last-day | everyXMonths | everyXWeeks), anchorDate, … }`. Merged with the built-in `events.js` series to drive Home's upcoming-events cards.

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
- **Recurring ministry events (admin-managed)** — a real recurrence engine (`events.js`) generates the next occurrence of Cross Over Service (last day of month), Praise & Testimony Night (last Friday), the Bi-Monthly Mini Vigil (3rd Friday every other month), plus birthdays/holidays — no hardcoded monthly dates. Admins now **create/edit their own recurring series** (name, emoji, cadence rule, anchor date) in **Admin → Events**, stored in the Firestore **`eventSeries`** collection and merged into Home alongside the built-ins. Home cards show the next date, days remaining, and per-**occurrence** content status ("2 content pieces planned" vs "Content has not been planned yet") with **Create content** (pre-fills a task stamped with that occurrence) / **View content** actions.
- **Notifications** — an in-app **Notification Center** (bell + unread badge + panel, mark-read, click-through) with per-user **preferences** (push/email channels + per-type toggles), fed by a server-side notification engine with **responsibility-based channel routing** (see [Notifications & Reminders](#notifications--reminders-v11)).
- **Weekly Saturday check-in** — a gentle **Saturday 9:00 PM** reminder (in-app + push) nudging the team to check what they're shooting/preparing for Sunday.
- **What's New & feature requests** — a **What's New** page surfaces plain-language release notes (with a badge when there's something unseen); **Submit feature request** (profile menu) files a structured idea (title · problem · who it helps · link) into the `issues` collection for admin review.
- **Global search & archive** — search every task across all statuses (Posted/archived included); active surfaces stay forward-looking while archived work remains one filter away.
- **CSV / Google Sheet import** with **intelligent name matching** — bulk-create tasks; unknown owners/crew import as **Pending**, and the importer reconciles shortened/alternate/ambiguous sheet names against real accounts (see [Intelligent Name Matching](#intelligent-name-matching-import-reconciliation)). _Currently **hidden behind a build flag** (`ENABLE_CSV_IMPORT = false` in `App.jsx`) — flip it to expose the Import tab for launch/bulk loads._
- **Issue reporting & error tracking** — see [Logging & Monitoring](#logging--monitoring).
- **Beta mode** — a compact, dismissible in-app banner inviting bug/feedback reports during the test phase.
- **Mobile-first** — floating liquid-glass bottom nav + glass header, single controlled scroll region, role-aware nav, collapsible filters/sections, and safe-area handling so modals clear the iPhone Safari/Chrome URL bar.
- **Dark mode** — system preference + manual toggle, remembered, with a brief one-shot colour cross-fade on switch.

**In progress (v1.1):**
- **Web push (FCM)** delivery — the in-app center, backend, and per-device token handling are built; enabling real push needs the Blaze plan + a VAPID key. iPhone/iPad push requires the app be added to the Home Screen first. **Email delivery via Resend is built and verified** (see [Email](#email-resend)).

**Planned (not yet built):**
- **Department-lead dashboards** and a full **Events calendar** page. _(Admins can already create/edit recurring series in **Admin → Events** — stored in `eventSeries`; what's left is a month/agenda calendar view and event content templates.)_
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

**Immediate (event-driven) notifications** — `onTaskWrite`: assignment (owner + crew), and status transitions → **In Review** (QA + admins), **Changes Requested** (owner), **Approved** (owner in-app + caption team push), **Ready to Post** (posting team). `onCommentCreate`: **@mentions**. `onUserWrite`: new registration → admins, and approval → the user (account/security messages bypass preferences). `weeklyTaskCheck` (`onSchedule`, **Saturday 9:00 PM Winnipeg**): a team-wide in-app + push nudge to review what's due for Sunday, idempotent per week. `onFcmTokenWrite` keeps a privacy-safe `pushDeviceCount`/`pushUpdatedAt` on the user doc so admins can see push status **without** the raw tokens ever being exposed.

**Responsibility-based channel routing** — in-app is the **system of record**; each notification type has a channel + priority policy (`NOTIFY_POLICY` in `functions/lib.js`) built around *"notify the person who owns the next action."* **Email is reserved for blocked / required / escalation cases** so routine activity never fills inboxes: only *Changes Requested* and *account approved* email by default; assigned/QA/approved/ready/reminder/overdue/mention/weekly-check ride in-app (+ push). Callers may still override channels per event (the reminder dispatcher strips email to send a single digest; the Approved handler gives the caption team push while the owner gets an in-app-only heads-up). Users' own per-type/per-channel preferences layer on top.

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

## Design System (v1.1.2)

v1.1.2 is a **mobile-first design refresh** — visual/interaction only; all v1.0/v1.1 functionality and data structures are unchanged.

- **Tokens** ([src/styles.css](src/styles.css) `:root`): semantic colors (light + dark), type scale (page 28 / section 21 / card 16 / body 14.5 / support 13 / label 12), spacing 4–64px, radius 10–22px, two soft shadows, motion durations (**100 / 160 / 220 / 280ms**) + three easings, icon sizes. Legacy variable names are aliases — new rules must use semantic tokens.
- **Typography:** single sans-serif (**Inter**); the serif (Fraunces) was removed. Hierarchy via weight/spacing.
- **Color:** refined indigo-violet primary — `#6750C8` (light) / `#9A83EE` (dark) — used selectively (actions, active nav, selection, progress); muted semantic colors; warm off-white lavender background (`#F7F6FA`) over a layered dark canvas (`#0F0C16` → sidebar → surface → elevated).
- **Icons:** **Heroicons** (`@heroicons/react/24/outline`), imported individually, sized via `.hi/.hi-sm/.hi-nav/.hi-empty`, `currentColor`, `aria-hidden` + labels on icon-only buttons. The birthday cake 🎂 (and admin-set event emoji) are the only intentional glyphs; no emoji/unicode *functional* icons remain.
- **Motion:** one shared **CSS-first** system (transform/opacity only — no `height:auto`, `top`/`left`, or filter animations), token durations/easings, and a single global `prefers-reduced-motion` reset. No animation library added. See **Cross-browser motion** below.
- **Single-scroll shell:** the app is a fixed `100dvh` frame with **exactly one scroll region** (`.sb-content`); `body` never scrolls. This removes the iOS standalone rubber-band bounce and the "two competing scrollers" behaviour in the installed PWA. Fixed overlays (nav, FAB, toasts) live at the shell level, never inside a transformed ancestor.
- **Navigation (mobile):** a floating **"liquid glass" bottom nav** — a rounded, blurred capsule hovering above the home indicator with five equal columns (Home · My Day · Board · My Work · Profile) and one shared **active indicator that glides** behind the current tab (`translate3d`, GPU-composited). Team/Admin live in the profile sheet (admin badge on the avatar); 44px+ targets, safe-area padding. Desktop sidebar has Main/Management groups and collapses to icons at 900–1139px. Admin FAB on content tabs.
- **Header (mobile):** a translucent **glass surface** (not a solid purple block) with Search + Notifications only — the profile moved into the bottom nav.
- **Home:** shorter greeting → **forward-looking** upcoming events (dense Apple-Reminders-style cards: emoji · title · relative date · status/action footer) → **Your focus** (only what needs you) → compact **Team progress** card → wins.
- **Tasks:** persisted **Board/List** view toggle; task detail gains a six-step **workflow stepper** with a Changes-Requested branch state. **Posted = auto-archived:** reaching *Posted* stamps `archivedAt` and drops the task from every active surface (Home, My Day, My Work, the active Workflow list, team load, reminders, notifications); the Workflow group is relabelled a muted **Archived**. Nothing is deleted — it stays in Search, the Board *Archive* filter, Reports, and Admin.
- **Reminders:** the task form shows a summary ("Using team default · 4 reminders"); the schedule opens in a bottom sheet as a chronological **timeline** (computed dates at 9:00 AM Winnipeg, switches, expandable delivery options, reset to default, validation).
- **Notifications:** desktop **right-side drawer**, unread count, category filters (five primary + a More menu), date grouping (Today/Yesterday/This week/Earlier), three-region layout so only the list scrolls.
- **Cross-browser motion (Safari-safe):** every `backdrop-filter` ships `-webkit-backdrop-filter` + an `@supports` opaque fallback; every `color-mix()` glass surface (bottom nav, active indicator, header, unread rows) carries a **solid `background` fallback first**, so on iOS < 16.2 the surface stays visible instead of rendering transparent; `100dvh` is always paired with a `100vh` fallback. See the addendum in [design_changes.md](design_changes.md).
- **Breakpoints:** 560 / 680 / 900 (desktop shell) / 1140 (full sidebar).
- **Known limitations:** Calendar view for tasks and a dedicated mobile notifications *page* are deferred; the JS bundle grew ~27 kB gzip from the icon set (route-level code-splitting is the planned mitigation).

---

## Future Roadmap

- Finish **push + email** delivery for notifications (in-app center + backend are done); notification retention cleanup + App Check.
- **Department-lead** dashboards and a dedicated **Events calendar** page (admin event CRUD + Firestore `eventSeries` already ship; next is a calendar view + event content templates).
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
- **Feature requests** — **Submit feature request** (profile menu) writes a structured `kind: "feature_request"` entry (title · problem · beneficiary · link) to the same `issues` collection for admins to review.
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
│   ├── onFcmTokenWrite.js    # Maintains privacy-safe pushDeviceCount on the user doc
│   ├── dispatchReminders.js  # Hourly dispatcher (atomic lease) + leadership digest
│   ├── weeklyTaskCheck.js    # Saturday 9PM Winnipeg team check-in (in-app + push)
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
    ├── data.email.test.js    # Node unit tests for email-preference/validation helpers
    ├── notifications.js      # Notification Center hook + preference helpers
    ├── push.js               # FCM web-push enrollment (token registration, foreground)
    ├── releases.js           # What's New release notes (LATEST_RELEASE + RELEASES)
    ├── logging.js            # Error capture, issue reporting, feature requests, route tracking
    ├── theme.js              # Light/dark theme (system pref + persistence + cross-fade)
    └── styles.css            # All styles + the light/dark CSS variables
```

Conceptual mapping for newcomers:
- **Pages / components** → functions in `src/App.jsx` (`Home`, `MyDay`, `BoardList`, `Mine`, `Team`, `Admin`, `AdminEvents`, `EventSeriesEditor`, `TaskDetail`, `TaskEditor`, `UserEditor`, `ImportPanel`, `IssueLog`, `WhatsNew`, `FeatureRequestModal`, `ConfirmDialog`, …).
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

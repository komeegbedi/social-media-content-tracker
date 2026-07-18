# Changelog

All notable changes to IFC Creatives Board are documented here.

## [1.1.2] — Mobile-First Design System & Experience Refresh (unreleased)

Visual/interaction redesign only — v1.0/v1.1 functionality, backend, and data structures unchanged. Not deployed.

### Added / Changed
- Semantic design-token layer (color light/dark, type, spacing, radius, shadows, motion) with legacy aliases; single sans-serif (Inter)
- Heroicons everywhere (outline + solid active states); zero emoji/unicode functional icons
- Responsive shell: 5-item mobile bottom nav with Profile sheet (Team/Admin moved there), grouped desktop sidebar with medium-width icon collapse, admin FAB on all content tabs
- Home: "Your focus" list + compact "Team progress" card replace the metric strips
- Tasks: persisted Board/List view toggle; six-step workflow stepper with Changes-Requested branch
- Reminders: summary-in-form + bottom-sheet chronological timeline editor (Winnipeg-time dates, switches, delivery-options disclosure, reset-to-default, validation)
- Notifications: desktop right-side drawer, unread count, category filters, date grouping
- Accessibility: global focus-visible ring, 40–48px touch targets, aria-current/labels/switch roles, reduced-motion preserved

### Final release additions
- Admin-managed recurring events (emoji, anchored schedules, pause/archive, next-dates preview)
- Saturday 9 PM Winnipeg weekly task-check notification (in-app + push, per-user preference)
- Redesigned transactional emails (compact branded header, context panel, specific CTAs, safe name fallback)
- What's new page + Submit feature request (profile menu); CSV import hidden behind ENABLE_CSV_IMPORT flag
- Smaller icons, natural easing, clickable profile row

### Known limitations
- Task Calendar view and a dedicated mobile notifications page deferred; bundle +~27 kB gzip (icons) — code-splitting planned

## [1.1.0] — Proactive Notifications & Recurring Events (unreleased)

> Verified against the Firebase Emulator Suite. **Not yet deployed to production.**

### Added
- **Recurring ministry events** — a rule-based recurrence engine (`src/events.js`) generating the next occurrence of Cross Over Service (last day of month), Praise & Testimony Night (last Friday), and the Bi-Monthly Mini Vigil (3rd Friday every other month, anchored Aug 21 2026), plus birthdays/holidays. Stable series + occurrence identity; Home event cards with per-occurrence content status and Create/View actions.
- **In-app Notification Center** — bell + unread badge + slide-over panel (mark-read, load-more, click-through), with per-user **notification preferences** (push/email channels + per-type toggles).
- **Cloud Functions backend** (2nd gen, Node 20, `northamerica-northeast1`) — Firestore triggers for assignment, status transitions (QA / changes / approved / ready), @mentions, and account approval; an **hourly dispatcher** with **atomic-lease** claiming, retries, and a daily leadership follow-up digest.
- **Reminder scheduling** — per-task reminder editor (offset · before/after · channels · recipients · on-off, max 10) and an admin **global default schedule**; materialized in `America/Winnipeg` (stored UTC), cancelled on Posted/archive.
- **Web push (FCM)** — service worker, per-device token management with pruning, foreground toast, deep-linking, and **iPhone Add-to-Home-Screen onboarding**.
- **Resend transactional email** — branded templates, deep-links, plain-text fallbacks; idempotent sends with an `emailDeliveries` ledger; admin-only test-email callable.
- **Email usage safeguards** — monthly (2,800) + daily (250) limits via **atomic quota reservation**, priority-based shedding (critical/standard/low), threshold admin alerts (70/85/95/100%), reminder **digest** batching, and a live admin usage dashboard.
- **Retention cleanup** — daily pruning of old reminder instances, read notifications, delivery logs, stale FCM tokens, and daily usage docs.
- **Firebase App Check** (optional) — reCAPTCHA v3 client wiring, guarded by env key and skipped in the emulator.
- **Firestore** — composite indexes (`notifications`, `reminderInstances`); rules for `notifications`, `reminderInstances`, `emailDeliveries`, `systemUsage`, `fcmTokens`, and the comments subcollection; scoped member self-edit of `notifPrefs`.
- Recurrence-engine unit tests; expanded documentation.

### Notes
- In-app notifications always work regardless of push/email availability.
- Push and email delivery require the Blaze plan + VAPID key + verified Resend domain (see the deployment checklist in the README).

## [1.0.0] — Initial release
- 7-stage content workflow, task management, QA/approvals, content links, activity timeline, role-based dashboards, admin leadership dashboard, CSV/Google-Sheet import with intelligent name matching, issue reporting, mobile-first UI, dark mode. Rebranded StudioBoard → IFC Creatives Board.

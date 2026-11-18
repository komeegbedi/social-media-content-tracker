# IFC Creative Academy ("Learn")

> **v4 (current)** — categories and topics are editable **records**; category
> and course covers are portrait 3:4; "The Heart of Serving" is an ordinary
> category in the Explore grid (also featured above it, by stable id); courses
> have **no instructor/owner** — editing is a global *Academy editor* role;
> video lessons get a provider preview (oEmbed) and a source/custom 16:9
> thumbnail choice. Where this file's older sections mention a fixed category
> list, instructors, or landscape category cards, the v4 section below wins.

A learning section inside the IFC Creatives Board. Members take short courses in
Photography, Videography, Graphic Design and Social Media; admins and course
instructors build them. Navigation label: **Learn** (`/learn`).

This document is the reference for the data model, the security model, video
providers and their tracking limitations, image handling, completion rules and
the Firebase configuration that still needs attention before a production
deploy. Nothing in this feature has been deployed; see "Before going live".

---

## Structure (v2)

**Six categories** — the single source of truth is `ACADEMY_CATEGORIES` in
`src/academyProgress.js` (ids, labels, purposes, suggested topics). Nothing else
hard-codes a category name; `firestore.rules` mirrors the id list (guarded by a
test).

| id | Label | Role on Learn home |
| --- | --- | --- |
| `heart-of-serving` | The Heart of Serving | **Start here** area (with the purpose video) |
| `photography` | Photography | library |
| `filmmaking` | Filmmaking | library |
| `graphic-design` | Graphic Design | library |
| `social-media-storytelling` | Social Media & Storytelling | library |
| `creating-together` | Creating Together | library |

Platforms, software and techniques (Reels, TikTok, CapCut, colour grading…) are
**topics** — free-text tags on each piece of content (≤ 12), searchable, with
per-category suggestions in the editor. They are never categories.

Suggested onboarding (guidance, no lock): The Heart of Serving → Creating
Together → the creative skill you serve with.

**Three formats** (`CONTENT_FORMATS`): course, quick guide, learning path.
Category and format are independent filters; search spans titles, authors,
categories, levels, topics, body text and format names, and results are labelled.

### Category migration (legacy ids)
The first build used `videography` and `social-media`. Stored docs may still
carry them: reads normalise (`normalizeCategory`), the editor writes the new id
on the next save, and `validCategory()` in `firestore.rules` accepts both. To
finish the migration later (NOT run — review first):

```
courses where category == "videography"   → "filmmaking"
courses where category == "social-media"  → "social-media-storytelling"
```
(Admin SDK, one update per doc, no other field touched; then drop the two legacy
ids from `LEGACY_CATEGORY_IDS` and `validCategory()`.) Production content was
not inspected or changed; only the emulator seed was updated. Where a Reels-type
course mixes production and publishing lessons, the intent is: production →
Filmmaking, publishing/strategy → Social Media & Storytelling (the demo seed
splits its old "Reels" course this way).

## Learning hierarchy (v3): Category → Course → ordered lessons

The home page is category-first. Five category cards (Photography, Filmmaking,
Graphic Design, Social Media & Storytelling, Creating Together) are the primary
browsing surface; **The Heart of Serving** is reached through the compact
"Start here" introduction (and remains a normal category page). Quick guides
and learning paths stay available through category "Tips & resources", the
Browse listing (`/learn/browse`), search, recommendations and their own URLs —
they no longer compete with categories on the home page.

**Home page order:** A) compact introduction ("The Heart Behind the Creative",
landscape thumbnail, Watch introduction; after the provider reports the video
ended — or the learner marks it watched where the provider can't — a smaller
"Watched · Watch again" version) → B) Explore categories (3 + 2 wide cards on
desktop, counts = published courses *this learner can read*) → C) For you
(2–4 deterministic suggestions with honest reasons) → D) Recently added
(publication dates) → secondary links (Learning paths, All quick guides,
Browse everything). Search is in the header and lands on `/learn/browse?q=`.

**For you — the rules** (`src/academyRecommend.js`, no AI, no external data):
1. *Continue learning* / *Because you started <course>* — the next unfinished
   lesson of each started course, computed from the course's saved module order
   + the learner's own progress doc (only that one lesson doc is fetched).
2. *For the <team> team* — not-started published courses in the category that
   serves the learner's department(s) (`DEPARTMENT_CATEGORY`), beginner first.
3. *Recommended for new members* / *Start with Creating Together* — onboarding
   categories, when fewer than two suggestions exist.
4. *Explore* — neutral fallback. Completed courses appear only when nothing else
   does, labelled *Completed · review any time*. Never drafts, never duplicates,
   never a claim about skill.

**Curriculum item kinds** (`LESSON_KINDS`, stored as `lesson.kind`; older
lessons read as video if linked, else written):

| kind | completes when | notes |
| --- | --- | --- |
| video | provider `ended` (or last 3 s of a known duration), or *Mark lesson as done* where the provider can't report playback / the player failed | an `ended` event is the provider's notion of finished, not proof of attentive viewing — documented in the UI copy |
| written | learner presses *Mark as read* | |
| exercise | learner presses *Mark exercise complete* | self-reported; no submission or mentor review in scope |
| resource | learner presses *Mark as reviewed* | the resource links ARE the step |

A REQUIRED quiz overrides all of the above. Supplementary links on any lesson
never add a completion requirement. `bonus` lessons are excluded from course %.
Self-reports are labelled as such — never as assessed competence. Course
`previewVideo` is an explicitly configured trailer; the first lesson is never
assumed to be one.

**Ordering:** the course's `modules[].lessonIds` is the only sequence. Editors
drag lessons within/between modules (plus Move up/down and a "move to module"
select for keyboard and touch); Save writes `modules` + counters. Lesson ids,
URLs, progress, comments and quiz attempts are untouched by reordering; Resume
and prev/next follow the saved order. The order is a recommendation — there is
no lesson locking.

## Routes

| URL | View |
| --- | --- |
| `/learn` | Creative Academy home (order above) |
| `/learn/category/:categoryId` | Category page — breadcrumb, purpose, published count, Continue your course, portrait course grid, drafts (editors), Tips & resources (quick guides). Legacy ids redirect to the canonical id |
| `/learn/browse?format=&category=&sort=&q=` | Full listing — format + category filters, search, "Recently added" sort (View all), Learning paths / Quick guides destinations |
| `/learn/course/:courseId` | Course overview — cover, instructor, about, outcomes, requirements, topics, curriculum, Start/Resume, progress, leader view |
| `/learn/course/:courseId/lesson/:lessonId` | Lesson — player, description, resources, quiz, discussion, prev/next, curriculum sidebar |
| `/learn/guide/:guideId` | Quick guide — optional video, body, resources, **Mark as reviewed** (self-reported), discussion, leader "who reviewed" list |
| `/learn/path/:pathId` | Learning path — cover, purpose, ordered steps with completed / up next / unavailable states, Continue, progress, leader view |

Existing course/lesson URLs are unchanged.

Course, guide and path management lives in the Academy workspace
(**Learn → Manage**, `/learn/manage`; see the v6 section) and behind **Edit** on
each content page. *(The former Admin → Academy tab was retired in the v6
cleanup; old links redirect to the workspace.)*

Code: `src/nav.js` (routes), `src/Academy.jsx` (learner UI), `src/AcademyManage.jsx`
(editor UI), `src/academyData.js` (Firestore/Storage/callable adapter),
`src/academyProgress.js` (completion/ordering rules), `src/academyVideo.js`
(link parsing), `src/academyMarkdown.js` (safe text), `src/academyImage.js`
(image policy + crop), `functions/academyQuiz.js` + `functions/academyScoring.js`
(server-side grading), `firestore.rules` (Academy section), `storage.rules`.

---

## Roles

| Role | Who | Can |
| --- | --- | --- |
| Learner | any approved member (`status: approved`, or admin) | view published courses, keep progress, take quizzes, comment |
| Course editor | admin, or the course's `instructorUid` | create (admin only) / edit / preview / publish / unpublish / archive the course, manage lessons, quizzes, images, moderate + pin comments |
| Leader | admin, or `lead: true` | view every learner's progress + attempt counts for a course |

Drafts and archived courses are invisible to learners — enforced in the UI
(`canViewCourse`) **and** in `firestore.rules` / `storage.rules`. A learner's
Firestore query is `where("status" == "published")`; an unfiltered list is
denied by rules.

Completing a course is a learning milestone, not approval to serve. The UI says so.

---

## Data model (Firestore)

```
courses/{courseId}
  title, category (one of the six ids; legacy ids readable), topics[],
  level (beginner|intermediate|advanced), status (draft|published|archived),
  instructorUid, instructorName, about (markdown subset), outcomes[], requirements[],
  cover {path, version, contentType, bytes, w, h} | null,
  modules: [{ id, title, lessonIds[] }]           ← the ONLY ordering source
  lessonCount, requiredLessonCount, requiredQuizLessonIds[], bonusLessonIds[],
  durationMinutes                                   ← denormalised on every save
  createdAt/By, updatedAt/By, publishedAt, archivedAt

courses/{courseId}/lessons/{lessonId}
  title, moduleId, video {provider, id, hash?} | null, description (markdown subset),
  resources [{label, url}], thumb (image ref) | null, bonus, durationMinutes,
  quiz { mode: none|practice|required, passMark, retryLimit,
         questions: [{ id, prompt, multi, options: [{id, text}] }] }   ← NO answers

courses/{courseId}/lessons/{lessonId}/comments/{id}
  uid, name, role (learner|instructor|admin — verified by rules), txt, parentId|null,
  pinned, createdAt, editedAt

courses/{courseId}/quizKeys/{lessonId}              ← editors only
  answers { [questionId]: [optionId] }, explanations { [questionId]: text }, updatedAt

guides/{guideId}                                    ← quick guide (no modules, no quiz)
  title, category, topics[], status, instructorUid, instructorName, video | null,
  body (markdown subset), resources[], thumb (16:9 ref) | null, durationMinutes, stamps
guides/{guideId}/comments/{id}                      ← same shape/rules as lesson comments

paths/{pathId}                                      ← learning path (REFERENCES only)
  title, purpose, category ("" allowed), topics[], status, instructorUid, instructorName,
  cover (3:4 ref) | null,
  items: [{ id, type: course|lesson|guide, courseId?, lessonId?, guideId?, required, label }]

learnerProgress/{uid}/guideReviews/{guideId}        ← learner-writable self-report
  uid, guideId, reviewed (bool), reviewedAt, updatedAt
learnerProgress/{uid}/pathProgress/{pathId}         ← learner-writable bookkeeping only
  uid, pathId, startedAt, lastItemKey, lastViewedAt, updatedAt   (no completion fields)

academySettings/categories                          ← admin-managed: { art: { [fixed category id]: imageRef } }
                                                       (names/ids are code; rules reject any other key)
learnerProgress/{uid}/intro/purposeVideo            ← learner-writable { uid, watched, watchedAt, updatedAt }

academySettings/purposeVideo                        ← admin-managed
  title, intro, video, thumb, updatedAt, updatedBy

learnerProgress/{uid}/courseProgress/{courseId}
  uid, courseId, startedAt, lastLessonId, lastViewedAt, updatedAt,
  lessons { [lessonId]: { positionSec, durationSec, videoWatched, videoWatchedAt,
                          manualDone, manualDoneAt, viewedAt } }   ← learner-writable
  earned  { [lessonId]: { at, attemptId, percent } }              ← SERVER-ONLY

quizAttempts/{uid}/attempts/{attemptId}             ← server-written
  uid, courseId, lessonId, mode, answers, score, total, percent, passMark, passed,
  results [{ qId, correct, selected, correctOptions, explanation }], createdAt
```

Video records store only `{provider, id, hash?}`; the embed URL is rebuilt from a
fixed template at render time (`videoFromRecord`), so a stored document can never
carry an arbitrary iframe `src`. The rules reject a `video` map with any other key.

---

## Quick guides (now "Tips & resources" — see v6.11)
Standalone help: a linked video with notes, or text only. Opens directly (no
enrolment, no one-lesson course). **Mark as reviewed** stores
`guideReviews/{guideId}.reviewed = true` for the learner; the UI states it is the
learner's own note, not an assessment. Leaders see who reviewed a guide
(self-reported) — distinct from course/path completion.

## Learning paths
An ordered list of references to courses, single lessons or guides. Rules of the
road (`validatePathItems`, `resolvePathItems`, `pathProgress`):
* No duplicates; no lesson whose whole course is also in the path.
* Progress is derived from the **source** content: a lesson completed inside a
  path is the same lesson completion seen on the course, and vice versa. Guides
  count when reviewed. A path stores no completion of its own.
* Path % = completed required steps ÷ *available* required steps. Optional
  steps are labelled and excluded.
* A referenced item the learner can't see (draft, archived, removed, denied)
  renders as **unavailable** with only the path's own step label — never the
  private doc's title — is never counted complete, and is reported ("N currently
  unavailable"). A path never grants access: opening a step uses the item's own
  route and rules.
* Editing a path (reorder, add, remove) never resets anything; a new required
  step simply appears as outstanding.
* Path bookkeeping (`pathProgress`) only records started/last viewed.

---

## Completion and progress rules

* **Required-quiz lesson** — complete only when a *passed* attempt exists. The
  server writes `progress.earned[lessonId]`; clients cannot set, add to, or clear
  `earned` (rules diff it on every write). Watching the video is shown separately
  ("Video watched · Quiz required") and never completes the lesson by itself.
* **No quiz / practice quiz** — complete when the video was watched to the end
  (provider `ended` event, or the last 3 s of a known duration on a provider that
  reports time) **or** the learner pressed **Mark lesson as done**. Opening or
  seeking never counts. Practice quizzes record attempts but never earn completion.
* **Course %** = completed required lessons ÷ required lessons. `bonus` lessons are
  excluded from both numbers.
* **Edits** — earned completions are keyed by `lessonId`, so editing a lesson (even
  its quiz) keeps what was earned. New lessons appear as *Upcoming*; the
  percentage is recomputed against the current curriculum without resetting
  anything. Deleting a lesson keeps the learner's record but it no longer counts.
* **Resume** — the last viewed, still-incomplete lesson; else the first incomplete
  lesson; else lesson 1 for a completed course.
* **Playback position** is saved at most every 15 s of playback and only when it
  moved ≥ 5 s, never inside the last 10 s; resuming ignores positions in the tail.
* **Retries** — `retryLimit` 0 = unlimited; the server counts prior attempts.
* **Grading** — `submitQuizAttempt` callable (`functions/academyQuiz.js`). A
  question is correct only when the selected set equals the key set (no partial
  credit on multi-answer). The response includes per-question correctness, the
  correct option ids and the explanation; the key itself never leaves the server.
  Attempts and earned completion are written with the Admin SDK in one transaction.

---

## Video providers (links only — nothing is uploaded or stored)

| Provider | Accepted links | Embed | Position / resume | "Watched" |
| --- | --- | --- | --- | --- |
| YouTube | `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `youtube-nocookie.com`, `m.youtube.com` | `youtube-nocookie.com/embed/{id}` via the IFrame Player API | yes (1 s polling while playing) | `ENDED` event |
| Vimeo | `vimeo.com/{id}`, `vimeo.com/{id}/{hash}` (unlisted), `player.vimeo.com/video/{id}` | `player.vimeo.com/video/{id}` via the postMessage player API (`timeupdate`, `ended`, `setCurrentTime`) | yes | `ended` event |
| Google Drive | `drive.google.com/file/d/{id}/…`, `/open?id=` | `drive.google.com/file/d/{id}/preview` | **no** (no player API) | manual only — the UI says so and shows **Mark lesson as done** |

Known limitations (by design, documented in the UI copy):

* "Watched" is the provider's own notion of ended. On YouTube/Vimeo, seeking to the
  final seconds and letting it end counts as watched; there is no watch-time audit.
* Private / unlisted-without-hash / embed-restricted videos fail inside the player;
  the player shows a message with an "Open on provider" link, and the YouTube API
  `onError` triggers the same state. Vimeo reports some restrictions only inside its
  own iframe UI.
* Provider scripts/iframes load from `youtube.com`, `youtube-nocookie.com`,
  `player.vimeo.com`, `drive.google.com`. There is no CSP in `index.html` today; if
  one is added, allow those origins for `script-src`/`frame-src`.
* YouTube's IFrame API script is loaded once on first use (not bundled).

---

## Images (course covers, lesson thumbnails, purpose thumbnail)

* Category artwork: landscape 16:9, 1600×900, `academy/categoryArt/{categoryId}/{version}.jpg`
  (admin-only writes, fixed ids). Fallback when absent: a tinted panel with the
  category's icon — never an empty rectangle. The seed uploads generated
  placeholder art; real photography is still needed.
* Input: JPEG / PNG / WebP ≤ 5 MB. Minimum 300 px on the short side.
* Client flow (`ImagePicker`): choose → preview + crop (zoom / position sliders
  constrained to the required ratio) → canvas resize to **900×1200** (cover, 3:4)
  or **1280×720** (thumbnail, 16:9) → JPEG, quality stepped down until ≤ ~250 KB →
  upload with `uploadBytes` to a **versioned** path:
  `academy/covers/{courseId}/{version}.jpg`,
  `academy/lessonThumbs/{courseId}/{lessonId}/{version}.jpg`, `academy/purpose/{version}.jpg`.
* Firestore stores only the reference `{path, version, contentType, bytes, w, h}`.
* Replacement order: upload new → save the new reference → delete the old object.
  Cancelling an editor deletes objects uploaded in that session that were never
  saved. Permanent course delete removes lessons, quiz keys, comments, the course
  doc, then the objects (reporting any that could not be removed).
* Reads go through the Firebase SDK (`getBlob` → object URL, cached per session).
  No `getDownloadURL` is ever called and no public or long-lived token URLs are
  stored, so reads follow the same access model as the course docs.
* `storage.rules`: reads require an approved profile and (published course or
  course editor); writes require a course editor, `image/jpeg|png|webp`, ≤ 2 MB;
  everything outside `academy/**` is denied. The rules use cross-service
  `firestore.get` lookups.

---

## Discussions

Comments with one level of threaded replies (`parentId`). The `role` badge
(Instructor / Admin) is stamped by the client but verified by rules against the
real role, so it can't be forged. Authors edit/delete their own; course editors
edit (moderate), delete and pin/unpin. Text is rendered through the safe inline
parser (links auto-linked, https-only; HTML is literal text). No notifications
or emails are sent for Academy activity in this release.

## Formatted text

Course "About" and lesson descriptions use a small markdown subset
(`src/academyMarkdown.js`): `#`/`##`/`###` headings, paragraphs, `-` and `1.`
lists, `**bold**`, `*italic*`, `` `code` ``, `[label](https://…)` and bare
https URLs. The renderer builds React elements from the parsed tree — there is
no `innerHTML` and no arbitrary HTML. Non-http(s) link targets render as text.

---

## Local development

```
npm run emulators      # now includes the Storage emulator (port 9199)
npm run seed           # adds 4 fictional courses (3 published, 1 draft), covers,
                       # the purpose video and two learners' progress
npm run dev            # http://localhost:5173 → Learn
```

The seed creates 10 demo courses — including the Filmmaking example set
*Camera Fundamentals* (video / written / exercise / resource steps + a preview
video), *Lighting Fundamentals*, *DaVinci Resolve Essentials*, *Storytelling
Through Film* — one left on the legacy `videography` id on purpose, 6 quick
guides (one draft), generated category artwork, the **Short-Form Content** demo path
(Plan the message → Film → Edit → Caption → Publish → Review the response, plus
an optional unpublished step that shows the unavailable state), and progress for
two learners. All demo text is labelled "demo"/"local demo content" and is not
IFC-approved material.

Sign in as `jane@example.com` (admin → Learn → Manage, edits any course),
`alex@example.com` (instructor of "Reels That Actually Land" + the draft; a
department lead, so sees Learner progress), `sam@example.com` (learner who has
started "Light & Composition"). These are local emulator demo accounts; their
password is set by `scripts/seed.js` (not repeated here).

Seeded video links are placeholders (a public YouTube id, a public Vimeo id and a
dummy Drive id that renders the "can't play" path); replace them in the editor.

## Checks

```
npm test                   # node unit tests (academy*.test.js, nav routes, guards)
npm run test:ui            # vitest: src/Academy.ui.test.jsx (markdown, quiz, card)
npm run test:functions     # functions/academyScoring.test.js + syntax check
npm run test:academy       # emulators:exec --only firestore,storage →
                           #   test/academy.rules.test.js (Firestore rules)
                           #   test/storage/storage.rules.test.js (Storage rules)
npm run test:emulator      # existing Firestore rules suite (unchanged scope)
npm run build
```

---

## Before going live (not done — needs a decision/action)

1. **Cloud Storage bucket** — the app's `storageBucket` is already in the web
   config (`VITE_FIREBASE_STORAGE_BUCKET`), but the bucket must exist/be enabled in
   the Firebase console (Storage → Get started). This can change the project's
   billing plan requirements; confirm before enabling.
2. **Storage CORS** — `getBlob`/`uploadBytes` are XHR calls from the hosting
   origin. Set a CORS policy on the bucket (e.g. `gsutil cors set cors.json
   gs://<bucket>` allowing `GET, PUT, POST, DELETE` from the hosting origins).
   The emulator doesn't need this; production does.
3. **Deploy `storage.rules`** (`firebase deploy --only storage`). The repo's
   `deploy` script only deploys hosting + firestore rules/indexes today.
4. **Deploy `firestore.rules`** (the Academy section) and
   **`firestore.indexes.json`** — four collection-group field overrides
   (`courseProgress.courseId`, `attempts.courseId`, `guideReviews.guideId`,
   `pathProgress.pathId`) are required for the leader views' collection-group
   queries; Firestore will otherwise return `failed-precondition` with an index link.
4b. **Category migration** (see above) — optional, reviewable, not run.
5. **Deploy the `submitQuizAttempt` function** (`firebase deploy --only
   functions:submitQuizAttempt`, region `northamerica-northeast1`, Node 22).
6. **Provider decisions** — confirm the team is happy with YouTube / Vimeo /
   Google Drive as the supported hosts, and whether Drive (no tracking) should stay.
7. **Notifications** — none are wired for Academy events (new course published,
   replies to your comment, instructor answers). The existing `notifyUsers`
   mechanism in `functions/lib.js` can be reused later via Firestore triggers.
8. **Deferred scope** — certificates, rankings, AI-generated courses, practice
   submissions, mentor sign-off, analytics.


---

## v4 — editable taxonomy, portrait categories, no instructors, video previews

### Roles (editor scope change — review)
| Before | Now |
| --- | --- |
| Editor = admin, or the course/guide/path's `instructorUid` | Editor = admin, or any approved member with **`academyEditor: true`** (toggle in the team-member editor, admin-only; can't be self-granted — rules-tested) |
| Admins created courses and named an instructor | Editors create courses, guides and paths; no owner field anywhere |
| Comment badge "Instructor" | "Moderator" (editors) / "Admin"; old "instructor" comments display as Moderator |

`instructorUid` / `instructorName` stay *readable* on old docs but grant
nothing and are never shown. `createdBy` / `updatedBy` remain as audit stamps
only. Categories (create, rename, cover, reorder, hide, delete) and topic
rename/hide/delete stay **admin-only**; editors can create topics while tagging.
All editors, admins included, manage content at **`/learn/manage`**.

### Categories — `academyCategories/{id}`
`{ name, short, description, order, hidden, cover, createdAt/By, updatedAt/By }`.
The id is a slug made once at creation and never changes, so renames don't
touch content, URLs, search, recommendations or progress. Bootstrap: with no
records, the six starter categories render, and an admin can create them as
records in one click (Learn → Manage → *Create the starter categories*). **Rules now require a
category record to exist** for any new course/guide/path write (plus the legacy
`videography` / `social-media` aliases) — so create the records *before*
deploying these rules (see migration).

* **Hide** — sets `hidden: true` on the record and adds the id (and its legacy
  aliases) to `academySettings/categoryIndex.hidden`. Rules read that list:
  learners can't get/list courses or guides in a hidden category, their
  lessons, comments, covers (Storage) or quiz attempts, regardless of each
  course's own status. Editors keep access. **Restore** removes it from the
  list; only already-published items reappear (drafts stay drafts). The
  confirmation dialog says exactly this.
* **Delete** — shows how many courses / guides / paths use the category and
  requires choosing a destination; everything is moved, then the record and
  its cover are removed. Content is never cascade-deleted.
* **Learner queries** carry `where("category", "in", <visible ids>)` (chunks of
  30) so the hidden-category rule is provable for every result; paths are
  status-gated only (their steps are gated by their own rules).
* **Covers** — portrait 3:4, 900×1200, `academy/catCovers/{categoryId}/…`
  (admin writes; the record must exist). Pre-v4 landscape uploads under
  `academy/categoryArt/` are still read and displayed **letterboxed (contain),
  never cropped or overwritten**, until an admin uploads a replacement; that
  path is now read/delete-only.
* The Explore grid shows **every visible category**, including The Heart of
  Serving, new ones and empty ones (empty state on the category page), as
  same-size portrait posters (2 / 3 / 6 columns). The "Start here" intro finds
  its category by the stable id `heart-of-serving`; if that record is hidden
  or deleted, the "More from…" link disappears and the intro video remains.

### Topics — `academyTopics/{id}`
`{ name, description, hidden, … }`; content carries `topicIds[]` (≤ 12).
Renames show everywhere immediately (names are looked up by id). Duplicate
names (case/space-insensitive) are refused. Hidden topics disappear from
learner chips, topic filtering (`/learn/browse?topic=<id>`) and new
assignment, but associations are kept so restoring brings them back. Delete
lists the referencing items and either removes the association or replaces it
with another topic — never deletes content.
**Legacy free-text `topics`** on older docs still display and search; in the
editor they show as "(legacy tag)" chips with *link* (to an existing record of
the same name) or *create* actions.

### Courses — status model
`draft → published → archived` is unchanged; the UI now labels archive as
**Hide (archive)** / **Restore to draft** so there's one hide mechanism, not a
second flag. Category hiding layers on top without touching course status.
Permanent delete (admin, unpublished only) now: deletes lessons, quiz keys,
comments, the course doc; **removes the course's steps from learning paths**;
deletes every learner's progress + quiz attempts for it (rules allow this only
once the course doc is gone, so no false completion survives); deletes
app-owned images only — provider-hosted videos/thumbnails are never touched.
The confirmation lists these effects.

### Video previews — `fetchVideoMetadata` (callable, new)
Editors see title, creator, provider thumbnail and an *Open original* link as
soon as a supported link is entered. The browser can't call oEmbed (no CORS),
so a callable does it, requesting only the endpoints listed in the official
oEmbed provider registry (oembed.com/providers.json, checked on 2026-11-12):
`https://www.youtube.com/oembed` and `https://vimeo.com/api/oembed.json`,
with a URL **built from the validated id** — never the pasted URL. No API key.
Google Drive has no metadata endpoint → explicit "no preview" note. Unknown or
private videos → 404 → "check the link"; network errors → retryable. A newer
link always wins over an older in-flight request; changing the link clears
stale metadata. The UI states that a preview proves parsing + provider
knowledge, not embeddability. Only the provider's own `thumbnail_url` is used
(no guessed thumbnail URL patterns). Metadata is stored as `videoMeta` on the
lesson/guide and shown to learners as attribution ("Video: <title> by
<creator>", linking to the original).

### Video thumbnails
`thumbMode: "source" | "custom"`. Source (default) = the provider's
`thumbnail_url`, referenced directly (never copied, never deleted by us),
letterboxed in 16:9. Custom = an app-owned 16:9 upload (crop editor, ≤ 1280×720,
existing Storage rules/cleanup). Switching back to source keeps the upload until
it's removed; replaced uploads are deleted only after the new reference saves.
Older docs with an upload but no `thumbMode` keep showing their upload. The
choice drives lesson/guide cards and the pre-play poster; once playing, the
embedded provider player may show its own artwork (stated in the editor).

### Learning-path completion (v5)
A path is complete only when **every required step is available and done**.
A required step that becomes unavailable (course deleted, unpublished,
archived, or its category hidden) is shown as unavailable, is never counted
complete, and **blocks** completion (`pathProgress().blocked`) — the page says
why. Deleting a course no longer edits paths (that could have awarded a
completion silently); the delete confirmation lists the affected paths so an
editor can update them deliberately. The first time a learner genuinely
completes a path, `completedAt` is stored on their own `pathProgress` doc, so
if the path later changes they see "You completed this path on …. It has
changed since." (learner-only; leader views show live progress).

### Course deletion: retryable clean-up (v5)
`src/academyDeletion.js` runs: record a pending entry
(`academySettings/pendingCleanup`, admin-only) → delete lessons, comments,
quiz keys, then the course doc → delete learners' progress + quiz attempts →
delete app-owned images → clear the pending entry only if everything
succeeded. A failure before the course doc is gone is shown in the confirmation
dialog (run it again to resume). A failure afterwards leaves a banner on
the Academy workspace home (`/learn/manage`) with **Retry clean-up**; every step is idempotent and
an already-deleted image counts as done. Unit-tested with injected failures.

---

## Deployment readiness (prepared locally — nothing has been run in production)

### Editor role — confirmed behaviour
* Academy editor = `role == "admin"`, or `academyEditor == true` on an
  approved, non-disabled profile (client: `isAcademyEditor`; rules:
  `isAcademyEditor()`; Storage: `isEditor()`; quiz callable: `attemptPrecondition`).
* Only admins can grant it: the toggle lives in the admin-only team-member
  editor; `users` rules let members change only `notifPrefs`/`appearance`, and
  registration rejects `academyEditor: true` (both emulator-tested).
* Editors: create/edit/publish/hide courses, guides, paths; upload their images;
  create topics while tagging; moderate/pin discussions. Admin-only: categories,
  topic rename/hide/delete, permanent deletes, deletion clean-up, the intro video.
* `instructorUid`/`instructorName` on old docs grant nothing (emulator-tested).

### Query → index inventory
Every Firestore query the Academy issues, and what serves it. Explicit entries
are in `firestore.indexes.json`; "auto" = Firestore's default single-field index.

| Query (where) | Index |
| --- | --- |
| `courses` / `guides`: `status == "published"` + `category in [visible ids]` (learner lists, `useContentList`) | **composite** `status ASC, category ASC` on `courses` and on `guides` (added explicitly) |
| `courses` / `guides` / `paths`: no filter (editor lists) | none |
| `paths`: `status == "published"` (learner list) | auto |
| `courses` / `guides` / `paths`: `category in [id, aliases]` (category delete) | auto |
| `courses` / `guides` / `paths`: `topicIds array-contains id` (topic delete) | auto (array) |
| `courses/{id}/lessons`, `…/comments`, `guides/{id}/comments`, `learnerProgress/{uid}/*`: whole collection | none |
| `courseDrafts`, `courseDrafts/{id}/lessons`: whole collection (v6 workspace, editors only) | none |
| `quizAttempts/{uid}/attempts`: `courseId ==` + `lessonId ==` (learner quiz panel; callable `.count()`) | auto (equality merge) — `attempts.courseId` override keeps COLLECTION scope |
| collection group `courseProgress`: `courseId ==` / `courseId in` (leader views, deletion) | field override `courseProgress.courseId` (COLLECTION + COLLECTION_GROUP) |
| collection group `attempts`: `courseId ==` (leader view, deletion) | field override `attempts.courseId` |
| collection group `guideReviews`: `guideId ==` / `in` | field override `guideReviews.guideId` |
| collection group `pathProgress`: `pathId ==` | field override `pathProgress.pathId` |

The emulator does not enforce indexes, so these were checked by query
inspection, not by a production index error.

### Deployment order (for when this is approved)
> **Superseded** by *Launch checklist — the complete Academy* at the end of this file (v6.11: full function list, functions before rules, Storage CORS, backup, smoke checks, rollback). Kept for history.

Production has **no Academy data yet** (this branch was never deployed), so
there is nothing to migrate there; the legacy-id / free-text-topic notes above
only matter for local or staging data created by earlier builds.

Deploy order (the full sequence, with checks, is under *Deployment checklist*
below):

1. **Storage:** done (2026-11-17): bucket in US-EAST1, CORS for the hosting
   origins.
2. **Indexes:** `firebase deploy --only firestore:indexes` — they build in the
   background; wait until they show *Enabled*.
3. **Functions** (the 12 Academy callables, by name) **before the rules**: the
   new rules route lesson completion, quiz attempts, publish verification and
   category deletion through them, so the rules must never be live without them.
   They are additive: nothing in the current production app calls them.
4. **Rules:** `firebase deploy --only firestore:rules,storage`, after granting
   the Storage service agent the role cross-service rules need (Storage rules
   read Firestore). The new rules are what allow category records to be
   created: `academyCategories/{id}` accepts admin writes regardless of
   content, so there is no chicken-and-egg. (Under the currently deployed rules
   no Academy writes are possible at all — those collections have no allow
   rules — so rules must go before the hosting that uses them.)
5. **Hosting:** `npm run build && firebase deploy --only hosting`, last.
6. **Bootstrap (admin, in the app):** Learn → Manage (or the *Academy workspace*
   shortcut on Admin → Overview) → *Create the starter categories*; then grant *Academy editor* to the right people;
   set up the "Start here" intro video. Course/guide/path writes are rejected
   until category records exist (by design — content must belong to a real category).

Roll-back: hosting can be rolled back in the console; the rules are additive for
Academy collections and don't change any existing (non-Academy) rule.


## v6 — one authoring workspace (draft → preview → publish)

Authoring is one full-page flow instead of tabs and stacked editor sheets:

    Academy (categories) → Category (details, cover, its courses) →
    Course (outline + the selected item's editor) → Preview → Publish

### Routes and entry points
| URL | Screen |
| --- | --- |
| `/learn/manage` | Academy: categories (admins drag to reorder), clean-up banner, link to the secondary tools |
| `/learn/manage/category/:id` · `/new` | Category workspace: name, description, 3:4 cover, visibility, its courses (admins drag to reorder), *Add course* |
| `/learn/manage/course/:id` · `/new?category=` | Course workspace; `?item=<lessonId>` selects an item (deep-linkable, Back/Forward work) |
| `/learn/manage/more` | Quick guides, learning paths and (admins) topics — unchanged editors, moved off the main path |
| `/learn/preview/course/:id[/lesson/:lid]` | The course's DRAFT rendered with the learner components (editors only) |

Entry points: Learn → *Manage*; the *Academy workspace* shortcut on Admin →
Overview; *Manage category* / *Add or edit courses* on a category page; *Edit
course* on a course page; *Edit* on a lesson page. `/admin?section=academy`
(the retired Admin → Academy tab) replace-redirects to `/learn/manage`.
Unknown `/learn/manage/…` paths redirect to `/learn/manage`.

### Permissions (unchanged — no new capabilities)
* Categories (create, rename, cover, hide, delete, category order, course order
  within a category): **admins**. Editors see categories read-only and can add
  courses to them.
* Courses (create, edit, publish, unpublish, archive, discard a never-published
  draft): **Academy editors** (admins included). Permanent course delete: admins.
* Learners can't read drafts, the workspace or the preview; the rules enforce it
  (the UI checks are convenience only).

### Draft / published revision model (`src/academyDrafts.js`)
Live data stays exactly where learners, progress, comments, quiz attempts and
learning paths already point (`courses/{cid}`, `…/lessons/{lid}`,
`…/quizKeys/{lid}`). Authors edit a private copy:

    courseDrafts/{cid}                course fields + module order + rev + publishedRev
    courseDrafts/{cid}/lessons/{lid}  lesson fields + quizKey (answers)

* **Opening writes nothing.** A course without a draft is edited from a copy of
  the live docs; the draft is created on the first change. A new-course screen
  writes nothing until it has a title, cover, text or an item.
* **Autosave** (≈0.8 s after typing) in one transaction that checks `rev`.
  Header states: *Not saved yet* / *Unsaved changes…* / *Saving…* / *Draft saved*
  / *Couldn't save — Retry*. Failed saves keep every edit queued; *Retry* sends
  them. The browser warns before closing with unsaved edits.
* **Concurrent edits:** every write must set `rev = rev + 1` (rules). Another tab
  or editor saving first → *Someone else saved changes* with *Load their version*
  / *Keep mine*. Nothing is overwritten silently.
* **Publish** copies draft → live in one transaction with the **same lesson ids**
  and sets `publishedRev = rev`. Learners see nothing until then; *Publish
  changes* appears only when `rev > publishedRev`. Lessons removed in the draft
  are removed from live (and their discussion deleted after commit); progress
  docs are keyed by lesson id and are untouched.
* **Outline normalisation:** lessons that no section lists (legacy courses) are
  appended exactly as the learner view shows them, so they're visible in the
  workspace and never dropped on publish.
* **Images:** a replaced/removed upload is deleted only when neither the stored
  draft nor the published course references it, re-read from the server at
  clean-up time.
* Uploads for a course that exists only as a draft are allowed (storage rules
  accept `courseDrafts/{cid}` as well as `courses/{cid}`).

### Categories
*New category* creates a **hidden** record with a provisional slug id
(`name-xxxx`) as soon as it has a name or needs an id for a cover — no
save-and-reopen. It stays private until *Make visible*. `courseOrder` (list of
course ids) on the category record sets the order learners see; courses not in
it follow the original order (level, then newest published). Learner and
workspace lists use the same function (`orderCourses`).

### Content types
Video (link + preview + automatic duration), written lesson (formatted editor:
bold, italic, heading, lists, links; stored as the same safe Markdown subset as
before), resource link (paste URL → name/source/type filled in; *Rename* later),
exercise (instructions + optional resources, self-reported completion).
Supporting links on any item never create required steps. Items can be added at
the end or *below* any item; *Add multiple videos* takes one URL per line,
flags invalid/duplicate links, previews and reorders before adding (no
playlists).

### Ordering
Drag handles (≡) with an insertion line, edge auto-scroll and touch support
(handles only, so page scrolling still works). Keyboard: focus a handle, Space
to lift, arrows/Home/End to move, Space to drop, Escape to cancel (announced to
screen readers). Every move offers *Undo*; *Move to position…* is the
non-drag fallback (and the only way to move between sections explicitly).
Moving a course to another category is done with the Category field (applies on
publish) — never by dragging.

### Automatic video duration
* **Vimeo:** `duration` from Vimeo's public oEmbed response (via the existing
  `fetchVideoMetadata` callable).
* **YouTube:** the official IFrame Player API. `getDuration()` returns 0 until
  playback metadata loads, so the editor preview plays **muted** for a moment,
  reads it, then pauses and rewinds. If the value keeps growing it's a live
  stream: marked *Live*, no length stored. 15 s timeout → *unknown*, with
  *Measure again*. No API key and no paid service is used.
* **Google Drive:** no public API → unknown.
* Unknown never blocks saving or publishing. Changing the link clears the old
  metadata; an older in-flight response can't overwrite a newer link's.
* Course runtime = sum of **measured** durations (*At least …* when some are
  unknown); reading/exercise estimates are shown separately.

### Resource metadata — `fetchLinkMetadata` (callable, new)
Editors only. Server-side fetch with: http(s) only, default ports, no
credentials in URLs; DNS resolved and checked **at connect time** (private,
loopback, link-local, CGNAT, metadata and IPv6-local ranges refused); manual
redirects (max 3, each re-checked); 6 s timeout; 256 KB cap. Only `<title>` /
`og:title` / `og:site_name` and the content type are read — the HTML is never
returned or rendered. 401/403/sign-in redirects return *restricted* with no
metadata (private documents are never bypassed); the link is still added with a
filename/host fallback. Custom names are never overwritten.

### Migration / deploy notes for v6 (not run anywhere)
* **No data migration.** Existing courses keep working with no draft; the first
  edit creates one from the live docs. Lesson ids, progress, comments, attempts
  and path references are unchanged.
* New collection `courseDrafts` (+ `lessons`) — rules in `firestore.rules`;
  storage rules updated for draft-only courses. Deploy rules **before** hosting.
* New callable `fetchLinkMetadata` (outbound HTTP from Cloud Functions; no new
  secrets or paid APIs).
* Rule changes to review: live course docs may now be *created* already
  `published` (first publish) — editors could already publish, so no new
  capability; live lesson/quizKey writes check the editor role directly (a
  first publish creates them in the same transaction as the course).
* `scripts/seed.js` now writes the `academyEditor` flag it already declared for
  the demo editor (local data only).


### v6.1 — usability cleanup
* **Admin → Academy removed.** It only held links. Old links redirect (replace)
  to `/learn/manage`; Admin → Overview has an *Academy workspace* shortcut.
* **Undo is single-step** (`src/academyUndo.jsx`). Persisting an order, recording
  a move and reversing it are separate. A move offers one *Undo*; undoing writes
  the previous order once, then shows *Move undone.* with no further Undo. The
  button is disabled while it runs; double clicks can't repeat it; a new move
  replaces the offer; a no-op drop offers nothing; a failed undo says why and
  offers *Try again*; an undo is refused (not applied) if the order changed
  elsewhere since. Same behaviour for categories, courses in a category,
  lessons, sections and item removal.
* **Order writes** (`useReorder`) are serialized and coalesced (only the latest
  pending order is written next). The list shows the requested order until the
  database reports it (no timers, so slow saves don't snap back); on failure it
  shows the saved order with *Try again*. Category and course order are LIVE:
  the UI says learners see it straight away.
* **Dragging** (`academySortable.jsx`): transforms only; the dragged row (or a
  whole section with its items) follows the pointer, other rows slide into place,
  a positioned insertion line marks the slot, edge auto-scroll uses the real
  scroll container, the post-drag click is swallowed, reduced motion disables
  the animation. Sections are draggable (handle on the section row) and have
  *Move to position…*; the old ↑/↓ buttons are gone.
* **Menus** (`academyMenu.jsx`): Add content, item actions and course actions
  render in a portal anchored to their trigger, open upward when needed, stay in
  the viewport, reposition on resize/scroll/content change, and become a bottom
  sheet under 600 px. *Add content below…* opens the five types anchored to that
  row. Choosing a type focuses the new item's first field.
* **Formatted text** (`academyRichText.js`): a visual editor (bold, italic,
  heading, bulleted/numbered lists, links; paste is plain text) storing the same
  Markdown subset. *Edit Markdown source* is a secondary, labelled view. Existing
  text that wouldn't round-trip exactly (e.g. a link with a non-web address)
  opens in source view instead of being rewritten, and nothing is written until
  the author types.
* **Shared fixes outside the Academy:** `BusyButton` stacks its resting and busy
  labels in one grid cell (no width jump, centred icons); `Portal` retries focus
  restoration after a modal's `inert` background lock is released (browsers
  ignore focus() inside an inert subtree, so focus used to fall to the page).

### v6.2 — fidelity, offline status, shared images
* **Literal characters stay literal — with a format version.** Course `about`
  and lesson `description` carry `mdVersion` (absent = 1). **v1 (legacy)** is
  the original parser, unchanged: backslashes are ordinary text, a heading's
  trailing `#`s are stripped — every existing document renders exactly as
  before. **v2** adds backslash escapes (`\*`, `\_`, `` \` ``, `\[`, `\]`, `\#`,
  `\-`, `\.`, `\\` …) and CommonMark heading closers (`# C#` keeps its `#`).
  New courses and lessons are v2. Legacy text is converted only when an author
  EDITS it in the visual view, and only if the converted text renders
  identically (otherwise it opens in source view, unchanged); opening, focusing
  or blurring writes nothing. Editing in source view keeps the text's existing
  version. Quick guides, paths and comments stay v1. No bulk rewrite or
  migration: unedited records never change. Bare web addresses still auto-link.
* **Truthful offline status** — three different situations, never shown as success:
  1. **Refused before starting** (nothing is written; the reason is shown and
     the person's input is kept): publish, preview, unpublish / archive /
     restore, discard, delete, category hide/show, marking a lesson done or a
     guide reviewed, the intro "watched" toggle, comment post / edit / reply /
     pin / delete. These check the connection first. Quiz submission (a server
     call) fails straight away offline and shows the same kind of message;
     answers stay selected.
  2. **Not saved yet, retried automatically** — course DRAFT autosave. Draft
     saves are Firestore transactions, which can't run offline, so nothing is
     queued: the status says *Offline — not saved yet*, the edits stay in the
     open tab (the browser warns before closing it) and are saved on reconnect
     (plus a 20 s retry).
  3. **Already queued, awaiting sync** — plain writes that Firestore accepted
     locally but the server hasn't acknowledged: category name/description edits
     and course/category ordering made while offline, and any write in flight
     when the connection drops (e.g. a lesson-progress update). The status says
     *Offline — waiting to sync* / *Waiting to sync — your progress saves when you
     reconnect*, and nothing is claimed (e.g. course completion) until the server
     acknowledges. In production the queue survives a reload (IndexedDB
     persistent cache); the local emulator setup keeps it in memory only.
* **Shared images.** An image is deleted for a course only if it's in that
  course's own folder AND no other course, course draft, lesson (live or
  draft), quick guide, learning path or category still references it. If that
  check can't run, nothing is deleted and the clean-up stays pending for
  *Retry clean-up*.

**Deploy additions (not run anywhere):**
* `firestore.rules`: `mdVersion` (1 or 2) allowed on courses, course drafts,
  lessons and draft lessons (`validMdVersion`). Deploy rules before hosting.
* `firestore.rules`: `match /{path=**}/lessons/{lid} { allow read: if isAcademyEditor(); }`
  (the reference check's collection-group query; editors could already read every lesson).
* `firestore.indexes.json`: field override `lessons.thumb.path` (COLLECTION + COLLECTION_GROUP).
  Deploy indexes before the client that queries it.
* `storage.rules`: course covers / lesson thumbnails of a course that no longer
  exists (neither live nor draft) may be deleted by an Academy editor. This fixes
  a pre-existing bug: permanent delete removes the Firestore docs first, after
  which every image delete was refused, leaving orphaned files and a clean-up
  that could never finish.

### v6.3 — links, completion, discussion, feedback
* **Contextual link editor** (`src/academyLinkEditor.jsx`, used by every
  formatted field): select text → Link / Ctrl/Cmd+K → a compact popover next to
  the selection (bottom sheet under 600 px). A caret, partial or full selection
  inside a link — or clicking a link while authoring (it never navigates) —
  opens *Edit link* with the current text and address: Update link, Open link
  (new tab, `noopener,noreferrer`), Remove link (text and bold/italic kept),
  Cancel. Selections over several links, or links plus plain text, get an
  explicit choice. Only `https?://` is ever written; inline validation. Actions
  use the browser's editing commands, so Ctrl/Cmd+Z undoes them. Opening or
  cancelling never writes or converts content. The toolbar shows *Edit link*
  while the caret is in a link. The app's global Ctrl/Cmd+K search now ignores
  a keypress a component has already handled (App.jsx).
* **Course completion** (`src/academyCompletion.js`): uses the existing rule
  (all required items, required quizzes passed; bonus never blocks). Completion
  is claimed only from server-acknowledged progress (`useProgress().confirmed`);
  until then "Saving your progress…" / "Waiting to sync". The panel appears on
  the lesson where completion happened (even an earlier one) and on the last
  lesson; a completion seen live is celebrated once per learner+course (a local
  flag), otherwise it's a stable completed state. Next step: if the learner
  came from a learning path — EXPLICIT context: courses/lessons opened from a
  path page carry `?path=<id>`, kept through lesson navigation, Next/Previous,
  quizzes and refresh — and that path is still visible to them and contains
  this course, "Continue learning path" with its next step (opened with the
  same context); otherwise the next accessible unfinished course in the
  category's order, else the existing recommendations. Started paths are never
  used to guess the journey; direct lesson URLs work unchanged (no context); "Back to … courses" / "Explore the Academy" always. At the
  end with work left: "Continue remaining lessons" / "Finish quiz" — the dead
  disabled Next is gone. No emails, certificates or achievements.
* **Discussion:** deleting uses the app dialog (excerpt, consequences,
  Deleting…, recoverable errors, focus to the next comment or the heading).
  Replies are never deleted with their comment: they now stay visible under a
  "Comment deleted" placeholder (before, they silently disappeared — orphaned
  but hidden). A comment deleted elsewhere is reported as already deleted.
  Pinning uses a real pushpin icon with a "Pinned" label, Pinning…/Unpinning…,
  and a short confirmation.
* **Feedback:** posting/saving states, inline recoverable errors (text kept),
  offline actions refused with a plain message instead of hanging, and visible
  errors where actions used to fail silently (lesson done, guide reviewed,
  intro watched, comment edit/pin).

**Rule change (deploy with the rest):** comment `update` (course and guide
comments) now also accepts a pin-only change (`pinned` alone, editors only)
without `editedAt` — pinning used to stamp `editedAt`, so pinned comments
showed as "edited". Existing pinned comments keep their old `editedAt`.

**Limitations:** a learner who opens a course directly (not from the path
page) gets no path suggestion, by design. The celebrate-once
flag is per device (localStorage); another device shows the stable state, not a
second celebration. The quick-guide editor (a secondary tool) still uses a plain
Markdown textarea, not the visual editor.

### v6.4 — lesson progression and finishing a course
Supersedes v6.3's "sequence is guidance only" and its once-per-device
celebration flag. **Its blanket sequential locking is itself superseded by
v6.5 (explicit prerequisites) — see below.**

**Progression rules** (one implementation per side, kept identical by a parity
test: `src/academyProgress.js` `lessonAccess` / `readyToFinish` and
`functions/academyProgression.js`):
* Order = the **published** course's module order, then any unlisted lesson
  (oldest first). Draft reorders change nothing until published.
* A lesson is **complete** when: required quiz → passed (server `earned`);
  otherwise → video watched to the end (YouTube/Vimeo report it) or marked
  complete by the learner (written / exercise / resource, or a Google Drive
  video, which can't report playback).
* A lesson is **open** when it's complete (always reviewable) or every
  **required** lesson before it is complete. The first lesson is always open.
  Optional (bonus) lessons never block and never unlock anything; practice
  quizzes never block.
* **Ready to finish** = every required lesson complete. **Course completed** =
  the learner pressed *Finish course* and the server recorded `finishedAt`.
  Completion is permanent: later edits (new lessons, a new required quiz) and
  un-marking a lesson never remove it.
* **Historical progress:** flags written before v6.4 still count as written —
  nothing is reset. A learner whose requirements were already done sees
  "Ready to finish" (one click), not "Completed", because no finish was
  recorded for them. (Decision for review: alternatively treat them as
  completed.)

**What is server-enforced vs. a learning-flow gate.** All progression-sensitive
writes are server-side:
* `completeLesson` (callable, new) — the only way to record `videoWatched` /
  `manualDone`; refuses a locked lesson ("Complete the earlier lessons
  first."), self-marking a tracked video, self-marking a required-quiz lesson,
  and an unplayable video link (report it instead). Un-marking is allowed for
  self-reported completions only.
* `finishCourse` (callable, new) — every required lesson must be complete;
  transactional and idempotent (double clicks, retries, two tabs → one
  `finishedAt`; later calls get `{ already: true }` with the original date).
* `submitQuizAttempt` — now refuses a quiz whose lesson is still locked.
* Rules — learners can no longer write `lessons`, `earned`, `finishedAt` or
  `finishedRequired` on their progress doc; view/position data moves to a new
  client-written `playback` map. Completion is read from `lessons` only, so a
  value placed in `playback` never counts.

Lesson **content** is not access-controlled by order: a published lesson's
document stays readable by any learner who can see the course (rules can't
evaluate order without a big data-model change). The app doesn't render a
locked lesson (locked view instead: "Go to your next lesson", no content), but
this is a learning-flow gate, not security.

**Learner experience**
* Completion area after the content and quiz, before Discussion: *Complete
  lesson* (written, "Finished reading? Mark this lesson complete to
  continue."), *Complete exercise* / *Mark as reviewed* (explained as a record,
  not an assessment), *Mark as watched* (Drive). Tracked video: the viewing
  requirement and current position, no manual bypass. Required quiz: "Pass
  the quiz to complete this lesson" (no "Mark as read"). Unplayable video: an
  explained blocker plus *Report this problem* (the existing Report-an-issue
  inbox, action `academy content unavailable`); never auto-completed. "✓
  Lesson completed" appears only once the server-written flag arrives. Status
  near the heading.
* *Next lesson* (with the next title) is disabled until the next lesson is open,
  with the reason in text below ("Complete this lesson to continue." / "Pass the
  quiz to unlock the next lesson." / "Watch the video to the end…" / "Saving your
  progress…"). It never navigates on its own.
* Locks show everywhere a lesson can be reached: curriculum (sidebar and
  overview; locked items aren't links), direct URLs / refresh / back-forward
  (locked view), Resume and recommendations (only open lessons), learning-path
  lesson steps (marked locked; they open the course instead).
* Quiz: *Submit answers* / *Submitting…*; a fail explains that the next lesson
  stays locked and how many attempts are left; with no attempts left the learner
  is told to ask their team lead or an Academy editor (there is no in-app reset —
  see limitations).
* *Finish course*: shown on every lesson page and the course overview once
  ready ("All required lessons complete — ready to finish."), with *Explore
  bonus lessons* if optional ones remain. Before then, the last lesson offers
  *Continue remaining lessons* / *Finish quiz*.
* Celebration (only in the tab whose click the server confirmed): "You did
  it!", course title, a warm line, required-lesson count and date, animated
  emblem and a ~1.8 s indigo confetti burst on a non-interactive canvas inside
  the panel; static under reduced motion; focus moves to the heading and a
  polite announcement is made. No sound, redirect or countdown. Refresh,
  revisit or another tab → a calm "Course completed · on <date>" panel.
* *Keep growing*: the explicit `?path=` step → the next open, unfinished course
  in the category → recommendations → navigation only. Finished courses are
  never suggested. *Back to courses* and *Explore the Academy* always.
* Cards / continue learning: "Completed" (finished) vs "Ready to finish"
  (finished courses leave Continue learning; ready ones stay and open the
  overview).
* Editors follow the same order in the learner view (their own progress
  included); the locked view links to the preview, which locks nothing and
  records nothing.

**Compatibility / changes needing approval before deploy**
* `firestore.rules` — `learnerProgress/{uid}/courseProgress/{cid}`: new
  `playback`, `finishedAt`, `finishedRequired` fields; `lessons`, `earned`,
  `finishedAt`, `finishedRequired` are server-only.
* New functions `completeLesson`, `finishCourse` (Node 22, 256 MiB, same region).
* A browser still running a pre-v6.4 bundle after the rules deploy can't save
  progress (its writes go to `lessons`), until it reloads. Deploy functions →
  rules → hosting together.
* No data migration: existing `lessons` flags are read as before; old view data
  left in `lessons` is harmless.

**Limitations:** headless browser QA can't play YouTube to the end, so the
"video ended" step was exercised through the same `completeLesson` call the
player makes. There's no in-app way to grant more quiz attempts (an admin can
delete attempt records in the console). Publishing a reorder can lock a lesson
a learner has viewed but not completed (completed ones stay open). Lesson
content isn't access-controlled by order (see above).

### v6.5 — explicit prerequisites, quiz attempts, historical completion
Replaces v6.4's "every earlier required lesson locks the next one". **Refined
in v6.6** (earlier-lesson rule; broken data is no longer ignored) — see below.

**Two independent settings per lesson** (edited in the lesson's *Completion
and access* section; no separate workflow):
* **Required to finish course** (the existing `bonus` flag, shown inverted).
  Being required never locks anything.
* **Prerequisites** — `prerequisites: [lessonId…]` on the lesson (stable ids,
  so renaming or dragging never changes them). Default: none — "learners can
  open this lesson directly". All selected lessons must be complete. Course
  order is a recommendation only. Every course created before v6.5 has no
  prerequisites (nothing is reinterpreted).

**Availability** (identical client + server, parity-tested): a lesson is open
when it's complete (always reviewable) or all its prerequisites are complete.
A required quiz counts once passed. A failed quiz blocks its own lesson and
lessons that list it — nothing else. Invalid links (self, not in the course,
on a cycle) are ignored at runtime, so a bad configuration can never strand a
learner. Applies to: lesson pages and curriculum (locked items say "complete
“X” first" / "N lessons to complete first"), course overview, Next (follows the
displayed order; disabled with the exact reason + "Go to “X”" / "Or open “Y”"
routes), direct URLs (one prerequisite → "Complete X to unlock this lesson.";
several → a checklist of done / to do / locked with links), Resume and
recommendations (only open lessons), learning-path lesson steps (open the
lesson's locked view; recovery links keep `?path=`), and server functions
(`completeLesson`, `submitQuizAttempt` refuse a locked lesson with the same
sentence).

**Validation** — editor (inline, blocks Publish) and **server**:
self-reference, duplicates, > 20, missing lessons (incl. another course's),
direct and indirect cycles, and an optional lesson that required content
depends on (directly or not: "make it required or remove the dependency").
The picker can't select a lesson that already depends on this one. Server
enforcement: publish calls the new `checkCoursePrerequisites` callable, which
validates the DRAFT and records `{ rev, ok, issues }` in the server-only
`courseDraftChecks/{courseId}`; the rules accept a published lesson that
carries prerequisites only when that verdict is ok **for the draft revision
being published** (any later edit invalidates it). Rules also check shape on
drafts and live lessons (list, ≤ 20, unique, not itself). Draft changes reach
learners only on publish (the course doc also gets a derived
`prerequisiteMap` for screens that don't load lessons).
Deleting a lesson others depend on opens a dialog naming them; it proceeds
only if the author chooses to remove those links too (undo restores both).

**Content gating vs enforcement (unchanged):** locked lesson *content* is an
in-app gate — published lesson docs stay readable by learners who can see the
course, and externally hosted videos are not protected. Progress writes, quiz
submissions, attempt allowances and Finish course are server-enforced.

**Quizzes**
* Multiple-answer questions: checkboxes + "Select all correct answers.";
  single-answer: radios + "Select one answer.". Scoring was already
  exact-match on the server (all correct, nothing else; selecting every option
  never passes) — now covered by tests. Results distinguish *Your answer ·
  correct*, *Your answer · incorrect* and *Correct answer · not selected*
  (icon + text + colour), with the explanations.
* Attempts: new quizzes default to **unlimited**; the editor offers
  Unlimited / Limited (n). Existing limits are untouched. Learners see
  "Unlimited attempts" or "Attempt 2 of 3" before submitting; after a fail with
  attempts left, a prominent **Try again**.
* Exhausted: explained, with *Ask for another attempt* (sends a request to
  Admin → Reports, action `academy attempts request`). Academy editors grant
  attempts from the course's **Learner progress → Details** (`grantQuizAttempts`
  callable: editor-only, 1–10 at a time; stored as
  `attemptGrants.{lessonId} = { extra, history: [{ by, byName, at, count }] }`
  on the learner's progress doc — server-only; attempt records and scores are
  never touched). The learner's open page updates live.
* Idempotent submissions: each attempt carries a client `submissionId`
  (the attempt doc id). A retry of an uncertain request returns the original
  result; a double submit makes one attempt. The allowance is counted inside the
  same transaction that writes the attempt (and the progress doc, which
  serialises concurrent submissions). If a response is lost but the attempt
  landed, the panel recognises its own attempt and shows that result. An earlier
  pass is never removed by a later attempt.

**Reported issue — /learn/course/seed-course-light/lesson/l2:** the demo quiz
is seeded with `retryLimit: 3`. Reproduced as a learner: each submission used
exactly one attempt, every ticked checkbox reached the server (`b1: ["p"]` for
one of the two correct answers → that question incorrect → 50%), and grading
and the review used the same selection. After the third failure the panel
correctly said it was the last attempt — the real defects were: the limit
wasn't shown before attempting, the exhausted state was a dead end (no grant
mechanism existed), missed correct answers weren't labelled, and the server
counted attempts outside its write transaction (concurrent submissions could
exceed the limit). All fixed as above.

**Historical completion (compatibility)** — completions earned before Finish
course existed are kept as **completed**, never "ready to finish". How they're
told apart reliably: since v6.4 every completion flag is server-written, and
since v6.5 every server progress write stamps `progressModel: 2`
(server-only). So a progress doc with every required lesson complete and **no
marker and no `finishedAt`** can only have reached that state earlier → shown as
Completed (no date). The first time a server function touches such a doc (or
Finish is pressed) it records `finishedAt` with `finishedVia: "legacy"` and no
celebration. Caveat: if a course gained required lessons after such a learner
completed it, the old computed completion no longer holds and isn't
reconstructed. Production has no Academy data yet, so no migration is needed;
nothing was migrated anywhere.

**Changes needing approval before deploy**
* Rules: lesson `prerequisites` (shape + verdict check for published lessons);
  `courseDraftChecks/{cid}` (editors read, server writes); course
  `prerequisiteMap`; progress doc server-only `progressModel`, `attemptGrants`,
  `finishedVia`.
* Functions: new `grantQuizAttempts`, `checkCoursePrerequisites`; changed
  `submitQuizAttempt` (submissionId, transactional count, grants, prerequisite
  check), `completeLesson`, `finishCourse` (stamps, legacy).
* No new composite indexes (the in-transaction attempt query uses two equality
  filters on one subcollection, as before).

**Limitations:** the staff grant lives in the course's Learner progress view,
which needs the lead/admin view permission plus the Academy editor role; an
editor who isn't a lead can't see the table. Exhausted-attempt requests arrive in
the general Reports inbox (no dedicated queue). A cycle can only reach published
data if the rules are bypassed (the Admin SDK); learners would then simply not be
blocked by the cyclic links.

### v6.6 — earlier-lesson prerequisites, publish verification, recommended prior knowledge

**Earlier-lesson rule.** A lesson may require only lessons that come BEFORE it
in the full curriculum order (across sections; unlisted lessons follow the
outline, oldest first — the order learners see). The first lesson can't have
prerequisites. This also makes loops impossible. Prerequisites stay stored as
stable lesson ids; "Required to finish course" never creates any.

**Editor.** The picker offers only earlier lessons ("Choose earlier lessons
learners must complete first."; first lesson: "This is the first lesson. No
earlier lessons are available."). Default stays "None — learners can open this
lesson directly." Existing checks remain (missing, duplicate, self, loops,
required-depends-on-optional). Moving a lesson or a whole section (drag or
"Move to position…") is always allowed; if it puts a prerequisite after the
lesson that needs it, the outline shows a notice naming the lessons and marks
each affected lesson ("Prerequisite problem"); the lesson shows the problem with
explicit fixes — *Move this lesson below “X”* (X = its last prerequisite, so one
click fixes every order problem for that lesson; undoable), *Remove “X” from
prerequisites*, and for optional prerequisites *Make “X” required*. Nothing is
removed silently. Publish stays blocked until everything is valid. Draft
changes don't reach learners until publish.

**Publish verification (server).** `checkCoursePrerequisites` validates the
draft in its curriculum order and records, per draft revision, the verdict plus
the exact `modules` and `prerequisiteMap` it judged
(`courseDraftChecks/{courseId}`). Rules:
* a published course whose `prerequisiteMap` is non-empty may be created, or
  have its `modules`/`prerequisiteMap` changed, only if the verdict is ok, is
  for the draft's CURRENT revision, and its `modules` and `prerequisiteMap`
  equal the ones being written;
* a published lesson with prerequisites (new, or changed prerequisites) must
  carry exactly the list the verdict approved for it;
* any draft edit bumps the revision, so a stale verdict authorises nothing.
Updates that don't touch order or prerequisites (unpublish, archive) need no
verdict. Learner access and the server completion checks both read the
published course and lessons.

**Broken data (audit of "invalid links are ignored").** v6.5 ignored invalid
links at runtime, i.e. treated them as satisfied. Now prerequisite data that is
malformed (not a list), self-referencing, pointing to a lesson not in the
course, or pointing to a later lesson marks THAT lesson as broken: it isn't
opened, completed or quiz-graded (server: "This lesson's prerequisites are set
up incorrectly, so it can't be completed until an Academy editor fixes
them."), while every other lesson works and completions already earned stay
reviewable. Learners see "This lesson isn't available right now." with *Report
this problem* (Reports inbox, action `academy prerequisite problem`); the
curriculum says "Unavailable · its setup needs fixing"; editors see a flag on
the course page and the lesson with a link to the workspace. A course with no
prerequisites is unaffected. (With the rules above this state can only come
from writes outside the publish flow, e.g. the Admin SDK/console.)

**Recommended prior knowledge (course level, guidance only).** Course details
→ *Recommended prior knowledge*: search and pick other courses (any category),
removable chips, optional note (≤ 300 chars). Stored as
`priorKnowledge: { courseIds: [≤ 10 unique ids, never itself], note }` on the
draft and, after publishing, on the live course (rules check shape, size,
uniqueness and self-reference). References learners can't see (unpublished,
archived, hidden category, deleted) are flagged in the editor and, for editors,
on the course page. Learners see, after "About this course": "Recommended prior
knowledge — This course assumes some familiarity with the topics below. If you
already have that knowledge, you can start straight away.", links to the
courses they may open, a subtle "Completed" where they finished one, and the
note. Inaccessible references are left out without revealing anything. It never
locks the course, never disables Start course or Finish course, never counts
toward progress, never enrols anyone, and isn't used by learning paths or
recommendations.

**Changes needing approval before deploy (in addition to v6.5's):**
firestore.rules — verdict comparison for courses (`modules`, `prerequisiteMap`)
and lessons (exact list), draft + live `priorKnowledge`; functions —
`checkCoursePrerequisites` (earlier-lesson rule, records modules + map),
`completeLesson` / `submitQuizAttempt` / `finishCourse` (broken-data rule via
academyProgression.js). No new indexes, no data migration.

**Limitations:** the legacy course editor path (direct course/lesson saves
outside the workspace) can't change module order on a course that has
prerequisites without a verdict — the workspace is the supported path.

### v6.6 follow-up — old editing links, leaving the workspace, attempts for editors

**Old course/lesson editing links → the workspace editor** (`legacyEditRedirect`
in `src/nav.js`, replace-navigation so Back doesn't bounce): 
`/learn/manage/course/:id/lesson/:lid`, `/learn/manage/course/:id/:lid`,
`/learn/manage/course/:id/edit`, `/learn/manage/category/:cat/course/:id[/lessons/:lid]`,
`/learn/manage?course=&lesson=` (`?category=` → category workspace),
`/learn/course/:id/edit`, `/learn/course/:id/lesson/:lid/edit`, learner pages
with `?edit` / `?manage`, and `/admin?section=academy&course=&lesson=` all open
`/learn/manage/course/:id?item=:lid` (course + lesson kept; invalid ids fall
back to `/learn/manage`). A non-editor following such a link sees the
workspace notice with *Open the course* / *Open the lesson*. Every visible Edit
button already used the workspace. The unused pre-workspace writers
(`createCourse`, `updateCourse`, `saveLesson`, `deleteLesson`, `getQuizKey`)
were removed, so nothing can save a live course or lesson outside draft →
publish.

**Leaving the workspace with unsaved edits** (`useWorkspaceLeaveGuard`): a link
or breadcrumb while an edit waits to save → saves now, then continues (no
prompt); Back → continues and the draft store saves on unmount (it always did);
when the edit CAN'T be saved (offline, conflict, save error) → "Leave without
saving your latest edits?" with the reason, *Keep editing* / *Leave without
saving* (before, that edit was lost silently). Moving between items of the
same course never prompts. Closing the tab keeps the browser warning.

**"Give 1 more attempt" for Academy editors who aren't leads/admins.** Before,
the grant lived only in *Learner progress*, which needs lead/admin rights, and
learners' requests went to the admin-only Reports inbox — so such an editor
could neither see nor act. Now:
* `quizAttemptStatus` (callable, editors only): for ONE course, learners who
  used attempts on its LIMITED quizzes or asked for more — name, attempts used
  / allowed, extra, passed, out of attempts, request time, last grant. Nothing
  else (no progress, teams or other learner data); rules unchanged, so an
  editor still can't read learner progress or attempts directly.
* Course page → **Quiz attempts** (every Academy editor): requests first, then
  learners out of attempts; *Give 1 more attempt* (`grantQuizAttempts`,
  server-checked, history kept, who/when recorded, request cleared).
  *Learner progress* (leads/admins) now shows attempt counts read-only, so the
  grant lives in one place.
* `requestQuizAttempt` (callable, learner): only when that limited quiz is
  really used up and not passed; recorded as `attemptRequests.{lessonId}` on the
  learner's own progress doc (server-only field). *Ask for another attempt* uses
  it ("Request sent — Academy editors see it on this course's page").
* Leads who aren't editors can still view progress but can't grant (server).

**Concurrency fix:** a duplicate submission racing the original could lose its
transaction (the emulator reports "invalid or closed" instead of retrying) and
surface as INTERNAL. `submitQuizAttempt` and `finishCourse` now re-read after an
unexpected transaction failure and return the recorded attempt / finish, or a
plain "submit again — it won't use an extra attempt".

**Config for approval:** rules — `attemptRequests` added to the server-only
progress fields; functions — new `quizAttemptStatus`, `requestQuizAttempt`;
changed `grantQuizAttempts` (clears the request), `submitQuizAttempt`,
`finishCourse` (race fallback). No new indexes (existing collection-group
indexes on `attempts.courseId` and `courseProgress.courseId`).

**Limitations:** after choosing *Leave without saving* on a blocked Back, the
app goes back one step (a multi-step jump from the browser's history menu lands
one step back). The learner page's discussion composer has no unsaved guard
(unchanged, outside this scope).

### v6.7 — category links, publish readiness, publishing with category visibility

**"Testing 123" did nothing when clicked — root cause.** Categories created in
the workspace get an id of `slug + "-" + 4 random base-36 characters`, which can
contain digits (`test-loy4`). The learner route only matched `[a-z-]{1,40}`, so
`/learn/category/test-loy4` fell through to the catch-all, which
replace-redirects to `/learn`: the URL flashed and the page stayed put, with no
error, no failed query and no console output. The six built-in ids have no
digits, so only new categories were affected. Fix: the route accepts exactly the
ids the rules allow (`[a-z0-9-]{1,40}`); a well-formed unknown or hidden id
reaches the category page, which says "This category isn't available". New ids
are also capped at 40 characters (a long name could produce 45, which the rules
refuse) via `categoryIdFromName`. Category, course, guide, path and continue
cards, recommendation cards and breadcrumbs are now real links (`AppLink`: plain
clicks route in-app; modified clicks, new tab and copy-link work natively).

**Recommended prior knowledge (learner)** renders as compact cards: a portrait
3:4 cover (shared `StoredImage` fallback), title, category, a subtle
*Completed*, and *View course*. One column on phones, two from 700px. It stays
below Start/Resume and never locks or enrols. Only courses the learner can open
are rendered. Editors get a one-line notice, "N recommended course(s) isn't/aren't
available to learners.", with *Review recommendations* →
`/learn/manage/course/:id?item=details&focus=prior` (`focus` is a validated
workspace URL param: `prior | cover | title | category`).

**Searchable picker** (`src/academyPicker.jsx`, used for recommendations and
prerequisites): combobox + listbox like the @mention composer. It opens on
click, typing, ↓ or the chevron (not on Tab-in). A pick adds the item, clears
the query and closes the list, and focus stays in the field without reopening.
Escape, a press outside, or focus leaving also close it. Option presses use
`mousedown` → `preventDefault`, so no blur/outside handler can swallow a
selection. Loading, empty, no-match, already-added and load-failure states are
shown. The list is positioned over the page (not in the flow) and its height is
fitted to the visible viewport (flips above when there's more room there).
Removing a chip returns focus to the field.

**Form polish** (scoped to `.ac-ws` + dialogs): selects draw a chevron from two
small gradients in `--text-muted` (follows light/dark) with 40px trailing space
(native select kept); one input/textarea geometry; quiz questions and
answers use the field styles (they had browser-default padding); stacked
two-column rows under 560px; the sticky header sets `scroll-padding-top` while
it is sticky; "fix" actions scroll only the content pane (not the document).
Quiz editor: visible "Question n" and "Answer option n" labels, an *Answer
options* fieldset with "Select the correct answer." / "Tick every correct
answer…", removal buttons named with the question/option text, and the attempts
hint now points to **Quiz attempts** on the course page.

**What publishing requires (`publishIssues`, the single source for labels,
readiness and the publish check):** course title, an existing category, level,
cover, at least one lesson, every lesson's title, and the prerequisite rules
(unchanged). New this round:
* **a video lesson needs its video link** (`kind === "video"` only);
* **every quiz question needs a correct answer marked**. An unmarked question
  can never be scored correct (`scoreAttempt` requires a non-empty key), so a
  required quiz without one could never be passed.

A quiz with no questions is still "no quiz" everywhere (not an issue). Fields
say "Required to publish" or "(optional)" accordingly. Drafts always save
without them. Field errors appear only after the field was touched or Publish
was tried, and are tied to the control (`aria-describedby`, `aria-invalid`).
`publishBlockers` is now derived from `publishIssues` with the same wording.

**Readiness instead of "Not published".** An unpublished course shows a calm
*Draft* pill (separate from "Draft saved"). A collapsible "N items need
attention before publishing" list groups required information, quiz set-up and
prerequisites. Each item has a fix (e.g. *Add cover* opens Course details and
focuses the upload control). It updates live and can be collapsed but not
dismissed while issues remain. Other states are styled separately: an image
upload in progress (Publish waits for it, `academyUploads.js`), network failure
("nothing was published", retry), permission, conflict, and "published but its
category is hidden".

**Publishing and category visibility** (model unchanged: course
draft/published/archived; category hidden/visible):
* Publishing a valid course in a **hidden** category asks first. Admins choose
  *Publish course and show category* (ONE Firestore transaction:
  `publishCourseDraft(…, { showCategory: true })`, all-or-nothing), *Publish
  course only*, or Cancel. The dialog shows how many other published courses
  showing would reveal, with their titles. Editors without category rights get
  *Publish course* only and are told it stays hidden until an admin shows the
  category. The outcome says exactly what happened ("Course published and
  visible to learners." / "Course published. Its category … is still
  hidden…"), with *View course* and, for admins, *Manage category*.
* **Category workspace → Make visible…** opens a review: already-published
  courses (by their live title) that will become visible; drafts and
  published-with-unpublished-edits courses that *can* be published, each checked
  with `publishIssues` at a pinned revision; not-ready ones explain what's
  missing and link to *Edit course*; archived courses stay hidden. Nothing is
  preselected; *select all ready* is explicit. Buttons: *Show category only* or
  *Publish N selected and show category*. A visible category offers *Publish
  courses…* (no visibility change).
* **Order and failure handling** (`runCategoryPublish`): just before applying,
  every selected course is re-read. A changed revision or new issue stops
  everything ("nothing was published or shown"). Then each course publishes in
  its own transaction pinned to the reviewed revision. The category is shown
  LAST and only if every selected course published. A partial run reports each
  course's outcome and keeps the category hidden, with *Retry failed* (only the
  failed ones, re-checked) and an explicit *Show category now*. Successful
  publishes are never undone.
* **Retry-safe:** `publishCourseDraft` treats "the draft is exactly one
  revision past what I published, and that revision is the published one" as
  `{ already: true }` (lost response / another tab), not a conflict. A
  ref-guard prevents double clicks. `setCategoryHidden` now reads the category
  index inside a transaction instead of trusting a client copy.
* Authorization is still the rules: publishing = Academy editor; category
  visibility = admin. A combined write from an editor is refused as a whole
  (rules test).

**Config for approval:** no rules, functions or index changes. The combined
publish and the fresh-read visibility toggle are client transactions under the
existing rules. Learners will see one behaviour change: existing published
courses keep working, but their **next** publish needs a correct answer on each
quiz question and a link on each video lesson.

**Limitations:** bulk publishing is sequential per course (atomic per course,
not across courses; category last), by design: one transaction for several
courses would be limited by Firestore's rules `get()` budget per request.
`publishIssues` runs in the client and the rules re-check publish shape and
prerequisites. (Superseded in v6.8: the "correct answer" and "video link"
checks are now enforced by the server and the rules too.)

### v6.8 — leaving the editor, server-enforced publish checks, wording

**Leaving the editor** (`backDestination` in `AcademyWorkspace.jsx`). The
workspace header now has a secondary Back action next to *Preview draft*:
* *Back to lesson*: editing a lesson that is published.
* *Back to course*: course details, or a lesson added since the last publish
  (it has no page yet; the button's description says so).
* *Back to category* (its category is visible) or *Back to Academy*: a course
  that has never been published, or is archived.

Back opens the normal learner page as the signed-in editor. It doesn't
publish, complete or restart anything. *Preview draft* opens the draft preview,
which is labelled "Draft preview" and has *Back to editing*. Preview writes no
progress. Edit course / Edit lesson carry a learning path (`?path=`) into the
workspace (`learnManagePath({ path })`, validated id) and back out, and the
learner page validates it as usual. Leaving goes through the existing guard:
pending edits save first; if they can't save (offline, conflict, error) it asks
*Keep editing* / *Leave without saving*.

**Publish checks are now enforced by the server, not only the browser.**
`checkCoursePrerequisites` (name kept) is now the publish check for the draft
revision, and EVERY publish calls it. On top of prerequisites, it validates:
* a supported video-link format for video lessons. Format only: YouTube 11-char
  id, Vimeo numeric id with an optional hex hash, Drive id. A provider being
  unreachable never fails it.
* each quiz question has text, at least two options, and correct answers that
  point at existing options: exactly one for single-answer questions, at least
  one for multiple-answer questions.

The verdict (`courseDraftChecks/{cid}`, readable by editors only, written only by
the server) records per lesson the exact `kind`, `video`, quiz `mode` and
`questions` it approved (`lessonChecks`) and the approved answer keys
(`answerKeys`). It uses the same shaping as the client's publish, so a mismatch
can only refuse. The rules now require:
* a published lesson (create, or a change to kind, video or quiz) to equal
  `lessonChecks[lid]`;
* `quizKeys/{lid}` answers to equal `answerKeys[lid]`;
* a course becoming or staying `published` with content changes to have a
  current passing verdict. Archiving, unpublishing and the category moves made
  when a category is deleted are exempt.

Draft lesson writes must bump the draft revision (unchanged), so a verdict pins
the exact content. This covers single publish, publish + show category, bulk
publish and updates to published courses, which all go through
`publishCourseDraft`. Drafts still save with anything missing. Existing
published courses are untouched until their next publish. A lost-response retry
that hits the check's "draft changed" error is recognised as
already-published.

**Bulk publishing in a visible category.** *Publish courses…* never hides the
category. The result says, for example, "1 of 2 courses published. 1 didn't
publish. The category stays visible, and courses that were already published
are unchanged." *Retry failed* re-checks only the failed course(s). A draft
that changed after the list was opened is never published without a fresh
confirm. Revision numbers were removed from the dialog. "When you confirm: …"
states which courses' latest saved versions publish and whether the category is
shown.

**Wording.** Application copy across learner pages, the workspace, dialogs,
errors and server messages no longer uses dashes as sentence separators, and
names the course, lesson or category where "it" was ambiguous. Saved / published
/ hidden / pending / failed states stay distinct. For example: "Draft saved.
Learners will see these changes after you publish.", "Published, but its
category “X” is hidden, so learners can't see this course.", "Couldn't connect,
so nothing was published… Trying again won't publish twice." User-authored
content (titles, descriptions, lesson text, comments) and the Markdown format
handling were not touched. The seed script's demo labels were updated (affects
future seeding only).

**Config for approval:** rules (lesson, quizKey and course publish now require
the matching verdict) and the `checkCoursePrerequisites` function must deploy
TOGETHER, functions first. With the new rules but the old function, every
publish would be refused because the verdict has no `lessonChecks`. No new
indexes.

### v6.9 — category Back/Preview, deleting courses and categories, upload recovery

**Category editor header:** *Back to category* (visible category → its normal
page) or *Back to Academy* (new or hidden category → `/learn`), *Preview
category*, *Make visible…* (hidden, admins) and a ⋯ menu (*Publish courses…*,
*Hide category…*, a divider, *Delete category…*). Leaving uses the same guard
as courses: pending edits save first; a save that can't happen asks *Keep
editing* / *Leave without saving*. Fixed: the editor used to cancel a pending
save when it closed, so an edit made just before leaving was lost. It now saves
on close, and closing the tab with unsaved edits triggers the browser warning.

**Category preview** (`/learn/preview/category/:id`, Academy editors only, even
while hidden). Categories have no drafts: name, description, cover and course
order save straight to the category. So the label is *Preview category*, and
it shows the SAVED values as learners get them: only published courses, in the
saved order, with the learner empty state. The banner says whether it's hidden
and how many unpublished courses aren't shown, and *Back to editing* returns to
the editor. Previewing never shows the category or publishes anything.

**Deleting a course** (course ⋯ menu, below a divider, apart from Unpublish and
Archive):
* Never published: any Academy editor can delete it (its draft goes).
* Otherwise: admins only. It is never allowed while published (unpublish
  first); the item stays visible but disabled, with the reason.
* The confirmation names the course and lists what goes: lessons, quizzes,
  discussions, draft, own images (shared images are kept) and everyone's
  progress. It also lists learning paths that use the course and courses that
  recommend it as prior knowledge, which keep a reference learners no longer see.
* After deleting, you return to the course's category in the workspace (worked
  out BEFORE deleting), or `/learn/manage` if that category is gone. The
  deleted editor route is replaced in history, and a confirmation names the
  course. If image or progress clean-up is still pending it says so (Retry
  clean-up on the workspace page). Failures stay in the dialog. Deleted URLs
  explain themselves and link to Academy management.

**Deleting a category** (admins): unchanged safeguard. Courses, guides and paths
must be moved to another category first; nothing is cascade-deleted. On success
you land on `/learn/manage` with "Deleted the category … N items were moved to
…", and the deleted route is replaced.

**Server:** `courses/{cid}/lessons` and `quizKeys` deletes now need an admin, or
an editor publishing (the course doc rewritten in the same write). Before, a
non-admin running the delete steps could remove a course's lessons before being
refused at the course doc. Course delete stays admin-only and never while
published (rules test).

**Uploads recover instead of hanging** (`uploadImage`, `ImagePicker`):
* No progress for 20 s, or 90 s overall, means the task is cancelled with "The
  upload stopped responding, so the image wasn't saved. Your image is still
  selected. Try again." *Cancel upload* is available while uploading.
* Nothing references the file until the upload succeeds.
* A late result from an abandoned attempt is ignored and its file removed.
* The rest of the editor stays usable.

**Local emulator incident (Storage hung):** before restarting I exported
Firestore, Auth and Storage (`firebase emulators:export`, which reads Storage
from the hub's memory). I checked the export: 29 Storage objects (size + MD5),
every image referenced in Firestore present, 8 Auth accounts with passwords, and
a 347-document canonical Firestore snapshot. Then I restarted with `--import`
and verified the restore: 0 document differences, all 29 objects download
intact, and sign-in works.

**Config for approval:** rules (lesson / quizKey delete). No function or index
changes this round.

### v6.10 — deleting a category: move or delete its courses (or a mix)

Supersedes "every course must be moved first". Admins only.

**Choose** (`src/academyCategoryDelete.jsx`). Nothing is preselected:
* *Move all courses to another category* (one destination).
* *Delete this category and all its courses*.
* *Choose what happens to each course*: every course filed here (published,
  unpublished, archived, with unpublished changes, draft-only) with its cover,
  title, status, Move/Delete and a destination. There is a shared destination
  with per-course overrides, and bulk Select all / Move selected / Delete
  selected with the selected count shown.

Quick guides and learning paths filed here are a separate section and are never
deleted. Each gets an explicit destination; paths can also keep "No category".
Every item needs a choice before review. A course published in another category,
with only its draft filed here, can be moved but not deleted from here. Hidden
destinations are explained. With no other category, moving says to create one
first. Choices are kept in the browser session, so they survive leaving to
create one. An empty category gets a simple confirmation.

**Review:** the exact sentence ("Delete “Photography”, move 3 courses to
“Filmmaking” and permanently delete 2 courses."), each course title by
destination and status, and what deleting removes versus what moving keeps.
It also lists draft-category conflicts (the draft keeps its own category unless
"Also use this category for its unpublished changes" is ticked), learning paths
and prior-knowledge references to deleted courses (they show as unavailable;
nothing is marked complete), and guides/paths. The final button is specific
("Move 3 courses and delete 2 courses" / "Delete category and 5 courses"), with
"The category “X” is also deleted." beside it.

**Run** (`runCategoryDeletion`, order deliberate):
1. **`lockCategoryForDeletion` (callable, admin).** The server re-reads every
   live course, draft, guide and path filed under the category and compares
   them with the review: ids plus a per-course fingerprint of status,
   categories, draft revision and last publish. Any difference means nothing
   happens and the admin reviews again. It then validates the plan and locks
   the category (`deleting: { planId, plan, by, byName, at }`). Re-sending the
   same plan is a no-op.
2. **Each item with the existing services.** Moves (`moveCourseCategory`) keep
   ids, lessons, keys, attempts, progress, comments, images and references, and
   move the draft too with a revision bump. Moves never publish, restore or
   show anything. Deletions use `deleteCourseHard`, the existing service and
   clean-up, including the shared-image check.
3. **Destination order.** Moved courses are appended in their old order, and
   the destination's current order is saved first so nothing there moves.
4. **`finalizeCategoryDeletion` (callable, admin).** It deletes the record only
   when NOTHING is filed under it any more, and is idempotent.

**Server enforcement (rules):**
* While locked, nothing can be filed under the category: no create, move in,
  publish or draft autosave of a course, guide or path. `validCategory` refuses
  a locked category.
* An admin may delete a PUBLISHED course only when its category is locked for
  deletion. Everywhere else it's still "unpublish first", and never editors.
* `deleting` is server-written only, and category records are deleted by the
  server only.

**Partial failure:** the category stays and stays locked. The dialog lists what
moved (with links to the destinations), what was deleted and what's still to
do, with **Retry remaining**, which re-reads and handles only what's left
(moved items are already gone from here, deleted ones are gone). Closing leaves
a banner on the category with "Finish or stop…". *Stop and keep the category*
(`cancelCategoryDeletion`) unlocks it; deleted courses stay deleted, moved ones
stay moved. Pending image or progress clean-up is reported separately from
failure. On success you land on `/learn/manage` with "Deleted the category “X”.
Moved N courses and permanently deleted M courses.", and the route is replaced
in history.

**Config for approval:** rules (category lock in `validCategory`, published
delete inside a locked deletion, server-only `deleting` and record deletion)
and three new callables (`lockCategoryForDeletion`, `finalizeCategoryDeletion`,
`cancelCategoryDeletion`). Deploy the functions with or before the rules: with
the rules alone, admins couldn't delete categories at all. No new indexes;
`category in […]` equality queries are single-field.

### v6.11 — Tips & resources: private drafts, a full-page editor, ordering, deletion

"Quick guides" are now **Tips & resources** everywhere people see them (stored
as `guides`, unchanged ids). A resource is a video link, some text, or both.

**Drafts.** `guideDrafts/{id}` (editors only) is the working copy; `guides/{id}`
is what learners read. Every save bumps `rev` (stale tabs get a conflict).
Publishing copies the content fields verbatim from the draft in one transaction
that sets `publishedRev = rev`. The rules require the published content to equal
the draft (one draft read + one map diff over the content keys), a supported
video id (`strictVideo`), and a video OR some text. Unpublish / archive /
restore and category moves are status-only changes and exempt. Learners' records
carry no draft or revision data. Discard deletes the draft only: the published
version, reviews and discussion stay. Legacy resources (no `mdVersion`) keep
their text untouched until it's actually edited; publishing one that has no
draft yet creates the draft from the record first.

**Workspace** `/learn/manage/guide/:id` (also `new?category=`): breadcrumbs,
status + save state, Back to resource / category / Academy, Preview draft
(`/learn/preview/guide/:id`), Publish / Publish changes, ⋯ (View published,
Unpublish, Archive, Restore to draft, Discard unpublished changes, Delete — only
for never-published resources, or admins once unpublished). Fields: Title and
Category (required), video link (optional: metadata, measured length, source or
custom 16:9 thumbnail; a custom title is never overwritten), formatted text with
the link popover ("Text", or "Notes (optional)" for a video), supporting links
with automatic titles, topics. Text resources get an optional reading estimate;
there is no manual video duration. Old edit links (`/learn/guide/:id/edit`,
`?edit`, `/learn/manage/guides/:id/edit`, `/learn/manage?guide=`) redirect,
keeping `?path=`. Deleting returns to the category workspace.

**Category workspace:** a *Tips & resources* section (16:9 thumbnail or text
icon, type, status, unpublished changes, edit), *Add tip or resource*, an empty
state, drag + keyboard ordering and *Move to position* (admins). The order is
`academyCategories.guideOrder` and the learner category page uses it.
*Publish content…* / *Make visible…* group courses and tips & resources, select
nothing for you, show readiness, re-check the exact revision before applying,
and report partial failures in "items".

**Category deletion** now covers resources: grouped rows, bulk selection across
both, three explicit choices, separate counts ("Move 2 courses and 3 resources.
Delete 1 course and 2 resources. Delete the category “X”."), learning paths that
include a deleted resource are named (the step shows as unavailable). The server
fingerprints resources (live + draft) like courses; moves keep ids, reviews,
discussion and the draft (with a revision bump); deletion removes discussion,
reviewed records (admin, once the resource is gone), the draft and own images
(shared images are kept). `finalizeCategoryDeletion` reports only id/title of
anything still filed under the category.

**Found and fixed while verifying v6.11**
* **Launch-blocking:** publishing a video resource with metadata/thumbnail/links
  was refused for everyone ("maximum of 1000 expressions"): the old rule read the
  draft 12 times and compared nested maps field by field. Now one read + one map
  diff. Regression test: *a REALISTIC video resource … publishes within the
  rules' expression budget*.
* The learner category page crashed when opened directly ("Rendered more hooks
  than during the previous render"): two hooks ran after early returns.
* Save errors showed rules-engine text ("evaluation error at L925…"); now
  "the server refused the change. You may no longer have editing access, or its
  category is being deleted" (courses and resources).
* Phone pages scrolled sideways where a visually hidden file input sat inside a
  field (`.sb-field input` out-ranked `.sb-vh`); `.sb-vh` is now `!important`.
* Resuming a stored deletion plan that lacks a section (e.g. written before
  resources existed) crashed; missing sections are filled.
* Wording: "selected item(s)" in mixed publish results; the resource thumbnail
  hint no longer says "lesson"; the learning-path editor says "Tip or resource";
  search placeholder; shortcut labels say Cmd on a Mac.
* Test isolation: the rules suites now take the emulator address `emulators:exec`
  exports; `npm run test:academy` runs its Storage emulator with its own TMPDIR
  (every Storage emulator otherwise shares `$TMPDIR/firebase/storage/blobs` and
  deletes it on exit — that wiped the dev emulator's files once during this work).

**Launch-readiness audit (bounded).** Verified = checked in the browser or by
tests with real accounts; nothing claims real video *playback* (headless
Chrome; only the metadata lookup — title, author, duration — was exercised).

| Area | Result |
| --- | --- |
| Entry points / legacy editors | Verified: no code path opens the old guide dialog; all old links redirect. |
| States (draft-only, published, unpublished changes, unpublished, archived, legacy) | Verified; legacy-without-draft publish **fixed**. |
| IDs / routes | Verified: ids kept through moves; manage/preview/learner routes; `?path=` kept. |
| Hidden content | Verified: drafts/archived never on learner pages; hidden categories hide resources and their thumbnails (Storage test). |
| Recovery | Verified: offline status, leave prompts (offline / failed save), reconnect saves, conflicts, partial publish + retry, deletion resume. Save-error wording **fixed**. |
| Uploads | Verified: draft-only thumbnail upload/read/clean-up rules; own vs shared image deletion. |
| Video | Verified: strict ids on publish, metadata + duration, custom title kept. **Fixed** the publish budget. Playback not verified. |
| Prerequisites / quiz / finish / paths | Re-run suites green (unit 603, UI 333, functions 222, rules 298 + academy/Storage 66). Path editor wording **fixed**; deleted resource steps show unavailable. |
| Keyboard / mobile / theme | Verified: keyboard reorder, Tab order, 390 px with no sideways scroll (**fixed**), light + dark screenshots. |
| Learning-path editor | Inspected: picker shows category + status; wording fixed. |

**Status: NOT launch-ready (see *Launch readiness* at the end).** Local data: the owner-approved selective recovery
was applied on 2026-11-13 (“Testing 123” and “what's popping”: 9 documents, 2
images, create-only, verified identical to the 12:15 backup); demo content, “er3r”
and QA fixtures were deliberately not restored. The learning-path regression
and the My Work issue below were fixed in round 4. Still open: the launch
blockers in *Launch readiness* at the end (Storage/billing decisions, manual
Vimeo and Google Drive playback checks).

**v6.11 follow-up (review round 2) — corrections and fixes**
* *Category-deletion review (was a blocker).* Correction: while the impact check
  was loading, the confirm button WAS disabled (it only looked faded); but a
  FAILED check enabled it, and a slow check from an earlier review could fill a
  newer one. Now: discovery is tied to the exact review (a token); any failed
  lookup shows "Couldn't check which learning paths and recommendations use
  these items… Nothing has been deleted." with **Retry**, and the button stays
  disabled with the reason beside it; confirm runs the reviewed snapshot (plan,
  plan id, reviewed contents) and the server re-checks it (`lockCategoryForDeletion`
  fingerprints) — if anything changed, nothing runs and the admin reviews again.
  UI tests: delayed, failed + retry, stale, confirm-sends-reviewed-plan.
* *20,000 characters.* The server already enforced it on drafts AND published
  copies (course `about`, lesson `description`, resource `body`); now proven by a
  rules test at the boundary (20,000 ok, 20,001 refused, empty drafts still
  save). The client now names an over-long field in the publish checklist
  ("Shorten …") instead of failing as "You don't have permission".
* *Never-published resources in learning paths* — a regression from v6.11
  (before it, a new guide was a `guides/{id}` record with status `draft`, so the
  path picker listed it). **Fixed (round 4):** the path editor merges editors'
  `guideDrafts` into the picker (`pathPickerGuides`, labelled “not published yet”,
  with a note that learners see the step as unavailable until it's published).
  Learners still read only published records; the step shows as unavailable with
  no draft title or text, and appears once the resource is published (browser
  journey W23 in the isolated environment).
* *My Work (outside the Academy)* — **correction:** the round-2 note said a live
  QA-flag change crashes My Work. Reproduced with disposable accounts in the
  isolated environment, it does NOT crash: `Mine`'s early return came before ANY
  hook, and React only reports “fewer hooks” when at least one hook ran; on the
  way back it mounts the hooks fresh. Impact was a silent reset of My Work's
  local state and a rules-of-hooks violation that would crash as soon as a hook
  is added above the return. **Fixed:** `Mine` only chooses the view
  (`Reviews` / `MyAssignments`). Also found and fixed in the same flow: the
  sidebar's sliding indicator stayed on the old “My Work” row after a live
  switch to reviewer (its layout effect didn't depend on the reviewer flag).
  Browser journey W22 (both directions, indicator position).
* *Test isolation.* `test/emulatorGuard.js`: suites that clear data refuse the
  real project id and any non-throwaway id (Storage also checks the bucket);
  `npm run test:academy` / `test:emulator` pass `--project demo-…`; the Storage
  suite already had its own TMPDIR. Verified with a controlled experiment (two
  throwaway Storage emulators): with its own TMPDIR a second emulator leaves the
  first one's objects intact; sharing it reproduces the wipe.
* `firestore-debug.log` is written to the working directory by every Firestore
  emulator, so running test emulators from the repo overwrites the dev
  emulator's debug log (diagnostic only).

### Known issue (left for later)
* **Admin → Content → card "More actions" → Move to Trash → Cancel:** focus
  doesn't return to the card's "More actions" button. The app's `KebabMenu`
  closes (unmounting the clicked item) in the same render that opens the
  confirm dialog, so the dialog has no trigger to restore to. Pre-existing:
  identical with the original overlay code. Fix idea: focus the kebab button
  before running the item's action (as the Academy menus do with `refocus`).

## Launch readiness (round 4, 2026-11-16) — blockers first, then the checklist

Nothing has been deployed and no cloud configuration has been changed.

### Status at a glance (2026-11-17)

**Completed automated checks (real, local isolated emulators; Chromium headless).**
* Unit 626 / UI 377 tests; production build.
* Browser journeys w19–w32 on the current code, including: the full learner
  journey (Learn → category → course → lessons → required and practice quizzes
  → finish, path context), images (slow / failed / recovered, lazy loading,
  sign-out revocation), caches and access (live publish / unpublish / hide /
  delete, cover replacement, account switch with downloads pending, live editor
  role removal), the mobile shell (header, badges, both bottom sheets incl.
  touch-drag dismissal, Back, focus), row dots (swipe, trackpad, keyboard,
  reduced motion, long / single / empty rows), safe bottom spacing.
* REAL YouTube player → app completion: headless Chrome, desktop 1440×900 and
  phone emulation 390×844 (the player's own end event; nothing simulated).
* Google Drive: embedding + the learner's "Mark as watched" → manual completion.
* "Phone" means Chromium phone emulation (viewport, touch, coarse pointer),
  never Safari or a device.

**Simulated checks (labelled in their output).**
* w29 learning journey: the 3.5-minute video's completion is sent directly as
  the learner instead of playing it to the end (the real path is covered by
  w24 above).
* Touch gestures are DevTools synthetic touch events; slow / failed image
  responses are intercepted in the browser (Storage itself unchanged).

**Blocker found after launch (2026-11-17): "Create the starter categories"
fails in production.** The deployed writer (`d3ae810`) spread each starter
record, `id` included, into the document; `validCategoryRecord` doesn't allow
`id`, so the whole batch is refused even for an admin, and the button swallowed
the rejection (Learn kept showing the built-in fallback categories, which look
the same). Production has 0 category records. Fixed on
`fixes/academy-mobile-performance`: `src/academyBootstrap.js`
writes only the allowed fields in a transaction that creates only missing
categories (retries and concurrent attempts are safe; existing edits are never
touched) and resolves only after the server commits; the workspace shows
"Creating categories…", an actionable error with Try again, and success only
after confirmation; a failed category read shows an error, never the empty
state. Verified with the real writer against the rules
(`test/academyBootstrap.rules.test.js`) and the real button in the isolated
environment. Rules unchanged.

**Outstanding — real device / real video (manual).**
* **Installed iPhone web app, soft header controls (reported 2026-11-17): NOT
  resolved, awaiting device verification.** Branch
  `fixes/academy-mobile-performance` makes the mobile header solid (no
  `backdrop-filter`): nothing scrolls beneath the header, so the blur had no
  visual purpose, and the filtered header layer is the only persistent rendering
  difference between the header and the content. Chromium pixel comparisons
  (light/dark, 320–430 px, 3×) show the same layout and colours (≤2/255), and
  ordinary Simulator Safari renders it crisply — neither proves the installed
  app is fixed. Verify on the device after release.
* iPhone + Safari: both bottom sheets (open, drag down from the handle or
  header, Back, safe areas, landscape, internal scrolling), the bottom bar with
  the home indicator, the on-screen keyboard (bottom bar steps aside), row
  swiping with the moving dots and vertical page scrolling, the edge swipe for
  Back over a row, the YouTube walkthrough (Round 8 section).
* iOS Simulator (Xcode 26.0, iOS 26.0.1 runtime, iPhone 17): Simulator Safari
  reached all isolated services; YouTube in Simulator Safari: real playback and
  end-event completion passed; playback started muted by script. Touch-style
  checks remain manual (click-and-drag in the Simulator), because:
  * XCUITest gestures: macOS 27.2 refuses to load Xcode 26.0's `DTServiceHub`
    (kernel AMFI: "com.apple.DTServiceHub disallowed without correct
    com.apple.private.amfi.version-restriction entitlement version"), so the
    test runner never connects. Developer mode (DevToolsSecurity) is not the
    cause shown by the logs; a newer Xcode would be needed.
  * Simulator Safari WebDriver is paused. Observed 2026-11-16: with
    `safaridriver -p 4723`, Apple's `com.apple.WebDriver.HTTPService` (PID
    16921) also opened its WebDriver BiDi listener on port 8080 (its log:
    "BiDi Port: 8080"; `lsof`: `*:8080`; Network.framework labelled the
    listener "local only"). Started 22:29:15, stopped by PID at about 22:31:32
    (with safaridriver, PID 16895); since then 8080 and 4723 have no listener.
    It collided with the dev Firestore port's number only: the dev emulators
    were not running, and nothing shows that any data was reachable or read.
    `safaridriver -b <port>` sets the BiDi port; whether that removes the
    listener or its all-interfaces binding is untested and needs a separate,
    approved check before any further Simulator automation.
  * A Simulator pass is still not a physical-iPhone result.
* Vimeo (video 76979871): real playback to the end is unverified. In
  automation, vimeo.com shows a "Verify to continue" check and the embed in
  headless Chromium reports `ready`, `play`, then `drminitfailed` without
  progress (an automation/browser limitation, not treated as a failure). The
  app now handles Vimeo's documented `error` event: the player shows the
  problem with Try again, "Open original on Vimeo" stays, the completion card
  explains that watching on Vimeo can't complete the lesson here and offers
  Report; slow loading (no `ready` after 15 s) gets neutral guidance and Try
  again; blocked autoplay gets "Press play"; a failure clears only on real
  playback (`playing`, time > 0 or `ended`). Covered by simulated player events
  (`src/academyVimeo.ui.test.jsx`, `vimeoEventKind` unit test) and a Chromium
  check with one simulated error; no completion was written in any of them.
* Google Drive with a real "anyone with the link" video: plays, then Mark as
  watched completes it.
* The Storage rules deploy's IAM grant (blocker 1), with the approved release.

### Launch blockers — need your input or a manual check
1. **Storage: resolved (2026-11-17).** The production bucket
   (`<project>.firebasestorage.app`, US-EAST1) exists, is linked to Firebase
   and has CORS for the two Hosting origins; `.env.production` pins it and the
   production build fails without it. Still to do at deploy time: the Storage
   rules deploy asks to grant the Storage service agent the role it needs for
   cross-service rules (they read Firestore); without that grant, image reads fail.
2. **Vimeo is deferred for this launch.** Its error handling stays in place
   (failure message with Try again, "Open original on Vimeo", Report, no
   completion without the end event). Real playback to the end is unverified.
3. **Google Drive playback is unverified.** No real shared Drive video was
   available. Manual check: with a real Drive video shared as "anyone with the
   link", confirm it actually plays in the lesson, then use **Mark as watched**.
   Drive reports no playback events, so it is NOT expected to complete on its
   own; completion is always the learner's manual action.

4. **iPhone/Safari is unverified.** All mobile checks ran in Chromium phone
   emulation (no WebKit browser or physical iPhone was available). Before
   launch, check on a real iPhone (Safari): the account and notification bottom
   sheets (safe areas, drag down from the handle/header, Back, internal
   scrolling), the bottom bar with the home indicator, typing with the
   on-screen keyboard (bottom bar steps aside), swiping a row while scrolling
   the page and the moving dot indicator, the edge-swipe-back gesture over a
   row, and video playback.

### Round 5 (2026-11-16) — mobile experience

* **Bottom bar:** Home, My Day, Workflow, My Work, Learn (QA reviewers keep
  their own Reviews, Workflow, Learn). Profile left the bar. Five equal items,
  44px+ targets, 11.5px labels that wrap rather than shrink, selected = capsule
  + weight + `aria-current`. Learn stays selected on every course, lesson,
  resource, category, browse and Academy-management route; Team/Admin (reached
  from the menu) select nothing.
* **Header (phones):** IFC Creatives Board (compact IFC mark under 360px),
  Notifications, the profile avatar (opens the existing profile sheet), and a
  Menu (`?panel=menu`): Appearance (Match system / Light / Dark, one tap),
  Search, New content (admins; Workflow), Team, Admin (with the pending-
  approvals count that used to sit on Profile, also in the Menu button's
  accessible name), Profile & settings, What's new, feature request, Report an
  issue, Sign out. One panel at a time, Back/Escape/scrim close it, focus
  returns to the trigger, other URL parameters (e.g. `?path=`) are kept.
* **Floating New (workflow) button:** no longer on Learn/Academy screens (it
  created Workflow content); elsewhere the page reserves room under it. Academy
  creation stays contextual (Add category / course / tip or resource / content).
* **Learn landing:** compact head (Manage beside the title, search on its own
  row), one Continue learning shortcut, a compact introduction (small 16:9
  thumbnail, two-line summary, Watch introduction primary, Edit intro as a small
  admin link, a one-line "watched" state with Watch again), Explore categories
  and For you as horizontal rows on phones/tablets (portrait 3:4 covers, next
  card peeks, gentle snap, buttons for pointer/keyboard, Browse all/View all),
  grids on desktop. Progress bars only when there is progress.
* **Blank category covers (diagnosis):** the covers existed in Storage; the
  grey boxes were the *loading* skeleton. The dev Storage emulator's
  rules-checked endpoint (`/v0/…`, used by browsers) stopped answering while its
  admin endpoint still answered — every image request waited forever. App fix:
  image loads time out after 15s into the branded fallback, failures aren't
  cached (next view retries), and loading / no cover / failed / loaded are
  distinct (`data-img`). The dev emulator itself needs a restart (not done; it
  holds your recovered data — back up first).
* **Course page:** small cover beside the title on phones, primary action full
  width. **Catalogue grids:** two columns only when each card keeps ~9.5rem
  (follows the user's text size), else one.
* **Keyboard:** while a text field has focus on a phone, the bottom bar steps
  aside so the field and its actions stay visible.
* **Testing scope:** Chromium phone emulation (touch, coarse pointer) at 320,
  390, 430px, landscape, 150% text, light/dark; no WebKit browser is installed
  here and no real iPhone/Safari was used — treat iOS Safari as unverified.

### Round 6 (2026-11-16): one account menu, header Search, row dots

This round replaces parts of the Round 5 header and rows above.

* **One account menu** (`AppMenu.jsx`, URL panel `?panel=profile`). The mobile
  avatar and the desktop sidebar profile button both open it. The hamburger,
  the `?panel=menu` panel, the old profile sheet (`ProfileDrawer.jsx`, removed)
  and the separate Appearance sheet are gone.
  * Contents: the avatar, name, role and email at the top, then three groups.
    * Preferences: Appearance (Match system / Light / Dark) and Notification
      preferences, which opens the settings form. The bell still opens the inbox.
    * Manage: New content (when allowed), Team, and Admin (admins only).
    * Help: What's new, Submit feature request, Report an issue.
  * Sign out sits last, below a separator. Each item appears once. There is no
    Edit profile item, because the app has no profile editor.
  * Behaviour on phones: the menu is modal, fits the visible viewport and safe
    areas, and scrolls inside. Close, Escape, a tap outside and Back all close
    it. Focus returns to the avatar and `?path=` is kept.
  * Behaviour on desktop: a non-modal popover beside the sidebar.
* **Header (phones):** brand, then Search, Notifications, and the avatar
  ("Open account menu"). Search is left out only on the Learn landing and the
  Academy catalogue (`/learn/browse`, except All categories), because those
  pages have their own Academy search field. Every other page shows it,
  including Learn sub-pages. `/` and Ctrl/Cmd+K still open global search, and
  the editor still claims Ctrl/Cmd+K for links.
* **Approval badge:** the admin pending-approval count is a gold badge on the
  avatar, separate from the bell's red unread count. The avatar's name explains
  it: "Open account menu. 2 accounts waiting for approval".
* **One panel at a time:** opening a panel while another is open now swaps it,
  so closing it returns to the page instead of reopening the previous panel.
* **Fixed (existing bug):** the `/` and Ctrl/Cmd+K listener kept the first
  page's navigation helpers. After moving around inside the app, it could open
  Search over the first page visited. It now always uses the current page.
* **Row dots** (`academyRow.jsx`, maths in `academyRowPages.js`):
  * The arrow buttons and the visible scrollbar are gone. Native swipe and
    trackpad scrolling and the next-card peek are unchanged.
  * Centred dots under each row; the current one is drawn as a pill.
  * Groups are measured from the rendered cards. They are re-measured on resize,
    orientation change, text-size change and content change, and the last group
    always ends on the final cards.
  * No dots when everything fits.
  * Each dot is a 28×32px button labelled "Show category group 2 of 4", with
    `aria-current` and a visible focus ring.
  * At most 7 indicators show at once. For longer collections the window slides
    and the dots at its ends shrink.
  * Reduced motion jumps instead of scrolling smoothly. There is no autoplay or
    looping.
  * Desktop keeps the grids and shows no dots. For you is now a grid on desktop
    too.
* **Section headers:** title on the left, View all on the right.
  * Explore categories → View all opens **All categories**
    (`/learn/browse?view=categories`), which lists every visible category as
    cards.
  * "Browse all courses" is a separate link at the bottom of Learn and of All
    categories.
* **Cards:** category counts sit on the card's bottom edge, so they line up
  across a row. Descriptions are clamped at two lines.
* **Testing scope:** same as Round 5. Chromium phone emulation and CDP
  synthetic touch only. iPhone/Safari is unverified, including the
  edge-swipe-back gesture over a row.

### Round 7 (2026-11-16): consistency, loading performance, mobile layouts

Work happened in a separate source copy served only to the isolated test
environment; checked changes were then copied into the repo in dependency
order (no half-finished code reached the running dev server).

**Header and sheets**
* One attention badge for the bell (unread notifications) and the avatar
  (accounts awaiting approval): same red, 18px, upper-right, 9+ cap, ring.
  Meanings stay in the controls' accessible names; zero hides the badge.
* One phone bottom-sheet foundation (`useSheet` in overlay.jsx) for the
  account menu and the notification panel: slides up, handle at the top, close
  button at the header's end, drag DOWN from the handle or header to dismiss (a
  drag that starts on a button/field/label is ignored; scrolling the content
  never dismisses), slides down on close; Escape, outside tap and Back behave
  the same; focus returns to the trigger; reduced motion = no slide. Desktop is
  unchanged (popover / side drawer).

**Loading performance** (see "Loading measurements" below)
* Editing code (workspace + editors) is its own chunk; learners no longer
  download it. The Learn code is prefetched a few seconds after the app loads
  (or when Learn is pointed at / touched). Code only: no Academy data is read
  until Learn opens.
* Firestore listeners for Academy reads are shared and linger 60s after the
  last reader unmounts (`academyCache.js`): Back and revisits render at once
  from the last data while the listener keeps it current; two components
  reading the same thing share one listener. Same user, same rules.
* Learn renders each section on its own readiness (categories need only the
  taxonomy; counts, Continue and For you arrive with courses + progress; a
  Continue placeholder is reserved only for returning learners). The course
  page shows its title and cover as soon as the course record arrives.
* Images: requested only when near the viewport, at most 4 downloads at once,
  one request per path; already-loaded covers show instantly on remount; the
  object-URL cache is bounded (120, never evicting an image in use; evicted
  URLs revoked) and dropped on sign-out / account change. Timeout and failure
  states are unchanged (failures are never cached). Storage stays
  authenticated (getBlob under storage.rules); nothing was made public.
* The optional course preview video is a labelled poster until played (no
  provider player or scripts load before that).
* Not changed: covers are stored at 900×1200 (≈60–115 KB) and shown at
  ≈96–220 CSS px. A smaller thumbnail variant would need a second upload
  rendition; left as a follow-up.

**Layouts**
* Category page (phones): small 3:4 cover beside the title and counts, the
  description full width below, Manage category as a secondary link; the course
  list starts on the first screen. Cards on a category page don't repeat the
  category label (mixed lists still show it).
* Learn: intro keeps one primary action (Watch introduction), "Explore Heart of
  Serving" as a short text link, Edit intro quiet, a three-line summary with
  Show more when it's actually cut off; Manage can't crowd the title.
* Course page: compact cover + title; topics, time, actions and progress span
  the width below. Start / Resume / Review stays the main action; Edit course is
  a secondary link; "View lessons" jumps to the curriculum.
* Cards: a started course (Start pressed or a lesson opened) with nothing
  completed shows "In progress" instead of an empty bar or "0% complete".
* Lesson (phones): one row with Back to the course + the lesson list, the 16:9
  player right below; a compact status by the title (Completed / Optional);
  one completion area; the big "Lesson completed" confirmation appears only
  when completed during that visit (revisits show the small status only;
  the course-finish celebration is unchanged); resources as tappable rows
  (title, site, external marker; no extra fetching); one quiet discussion
  empty state.

**Copy and durations**
* Completion copy now follows the explicit prerequisites: it says completing
  (or passing) unlocks the next lesson only when that lesson requires this one.
  No sequential gating was added.
* Course time (`courseTimeFacts`): required lessons only, video time and
  reading/exercise estimates separate, "N videos (length not known yet)" or
  "At least …" when lengths or estimates are missing, bonus lessons summarised
  separately. Video lengths are never invented.

**Development Storage emulator (confirmed root cause in round 8; dev not restarted)**
* Symptom: every signed-in (rules-checked) Storage read hangs; admin reads and
  exports still work.
* Cause (evidence in the emulator logs): the Storage rules runtime
  (cloud-storage-rules-runtime v1.1.3, firebase-tools 13.35.1) wrote two
  protocol messages in one output chunk (a result + a `fetch_firestore_document`
  request made for the `firestore.get()` in storage.rules). The emulator logged
  them as one unparsed line, so the request was never answered and every later
  rules evaluation queued behind it. Dev: request 457 (scratchpad emu2.log);
  the isolated environment hit the identical signature (request 882) and was
  cured by an export + restart. A local emulator defect, not app code and not
  production. Confirmed in round 8 by the emulator source
  (firebase-tools `lib/emulator/storage/rules/runtime.js`): every stdout chunk
  from the rules runtime is passed to ONE `JSON.parse`; a chunk holding two
  messages fails to parse, is logged at INFO and dropped (both messages), which
  is exactly the logged line. It recurred three times in the isolated
  environment under heavy test load (the last during the round 8 regression,
  requests 1508/1509); each time an export + restart cured it.
  The app's 4-downloads-at-a-time limit does not prevent it.
* Recovery (for you to run): export the dev emulators to a new dated folder;
  verify it (Firestore snapshot diff, image references vs. Storage metadata);
  stop and restart the dev emulators with `--import` of that export; check an
  authenticated cover read returns promptly and browse Learn. Keep backup2 and
  the other backups untouched. Consider a newer firebase-tools after reading
  its release notes. The app's 15s image timeout keeps pages usable meanwhile.

### Loading measurements (round 7)

Isolated environment (demo-academy-e2e emulators on a Mac), production builds
served by `vite preview`, Chromium phone emulation 390×844, learner account.
Seed covers replaced with 900×1200 JPEGs (64–101 KB) matching real uploads.
Throttled = 1.6 Mbps down / 750 kbps up / 150 ms RTT + 4× CPU slowdown.
Timings end on DOM readiness conditions (titles present; every on-screen image
loaded or in a deliberate none/failed state). Median of 3 runs.
Caveats: the emulators use Firestore's memory cache (production uses the
persistent cache, so real repeat visits can be faster); emulator Storage rules
checks are serialized (~100 ms per image), so absolute image times overstate
production.

Text = titles/navigation usable; Covers = on-screen images settled. ms.

| Step | Throttled before → after: text | covers | Unthrottled before → after: text | covers |
|---|---|---|---|---|
| Learn, first visit (tapped right after sign-in) | 1389 → 796 | 6378 → 3443 | 115 → 79 | 1264 → 584 |
| Learn, first visit after 4 s on Home (Learn code prefetched) | 1360 → 313 | 6357 → 2948 | n/a | n/a |
| Learn → category | 307 → 72 | 1598 → 1332 | 71 → 57 | 365 → 546 |
| Category → course | 422 → 258 | 426 → 261 | 68 → 68 | 69 → 69 |
| Course → lesson | 446 → 59 | 448 → 66 | 62 → 44 | 64 → 45 |
| Back to course | 387 → 20 | 390 → 22 | 36 → 18 | 37 → 20 |
| Back to category | 266 → 16 | 269 → 1277* | 46 → 9 | 47 → 494* |
| Back to Learn | 298 → 21 | 306 → 32 | 48 → 13 | 50 → 18 |
| Learn again later (same tab) | 510 → 60 | 514 → 65 | 92 → 60 | 94 → 61 |
| Full reload of /learn | 2329 → 1805 | 7055 → 4390 | 114 → 95 | 1264 → 580 |

Requests on the first Learn visit: images 10 (924 KB) → 5 (440 KB); Learn
code 145 KB → 78 KB (gzip, transferred); Firestore listen targets 14 → 12, and
revisits re-subscribe almost nothing (e.g. Back to course 5 → 0–1). Every
image download still needs a CORS preflight because getBlob sends an
Authorization header (unchanged; inherent to authenticated reads).
\* Back restores the scroll position; the newly visible covers are different
ones (offscreen before, so never requested), which is the lazy loading working.
One step got slower: unthrottled "Learn → category" covers rose 365 → 546 ms
(throttled they fell 1598 → 1332). That page now makes fewer image requests
(4 → 2), but each request starts only after the card renders and reports
being on screen. The exact split wasn't measured further.

### Round 8 (2026-11-16): verification gaps closed

**YouTube: what was really verified.** The real-player journey (w24) uses a
19-second public video (jNQXAC9IVRw), headless Chrome launched with
`--autoplay-policy=no-user-gesture-required --mute-audio`. It reads the
provider's own `<video>` element inside the iframe (frames decoded, clock
advancing), and passes only if the PLAYER's end makes the APP send its own
`completeLesson(how: "video")` and progress records `videoWatched`; nothing
calls completion directly. It passed in rounds 5, 6 and 7 (desktop 1440×900)
and in round 8 against the current code, on desktop and in phone emulation
(390×844). The round 7 learning journey (w29) uses a 3.5-minute video and sends
the completion directly to save time: that step is SIMULATED and is labelled so
in its output. Its earlier note that a real ended signal "can't happen headless"
was wrong. Not verified: a physical device / Safari, and Vimeo (blocked in
automation, see the launch blockers).

Manual walkthrough (real browser, any device):
1. Sign in as a learner; open a course with a short YouTube lesson that has
   another lesson after it.
2. Tap the poster, then play the video to the end without skipping.
3. Expect, within a few seconds of the end: "Lesson completed" appears once
   (the full confirmation, because it was completed during this visit), the
   status by the title reads Completed, and Next lesson is enabled if it
   depended on this lesson.
4. Reload the lesson: only the small Completed status shows (no second
   confirmation), and the course page counts the lesson as done.

**Shared data and image caches: limits and lifetimes** (`src/academyCache.js`)
* Listeners: one per query/document key, shared; a listener whose readers have
  all left lingers 60 s, then closes; at most 40 idle listeners are kept (the
  oldest closes at once beyond that). Listeners in use are never closed by
  these limits.
* Images: object-URL LRU of 120 (covers are ≈60–115 KB, so ≈12 MB at most);
  images on screen are never evicted; evicted URLs are revoked. At most 4
  downloads at once; a queued download for an image that left the screen is
  withdrawn before it starts.
* Sessions: sign-out, a different account, or a change to the account's
  access (role, approval, editor, lead, disabled) starts a new session: every
  listener closes, every object URL is revoked, and late snapshots or
  downloads from the old session are discarded (never cached). It runs before
  the new session's screens subscribe.
* Access: every listener runs as the signed-in user under the rules, so
  unpublishing, hiding or deleting reaches open pages as an update or a
  permission error; a listener that stopped on an error clears its content and
  is restarted for the next reader, so a cached copy is never shown after
  access ends. Covers are cached by storage path; a replaced cover has a new
  path and loads fresh.
* Covered by `academyCache.test.js` (unit), `academyImageStates.ui.test.jsx`
  (queue withdrawal, late download after sign-out, failure then retry) and the
  w31 browser journey (live publish/unpublish/hide/delete, re-publish, cover
  replacement, sign-out with downloads pending then another account, live
  editor-role removal).

**Header badges:** both badges overhang the corner of their 44px control by
the same 5px (top and end), measured from each control's outer edge, for one
digit and 9+, at 320 and 390px, both themes and 150% text; an 8px gap keeps a
badge clear of the next control. The accessible names stay distinct ("…,
N unread" for the bell; "Open account menu. N accounts waiting for approval"
for the avatar).

**Category covers (a performance trade-off, kept):** measured interleaved,
same conditions, 5 runs unthrottled / 3 throttled (median):

| | Learn covers | Category covers | Category requests |
|---|---|---|---|
| Before round 7 (unthrottled) | 1261 ms | 361 ms | 4 |
| Round 7–8 (unthrottled) | 564 ms | 548 ms | 2 |
| Before round 7 (throttled) | 6358 ms | 1598 ms | 4 |
| Round 7–8 (throttled) | 3461 ms | 1333 ms | 2 |

Request traces show the visible covers are requested when the page renders
(≈60 ms after the tap; no observer, priority or queue wait). The time is the
emulator's rules check, which handles requests one after another (≈230 ms
each). Before round 7 those covers had already been downloaded by the Learn
page, along with everything else. Learn + category together is faster
(1622 → 1112 ms unthrottled), so the trade-off stays; an attempt to start
on-screen images a frame earlier gained nothing measurable and was reverted.

**Dots:** the dot window is a viewport onto a track holding every dot; the
track slides when the window moves, so the pill moves continuously instead of
jumping one slot (dots outside the window are disabled and hidden from
assistive technology).

### What was verified with a real player (and what wasn't)
* **YouTube — real player (headless Chrome):** the provider's own `<video>`
  element decoded frames (320×240) and its clock advanced ~1 s per second (0 →
  17.9 s over 19 samples, "Me at the zoo", 0:19); at the end the app itself sent
  `completeLesson(how: "video")` and progress recorded `videoWatched`. No
  completion function was called by the test.
* **Vimeo — not verified** (above). **Google Drive — manual completion only**
  (by design: Drive reports no playback).
* Known limitation (unchanged): the server trusts the client's report that a
  tracked video ended (`how: "video"`); it can't observe playback. Seeking to the
  end counts, as the provider's own "ended" does.

### Deployment checklist

Production has **no Academy data** and has never run this branch: nothing to
migrate. Run every step against the production project explicitly
(`firebase use <prod-alias>` / `--project`), never an emulator config.

**0. Decisions** — the Storage items in *Launch blockers* above; who becomes
Academy editor.

**1. Back up (before any change).** Firestore: `gcloud firestore export
gs://<backup-bucket>/pre-academy-<date>` (tasks, users, notifications etc. —
the existing app data). Also the Auth users (with the project's password-hash
parameters, kept privately, never in Git) and the currently deployed rules
(read them from the Rules API / console history: production's Firestore rules
came from `release/stage-a`, not `main`) and the hosting release id. Verify
the export finished successfully and record checksums.

**2. Indexes** — `firebase deploy --only firestore:indexes`; wait for *Enabled*.
Composite `courses(status, category)` and `guides(status, category)`; field
overrides (COLLECTION + COLLECTION_GROUP) for `courseProgress.courseId`,
`attempts.courseId`, `guideReviews.guideId`, `pathProgress.pathId`,
`lessons.thumb.path`. Everything else is single-field/automatic.

**3. Storage bucket + CORS** — done 2026-11-17: the default bucket is in
US-EAST1 with `GET` CORS for the two hosting origins, and `.env.production`
pins it (the production build fails without it).

**4. Functions — deploy BEFORE the rules** (the rules route lesson completion,
quiz attempts, publish verification and category deletion through them):
`firebase deploy --only functions:submitQuizAttempt,functions:completeLesson,functions:finishCourse,functions:grantQuizAttempts,functions:quizAttemptStatus,functions:requestQuizAttempt,functions:checkCoursePrerequisites,functions:fetchVideoMetadata,functions:fetchLinkMetadata,functions:lockCategoryForDeletion,functions:finalizeCategoryDeletion,functions:cancelCategoryDeletion`
(nodejs22, `northamerica-northeast1`). `fetchVideoMetadata` / `fetchLinkMetadata`
make outbound requests (YouTube/Vimeo oEmbed, link previews). Existing
non-Academy functions are unchanged by this branch (they still need their
`RESEND_API_KEY` secret, as today).

**5. Rules** — first grant the one IAM role cross-service Storage rules need
(project-level `roles/firebaserules.firestoreServiceAgent` for the Firebase
Storage service agent; it holds only `datastore.entities.get`). The Firebase CLI
offers this grant interactively but silently skips it with `--non-interactive`,
so grant it explicitly. Then `firebase deploy --only firestore:rules,storage`.
Academy collections have no allow rules in production today, so nothing
Academy works until this step; the one non-Academy change only tightens sign-up
(a new user can't set `academyEditor`).

**6. Hosting** — `npm run build && firebase deploy --only hosting`.
`index.html` is `no-cache`, assets are immutable. Old clients: production never
shipped Academy UI, so no old client writes Academy data.

**7. Bootstrap (admin, in the app):** create the starter categories, grant
*Academy editor*, set the "Start here" video.

**8. Smoke checks (production, real accounts):** hidden category → text and
video resources (custom thumbnail) → preview → publish → *Make visible…*;
learner sees them in order, marks reviewed, comments; private edit → learner
unchanged → *Publish changes*; a course: publish, play a YouTube lesson to the
end (completes on its own), (Vimeo is deferred for this launch; Drive only if a launch course uses it), take a quiz, finish; add a not-yet-published resource to a learning
path (learner sees "unavailable", then the step after publishing); images load
(CORS); learners can't open `/learn/preview/…` or a hidden category; delete an
empty test category and check the review waits for its impact check; console
has no "Missing or insufficient permissions" or "requires an index" errors.

**9. Rollback:** hosting → previous release in the console; rules → redeploy
the saved previous rules; functions → redeploy the previous source or delete
the new callables (additive); indexes can stay; data → the step-1 export.

**Production / test safety (verified locally, round 4):** the production build
contains no emulator hosts, ports or test project ids (checked on the
2026-11-16 build). Emulator addresses in `src/firebase.js` are configurable
(`VITE_EMULATOR_*`, dev only, removed from production builds) so an isolated
app instance can run beside the dev one. `scripts/seed.js` refuses a non-demo
`SEED_PROJECT_ID` and an isolated project without explicit, non-dev emulator
hosts. Every emulator test script runs through `scripts/emulator-test.mjs`: a
demo-* project, ports that can't overlap the dev emulators, its own working
directory under `.emulator-test-tmp/` (so debug logs never overwrite the dev
ones), a private short TMPDIR (Storage blobs; the Functions emulator's Unix
socket must stay under macOS's 104-character limit), and a test-only dummy for
declared secrets (email sending stays off in the emulator). Destructive suites
also refuse the real project id (`test/emulatorGuard.js`).

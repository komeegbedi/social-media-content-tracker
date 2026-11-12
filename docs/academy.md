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

## Quick guides
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
started "Light & Composition"). Password `password123`.

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
Production has **no Academy data yet** (this branch was never deployed), so
there is nothing to migrate there; the legacy-id / free-text-topic notes above
only matter for local or staging data created by earlier builds.

1. **Storage:** enable the bucket in the Firebase console (may require the
   Blaze plan — billing decision), set CORS for the hosting origins.
2. **Indexes:** `firebase deploy --only firestore:indexes` — they build in the
   background; wait until they show *Enabled*.
3. **Rules:** `firebase deploy --only firestore:rules,storage`. The new rules
   are what allow category records to be created: `academyCategories/{id}`
   accepts admin writes regardless of content, so there is no chicken-and-egg.
   (Under the *currently deployed* rules no Academy writes are possible at all —
   those collections have no allow rules — so rules must go first.)
4. **Functions:** `firebase deploy --only functions:submitQuizAttempt,functions:fetchVideoMetadata,functions:fetchLinkMetadata`.
5. **Hosting:** `npm run build && firebase deploy --only hosting`.
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
* **Truthful offline status.** Course drafts (transactions, which can't queue
  offline): *Offline — not saved yet*; edits are kept in the tab and save
  automatically on reconnect (plus a 20 s retry); the browser warns before
  closing. Category edits and ordering: *Offline — waiting to sync* until the
  server acknowledges. Publish and Preview are disabled offline; unpublish,
  archive, discard, delete and category visibility refuse to start offline.
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

### Known issue (left for later)
* **Admin → Content → card "More actions" → Move to Trash → Cancel:** focus
  doesn't return to the card's "More actions" button. The app's `KebabMenu`
  closes (unmounting the clicked item) in the same render that opens the
  confirm dialog, so the dialog has no trigger to restore to. Pre-existing:
  identical with the original overlay code. Fix idea: focus the kebab button
  before running the item's action (as the Academy menus do with `refocus`).

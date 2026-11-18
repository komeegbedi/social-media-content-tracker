/* IFC Creative Academy — ordering helpers (pure). Items are always moved by
   their STABLE id; nothing is re-created, so comments, quiz attempts,
   progress and learning-path references stay attached. */

/* Move one id to a final index (index in the list AFTER removal). */
export function moveId(ids, id, toIndex) {
  const from = ids.indexOf(id);
  if (from < 0) return ids.slice();
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(toIndex, rest.length));
  rest.splice(at, 0, id);
  return rest;
}
export const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/* ---- Sections ---------------------------------------------------------------
   The outline is `course.modules` = [{ id, title, lessonIds }] — the same shape
   the publish check, the rules and learners use (no new fields, no migration).
   • A module WITH a title is a named SECTION. It's shown as a section in the
     workspace and to learners, even when it's the course's only section.
   • A module WITHOUT a title holds lessons that are in NO SECTION. Learners see
     those lessons without any heading; the workspace labels the area "No
     section". New courses start with one such module (m1), so a course needs no
     sections at all.
   • "No section" is never created as a named section, and named sections are
     never merged, renamed or removed automatically. */
export const NO_SECTION = "__none";
export const isNamedSection = (m) => !!String((m && m.title) || "").trim();
export const namedSections = (modules) => (modules || []).filter(isNamedSection);
/* First untitled module anywhere (legacy helper; null = none). */
export const noSectionModule = (modules) => (modules || []).find((m) => !isNamedSection(m)) || null;
/* "No section" as a DESTINATION always means the top of the course: the first
   module when it's untitled (reused — even if it's empty), else a new untitled
   module created there only when a lesson actually goes in. */
export const topNoSectionId = (modules) => ((modules || [])[0] && !isNamedSection(modules[0]) ? modules[0].id : NO_SECTION);
/* → [modules, id] of the top No-section module (created at index 0 only if needed). */
export function ensureNoSection(modules, newId = () => "m1") {
  const top = topNoSectionId(modules);
  if (top !== NO_SECTION) return [modules, top];
  let id = newId(); while ((modules || []).some((m) => m.id === id)) id = newId() + "x";
  return [[{ id, title: "", lessonIds: [] }, ...(modules || [])], id];
}
/* A new section's default name: "Section N", unique among the named sections. */
export function defaultSectionName(modules) {
  const names = new Set(namedSections(modules).map((m) => m.title.trim().toLowerCase()));
  let n = namedSections(modules).length + 1;
  while (names.has(`section ${n}`)) n += 1;
  return `Section ${n}`;
}
export const addSection = (modules, id, title) => [...(modules || []), { id, title, lessonIds: [] }];
export const renameSection = (modules, id, title) => (modules || []).map((m) => (m.id === id ? { ...m, title } : m));
/* Remove section `id` by its stable id. Its lessons (order kept) go to `dest`:
   NO_SECTION (the top) or another section's id. An empty section just goes. */
export function removeSectionTo(modules, id, dest = NO_SECTION, newId) {
  const sec = (modules || []).find((m) => m.id === id);
  if (!sec) return modules;
  const moved = sec.lessonIds || [];
  let rest = modules.filter((m) => m.id !== id);
  if (!moved.length) return rest;
  let target = dest;
  if (target === NO_SECTION || !rest.some((m) => m.id === target)) [rest, target] = ensureNoSection(rest, newId);
  return rest.map((m) => (m.id === target ? { ...m, lessonIds: [...(m.lessonIds || []), ...moved] } : m));
}
/* The places a lesson can go, in curriculum order, as authors name them:
   No section (top) — always offered; every named section; and every OTHER
   untitled module that holds lessons (an older course can have lessons outside
   sections between two sections), named by its position. Empty internal
   untitled modules are not destinations (they're invisible). */
export function lessonDestinations(modules) {
  const mods = modules || [];
  const top = topNoSectionId(mods);
  const others = mods.filter((m, i) => !isNamedSection(m) && (m.lessonIds || []).length && !(i === 0));
  const out = [{ group: top, label: others.length ? "No section, at the top" : "No section", count: top === NO_SECTION ? 0 : (mods[0].lessonIds || []).length, area: true }];
  mods.forEach((m, i) => {
    if (isNamedSection(m)) out.push({ group: m.id, label: m.title.trim(), count: (m.lessonIds || []).length, area: false });
    else if (i > 0 && (m.lessonIds || []).length) out.push({ group: m.id, label: ungroupedLabel(mods, m.id), count: m.lessonIds.length, area: true });
  });
  return out;
}
/* "No section" for the top area; "No section, after “Exposure”" for an area
   further down (or "before “…”" when no section precedes it). */
export function ungroupedLabel(modules, id) {
  const mods = modules || [];
  const i = mods.findIndex((m) => m.id === id);
  if (id === NO_SECTION || i <= 0) return "No section";
  const prev = mods.slice(0, i).reverse().find(isNamedSection);
  if (prev) return `No section, after “${prev.title.trim()}”`;
  const next = mods.slice(i + 1).find(isNamedSection);
  return next ? `No section, before “${next.title.trim()}”` : "No section";
}

/* The outline as one flat list of rows (what the workspace renders and drags):
   • no named sections → just the lessons, in order;
   • otherwise, per module in order: a named section → "module" header + its
     lessons, or one "empty" row (its drop target); an untitled module WITH
     lessons → "none" header (No section) + its lessons. EMPTY untitled modules
     are stored compatibility structures and produce no rows at all.
   Dragging a lesson above the first header means "No section, at the top"
   (the list shows a labelled destination there while dragging). */
export function outlineRows(modules) {
  const mods = modules || [];
  const rows = [];
  const lessonRow = (lid, m) => ({ type: "lesson", id: lid, moduleId: m.id, group: m.id });
  if (!mods.some(isNamedSection)) {
    for (const m of mods) for (const lid of m.lessonIds || []) rows.push(lessonRow(lid, m));
    return rows;
  }
  for (const m of mods) {
    const named = isNamedSection(m);
    const ids = m.lessonIds || [];
    if (!named && !ids.length) continue;
    rows.push({ type: named ? "module" : "none", id: `${named ? "module" : "none"}:${m.id}`, moduleId: m.id, group: m.id, title: m.title || "" });
    for (const lid of ids) rows.push(lessonRow(lid, m));
    if (!ids.length) rows.push({ type: "empty", id: `empty:${m.id}`, moduleId: m.id, group: m.id });
  }
  return rows;
}
const isHeader = (r) => r && (r.type === "module" || r.type === "none");
/* Where a lesson lands when it sits at flat position `slot` among `rest` (the
   rows without it): the group of the last header before the slot; above every
   header → No section at the top; with no headers at all → the group of the
   lesson just above (else the first one). Plus its index in that group. */
export function lessonTarget(rest, slot, fallbackGroup = null) {
  const at = Math.max(0, Math.min(slot, rest.length));
  let group = null;
  for (let i = 0; i < at; i++) if (isHeader(rest[i])) group = rest[i].group;
  if (group == null) {
    if (rest.some(isHeader)) return { group: NO_SECTION, index: 0 };
    const prev = rest.slice(0, at).reverse().find((r) => r.type === "lesson");
    group = prev ? prev.group : (rest.find((r) => r.type === "lesson")?.group ?? fallbackGroup);
  }
  let index = 0;
  for (let i = 0; i < at; i++) if (rest[i].type === "lesson" && rest[i].group === group) index += 1;
  return { group, index };
}
/* Move lesson `id` into `group` (a module id, or NO_SECTION = the top) at `index`. */
export function moveLessonToGroup(modules, id, group, index = null, newId) {
  let mods = modules, target = group;
  if (group === NO_SECTION) [mods, target] = ensureNoSection(modules, newId);
  return moveLessonToModule(mods, id, target, index);
}
/* Apply "lesson `id` now sits at flat row position `toIndex`" (an index among
   the rows WITHOUT that lesson) to the module structure. */
export function moveLessonInOutline(modules, id, toIndex, newId) {
  const rest = outlineRows(modules).filter((r) => r.id !== id);
  const own = (modules || []).find((m) => (m.lessonIds || []).includes(id));
  const { group, index } = lessonTarget(rest, toIndex, own ? own.id : null);
  return moveLessonToGroup(modules, id, group, index, newId);
}
/* Words for a pending drop — beside the insertion line and announced to
   keyboard users: “Move to “Light”, position 2”, “Move to No section…”. */
export function describeDrop(modules, row, slot, rest) {
  if (row.type === "module") {
    const named = rest.slice(0, slot).filter((r) => r.type === "module").length;
    return `Move section to position ${named + 1} of ${namedSections(modules).length}`;
  }
  const { group, index } = lessonTarget(rest, slot, row.group);
  if (!rest.some(isHeader)) return `Move to position ${rest.slice(0, slot).filter((r) => r.type === "lesson").length + 1} of ${rest.filter((r) => r.type === "lesson").length + 1}`;
  const m = (modules || []).find((x) => x.id === group);
  return m && isNamedSection(m) ? `Move to “${m.title.trim()}”, position ${index + 1}` : `Move to ${ungroupedLabel(modules, group)}, position ${index + 1}`;
}
/* The group (module id or NO_SECTION) a pending lesson drop targets — highlighted while dragging. */
export const dropGroup = (row, slot, rest) => (row.type === "module" ? null : lessonTarget(rest, slot, row.group).group);
/* Explicit "Move to section" (keeps it out of accidental drags). */
export function moveLessonToModule(modules, id, moduleId, index = null) {
  return modules.map((m) => {
    let ids = (m.lessonIds || []).filter((x) => x !== id);
    if (m.id === moduleId) { ids = ids.slice(); ids.splice(index == null ? ids.length : Math.max(0, Math.min(index, ids.length)), 0, id); }
    return { ...m, lessonIds: ids };
  });
}
/* Insert a new lesson after `afterId` (or at the end of `moduleId`). */
export function insertLesson(modules, id, { afterId = null, moduleId = null } = {}) {
  if (!modules.length) return [{ id: "m1", title: "", lessonIds: [id] }];
  if (afterId) {
    const host = modules.find((m) => (m.lessonIds || []).includes(afterId));
    if (host) return modules.map((m) => m.id !== host.id ? m : { ...m, lessonIds: (() => { const ids = m.lessonIds.slice(); ids.splice(ids.indexOf(afterId) + 1, 0, id); return ids; })() });
  }
  const target = modules.find((m) => m.id === moduleId) || modules[modules.length - 1];
  return modules.map((m) => m.id === target.id ? { ...m, lessonIds: [...(m.lessonIds || []), id] } : m);
}
export const removeLesson = (modules, id) => modules.map((m) => ({ ...m, lessonIds: (m.lessonIds || []).filter((x) => x !== id) }));
export const lessonPosition = (modules, id) => {
  const flat = (modules || []).flatMap((m) => m.lessonIds || []);
  return { index: flat.indexOf(id), count: flat.length };
};
/* Course order inside a category: the explicit order (set by dragging in the
   workspace) first; courses it doesn't mention yet follow in the Academy's
   original order — level (beginner → advanced), then newest published, then
   oldest created. Learners and the workspace use this same function, so what
   an editor arranges is exactly what learners see. Items may be live course
   docs or workspace rows ({ level, publishedAtMs | publishedAt, createdAtMs }). */
const LEVEL_RANK = { beginner: 0, intermediate: 1, advanced: 2 };
const msOf = (v) => (v == null ? 0 : typeof v === "number" ? v : v.toMillis ? v.toMillis() : v.seconds != null ? v.seconds * 1000 : v instanceof Date ? v.getTime() : 0);
export function orderCourses(courses, courseOrder = []) {
  const pos = new Map((courseOrder || []).map((id, i) => [id, i]));
  return [...(courses || [])].sort((a, b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Infinity, pb = pos.has(b.id) ? pos.get(b.id) : Infinity;
    if (pa !== pb) return pa - pb;
    return (LEVEL_RANK[a.level] ?? 1) - (LEVEL_RANK[b.level] ?? 1)
      || (b.publishedAtMs ?? msOf(b.publishedAt)) - (a.publishedAtMs ?? msOf(a.publishedAt))
      || (a.createdAtMs ?? msOf(a.createdAt)) - (b.createdAtMs ?? msOf(b.createdAt))
      || String(a.title || "").localeCompare(String(b.title || ""));
  });
}

/* Move a whole SECTION (module + all its lessons, same ids) to `toIndex` among
   the sections. Lesson membership never changes, so nothing is re-created. */
export function moveModule(modules, moduleId, toIndex) {
  const ids = moveId(modules.map((m) => m.id), moduleId, toIndex);
  return ids.map((id) => modules.find((m) => m.id === id));
}
/* "Move section to position…": `namedIndex` counts NAMED sections only. Named
   sections are reordered among themselves; untitled modules (No section) keep
   their places. */
export function moveSectionAmongNamed(modules, id, namedIndex) {
  const order = moveId(namedSections(modules).map((m) => m.id), id, namedIndex);
  let k = 0;
  return (modules || []).map((m) => (isNamedSection(m) ? modules.find((x) => x.id === order[k++]) : m));
}
/* From an outline drag: the section block was dropped at `slot` among the rows
   that remain after removing that block. It goes right before the module whose
   header comes next (or last). Uses the MODULE list, so modules that have no
   rows (empty untitled ones) never skew the position. */
export function moduleIndexFromSlot(rows, moduleId, slot, modules = null) {
  const rest = rows.filter((r) => r.moduleId !== moduleId);
  if (!modules) return rest.slice(0, slot).filter((r) => isHeader(r) && r.moduleId).length;
  const others = modules.filter((m) => m.id !== moduleId);
  const next = rest.slice(slot).find(isHeader);
  return next ? others.findIndex((m) => m.id === next.moduleId) : others.length;
}
/* Rows that travel with an outline row when dragged: a section header carries
   its lessons (and its empty-state row); a lesson moves alone. */
export function outlineSpan(rows, index) {
  const r = rows[index];
  if (!r || r.type !== "module") return 1;
  let n = 1;
  while (index + n < rows.length && !isHeader(rows[index + n])) n += 1;
  return n;
}
/* Where a dragged outline row may land (slot = index among the remaining rows):
   • a section only at group boundaries, never above a No-section area at the top;
   • a lesson anywhere inside a group; above the first header only when that
     header is a named section (that spot = "No section, at the top"; when a
     No-section area is already at the top, its first position is the same
     place); an empty section offers ONE slot (just under its header). */
export function outlineCanDrop(row, slot, rest) {
  if (row.type === "module") return slot === rest.length || rest[slot]?.type === "module" || (rest[slot]?.type === "none" && slot > 0);
  if (row.type !== "lesson") return false;
  if (slot === 0 && rest[0]?.type === "none") return false;
  if (slot > 0 && rest[slot - 1]?.type === "empty") return false;
  return true;
}

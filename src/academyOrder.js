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

/* The course outline as one flat list of rows: a header per module (when the
   course uses modules) followed by its lessons. Dragging a lesson to a flat
   position moves it into whichever section that position falls in. */
export function outlineRows(modules, { showHeaders = (modules || []).length > 1 } = {}) {
  const rows = [];
  for (const m of modules || []) {
    if (showHeaders) rows.push({ type: "module", id: "module:" + m.id, moduleId: m.id, title: m.title });
    for (const lid of m.lessonIds || []) rows.push({ type: "lesson", id: lid, moduleId: m.id });
  }
  return rows;
}
/* Apply "lesson `id` now sits at flat row position `toIndex`" (index after the
   lesson is removed from the flat list) to the module structure. A position
   before the first header lands in the first module. */
export function moveLessonInOutline(modules, id, toIndex, opts) {
  const rows = outlineRows(modules, opts).filter((r) => r.id !== id);
  const at = Math.max(0, Math.min(toIndex, rows.length));
  let moduleId = (modules[0] || {}).id;
  for (let i = 0; i < at; i++) if (rows[i].type === "module") moduleId = rows[i].moduleId;
  // index within the target module = lessons of that module that precede `at`
  let within = 0;
  for (let i = 0; i < at; i++) if (rows[i].type === "lesson" && rows[i].moduleId === moduleId) within += 1;
  // a position right after a header that belongs to a LATER section than the
  // previous lesson already resolves through the header scan above
  return modules.map((m) => {
    let ids = (m.lessonIds || []).filter((x) => x !== id);
    if (m.id === moduleId) { ids = ids.slice(); ids.splice(Math.min(within, ids.length), 0, id); }
    return { ...m, lessonIds: ids };
  });
}
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
/* From an outline drag: the section block was dropped at `slot` among the rows
   that remain after removing that block. Its new section index = the number
   of section headers before the slot. */
export function moduleIndexFromSlot(rows, moduleId, slot) {
  const rest = rows.filter((r) => r.moduleId !== moduleId);
  return rest.slice(0, slot).filter((r) => r.type === "module").length;
}
/* Rows that travel with an outline row when dragged: a section header carries
   its lessons; a lesson moves alone. */
export function outlineSpan(rows, index) {
  const r = rows[index];
  if (!r || r.type !== "module") return 1;
  let n = 1;
  while (index + n < rows.length && rows[index + n].type !== "module") n += 1;
  return n;
}
/* Where a dragged outline row may land (slot = index among the remaining rows):
   sections only at section boundaries; lessons anywhere except above the first
   section header (that spot is the same as "first in section 1"). */
export function outlineCanDrop(row, slot, rest) {
  if (row.type === "module") return slot === rest.length || rest[slot]?.type === "module";
  return !(slot === 0 && rest[0]?.type === "module");
}

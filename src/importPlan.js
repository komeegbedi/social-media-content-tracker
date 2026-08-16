/* Pure, firebase-free planning + accounting for the bulk CSV import, so the
   data-safety rules are unit-testable without Firestore.

   IDEMPOTENCY SCOPE (read this before changing anything):
   This provides IMPORT idempotency — re-importing the same row content will not
   create a second document — NOT semantic duplicate detection. It never dedupes
   on title alone, and two INTENTIONALLY identical rows are preserved as two
   separate documents (via an occurrence ordinal). It does not detect that two
   differently-worded rows describe "the same" real task.

   Row identity is a SHA-256 digest (truncated to 128 bits, hex, Firestore-safe)
   of the row's NORMALISED content plus an occurrence ordinal — deliberately NOT
   of the filename, URL, file size, or absolute position. Consequences:
     • same content in a renamed file / different Sheet URL  → same ids
     • a row whose content changes                            → a NEW id (that row only)
     • unchanged rows in an edited file                       → keep their ids (no dup)
     • two exact-duplicate rows in one file                   → two ids (occ 0, 1)
     • reordering DISTINCT rows                               → ids unchanged (content-based, positional-independent)
     • reordering EXACT-DUPLICATE rows among themselves       → same SET of ids (ordinals reassigned identically)

   The whole-source content digest (sourceContentDigest) is recorded for
   provenance only; it is intentionally NOT part of the row id, because folding a
   whole-file digest into every row would make editing one row change every row's
   id — which would duplicate the unchanged rows on re-import.

   Run: node --test src/importPlan.test.js */

// SHA-256 → lowercase hex. Web Crypto is a global in browsers and Node 20+.
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Normalise whole-source text: unify line endings, strip trailing spaces per line
// and trailing blank lines, so cosmetically-different but identical content matches.
export function normalizeText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "").trim();
}

// Canonicalise one parsed CSV row (an object of column→value) order-independently,
// so column reordering doesn't change identity; values are trimmed.
export function normalizeRow(raw) {
  if (raw == null) return "";
  if (typeof raw !== "object") return String(raw).trim();
  return Object.keys(raw).sort().map((k) => k + "=" + String(raw[k] ?? "").trim()).join("");
}

// Content-based digest identifying the SOURCE (provenance/telemetry only — not the
// row id). Same content under any name/URL → same digest.
export async function sourceContentDigest(text) {
  return "src_" + (await sha256Hex(normalizeText(text))).slice(0, 32);
}

// Deterministic idempotency keys for parsed raw rows, parallel to `rawRows`.
// Returns [{ id, key, fingerprint, occurrence }]:
//   id/key      — "imp_" + 128-bit (32 hex) truncation → the Firestore document id
//   fingerprint — the full 256-bit digest, stored on the doc + used to detect a
//                 truncation collision (two different rows, same 128-bit id)
//   occurrence  — ordinal among exact-duplicate rows (0-based, by appearance)
export async function buildRowKeys(rawRows) {
  const seen = new Map();
  const out = [];
  for (let i = 0; i < rawRows.length; i++) {
    const norm = normalizeRow(rawRows[i]);
    const occ = seen.get(norm) || 0;
    seen.set(norm, occ + 1);
    const full = await sha256Hex(norm + "" + occ);
    const id = "imp_" + full.slice(0, 32);
    out.push({ id, key: id, fingerprint: full, occurrence: occ });
  }
  return out;
}

// Decide what an already-existing document at a row's deterministic id means:
//   "absent"   — no document (caller should create)
//   "match"    — same row content (verified via fingerprint) → idempotent skip
//   "conflict" — a DIFFERENT row collided onto this id, or the stored fingerprint
//                is missing/mismatched → surface a safe conflict; NEVER mark it
//                succeeded (that would silently drop a distinct task).
export function classifyExisting(existingData, row) {
  if (!existingData) return "absent";
  if (row && row.fingerprint && existingData.importFp === row.fingerprint) return "match";
  return "conflict";
}

// ---- Orchestration accounting (unchanged behaviour) --------------------------

// The rows to (re)import: valid rows that have NOT already succeeded. First run →
// every valid row; after a partial failure → only failed / never-attempted rows.
export function importBatch(rows, rowStatus = {}) {
  return rows.filter((r) => rowStatus[r.key]?.status !== "succeeded");
}

// Fold per-row results into the persistent status map; pending rows left as-is.
export function mergeRowResults(prev = {}, results = []) {
  const next = { ...prev };
  for (const r of results) {
    if (r && r.key && r.status && r.status !== "pending") {
      next[r.key] = { status: r.status, error: r.error ?? null, id: r.id ?? null };
    }
  }
  return next;
}

// Completion accounting derived only from row state.
export function importSummary(rows, rowStatus = {}) {
  let succeeded = 0, failed = 0;
  for (const r of rows) {
    const s = rowStatus[r.key]?.status;
    if (s === "succeeded") succeeded++;
    else if (s === "failed") failed++;
  }
  return {
    total: rows.length,
    succeeded,
    failed,
    remaining: rows.length - succeeded,
    allDone: rows.length > 0 && succeeded === rows.length,
  };
}

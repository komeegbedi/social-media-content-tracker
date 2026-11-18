/* Upload failure wording + the recorded diagnostics. Run: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadErrorMessage, shouldRecordUploadError, uploadDiagnostics } from "./academyUploadErrors.js";

const err = (code, extra = {}) => Object.assign(new Error(`Firebase Storage: (${code})`), { code, ...extra });

test("a refusal is not described as a missing role, and says how to recover", () => {
  const m = uploadErrorMessage(err("storage/unauthorized"));
  assert.doesNotMatch(m, /permission/i);
  assert.match(m, /didn't accept this upload, so the image wasn't saved/);
  assert.match(m, /still selected/);
  assert.match(m, /Reload the page and try again/);
  assert.match(m, /details were recorded/);
});

test("other failures keep their specific wording", () => {
  assert.match(uploadErrorMessage(err("storage/unauthenticated")), /sign-in has expired/);
  assert.match(uploadErrorMessage(err("stalled")), /stopped responding/);
  assert.match(uploadErrorMessage(err("storage/retry-limit-exceeded")), /connection dropped/);
  assert.match(uploadErrorMessage(err("storage/unauthorized"), false), /connection dropped/, "offline wins");
  assert.match(uploadErrorMessage(new Error("Couldn't save the resource's draft yet")), /draft yet/);
  assert.match(uploadErrorMessage({}), /upload failed/);
});

test("what is recorded: refusals and unexpected server answers, not cancellations or dropped connections", () => {
  assert.equal(shouldRecordUploadError(err("storage/unauthorized")), true);
  assert.equal(shouldRecordUploadError(err("storage/unauthenticated")), true);
  assert.equal(shouldRecordUploadError(err("storage/quota-exceeded")), true);
  assert.equal(shouldRecordUploadError(err("storage/canceled")), false);
  assert.equal(shouldRecordUploadError(err("storage/retry-limit-exceeded")), false);
  assert.equal(shouldRecordUploadError(err("offline")), false);
});

test("diagnostics: code, status, bucket, path and the server's answer — never tokens", () => {
  const x = err("storage/unauthorized", { status: 403, bucket: "demo.appspot.com",
    customData: { serverResponse: '{"error":{"code":403,"message":"Permission denied."}} Authorization: Bearer eyJhbGciOi.abc-DEF_1 https://x/o?alt=media&token=1234-abcd' } });
  const d = uploadDiagnostics(x, "academy/covers/9gd/v1.jpg");
  assert.match(d, /code=storage\/unauthorized/);
  assert.match(d, /status=403/);
  assert.match(d, /bucket=demo\.appspot\.com/);
  assert.match(d, /path=academy\/covers\/9gd\/v1\.jpg/);
  assert.match(d, /Permission denied/);
  assert.doesNotMatch(d, /eyJhbGciOi|1234-abcd/, "tokens removed");
  assert.match(d, /Bearer \[redacted\]/);
  assert.match(d, /token=\[redacted\]/);
});

test("the Storage module itself couldn't load: a newer release vs. a dropped connection — never the raw module error", () => {
  const stale = uploadErrorMessage(err("app/stale"));
  assert.match(stale, /newer version of the app is available/); assert.doesNotMatch(stale, /dynamically|MIME|https?:/);
  assert.match(uploadErrorMessage(err("app/offline")), /connection dropped/);
  assert.match(uploadErrorMessage(err("app/unreachable")), /connection dropped/);
  assert.equal(shouldRecordUploadError(err("app/stale")), false, "not a Storage refusal");
});

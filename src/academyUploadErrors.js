/* Image upload failures: what the person reads, and what is recorded.

   storage/unauthorized means only that Cloud Storage refused the request. It
   is NOT proof that the person lacks the role: in production it was the rules
   exceeding the two-document limit for a draft-only course, and it can also be
   a record that isn't saved yet or was removed in another tab. So the message
   says what happened and what to try, and the technical details go to the
   issue log (never tokens, URLs with tokens, or credentials). */

const STALL = /stalled|timeout/;
const OFFLINE = /fetch|network|offline|dynamically imported|retry-limit|storage\/(unknown|retry)/i;

export function uploadErrorMessage(x, online = true) {
  // the Storage module couldn't load (appUpdate.js): a newer release, offline or blocked
  if (x?.code === "app/stale") return "A newer version of the app is available, so the image wasn't uploaded. Your image is still selected. Save your changes, then reload to continue.";
  if (x?.code === "app/offline" || x?.code === "app/unreachable") return "Couldn't upload the image because the connection dropped. Your image is still selected. Try again when you're back online.";
  const code = `${x?.code || ""} ${x?.message || ""}`;
  if (STALL.test(code)) return "The upload stopped responding, so the image wasn't saved. Your image is still selected. Try again.";
  if (!online || OFFLINE.test(code)) return "Couldn't upload the image because the connection dropped. Your image is still selected. Try again when you're back online.";
  if (x?.code === "storage/unauthenticated") return "Your sign-in has expired, so the image wasn't saved. Sign in again, then try again. Your image is still selected.";
  if (x?.code === "storage/unauthorized") {
    return "The server didn't accept this upload, so the image wasn't saved. Your image is still selected. "
      + "Reload the page and try again. If it still fails, report it: the technical details were recorded.";
  }
  return x?.message || "The upload failed, so the image wasn't saved. Try again.";
}

/* Failures worth recording: a refusal or unexpected server answer (not
   offline, stalled or cancelled, which the message already explains). */
export function shouldRecordUploadError(x) {
  const c = String(x?.code || "");
  return c.startsWith("storage/") && !["storage/canceled", "storage/retry-limit-exceeded"].includes(c);
}

const SECRET = /(bearer\s+)[\w.\-~+/]+=*|((?:access_?token|id_?token|token|key|sig|signature|auth)=)[^&\s"']+/gi;
const scrub = (s, n) => String(s || "").replace(SECRET, (_, a, b) => `${a || b}[redacted]`).slice(0, n);

/* One line for the issue log: code, HTTP status, bucket, object path and the
   server's answer, with anything token-like removed. */
export function uploadDiagnostics(x, path) {
  const server = x?.customData?.serverResponse ?? x?.serverResponse ?? "";
  return [
    `code=${scrub(x?.code, 60)}`,
    `status=${scrub(x?.status ?? x?.status_, 10)}`,
    `bucket=${scrub(x?.bucket, 120)}`,
    `path=${scrub(path, 300)}`,
    `server=${scrub(typeof server === "string" ? server : JSON.stringify(server), 400).replace(/\s+/g, " ")}`,
  ].join("; ");
}

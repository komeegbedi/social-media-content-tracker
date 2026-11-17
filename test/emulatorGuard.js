/* Safety rail for every suite that CLEARS emulator data.
   A suite may only run against a throwaway project id, so `clearFirestore()` /
   `clearStorage()` can never reach the development project's data, even if the
   suite is pointed at the dev emulator by mistake (same ports, same machine).
   Allowed: demo-* (Firebase's offline demo projects) or the random ids the
   rules suites generate (rules-test-*, academy-rules-*). Refused: the real
   project id, and anything else. */
export const DEV_PROJECT_ID = "ifc-social-media-tracker";
const ALLOWED = /^(demo-[a-z0-9-]+|rules-test-\d+|academy-rules-\d+)$/;

export function assertThrowawayProject(projectId, { bucket } = {}) {
  if (!projectId) throw new Error("emulator guard: no project id — run this suite through `firebase emulators:exec --project demo-…`");
  if (projectId === DEV_PROJECT_ID || !ALLOWED.test(projectId)) {
    throw new Error(`emulator guard: refusing to clear data for project "${projectId}". Use a demo-* project (e.g. --project demo-academy-test).`);
  }
  if (bucket && (bucket.startsWith(`${DEV_PROJECT_ID}.`) || !bucket.startsWith(`${projectId}.`))) {
    throw new Error(`emulator guard: refusing to clear bucket "${bucket}" (it must belong to the throwaway project ${projectId}).`);
  }
  return projectId;
}

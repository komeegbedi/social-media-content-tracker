/* User trigger: notify admins of a new pending registration, and notify a user
   when their account is approved. Both are "required" messages — they bypass
   per-type preferences (the user can't have set prefs before being let in),
   but still respect the master email toggle and go out on in-app + email. */
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { loadUsers, notifyUsers } = require("./lib");
const { resendApiKey } = require("./emailService");

exports.onUserWrite = onDocumentWritten(
  { document: "users/{uid}", memory: "256MiB", timeoutSeconds: 30, secrets: [resendApiKey] },
  async (event) => {
    const uid = event.params.uid;
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;

    // New pending registration → alert every admin.
    if (!before && after.status === "pending") {
      const { list } = await loadUsers();
      const admins = list.filter((u) => u.role === "admin" && u.uid !== uid);
      await notifyUsers(admins, {
        type: "leadership", required: true, priority: "critical", keyBase: `pending_${uid}`,
        title: `${after.name || "A new member"} is awaiting approval`,
        body: "Review them in Admin → People.",
      });
      return;
    }

    // Approved → welcome the user (once).
    const justApproved = before && before.status !== "approved"
      && after.status === "approved" && after.role !== "admin";
    if (justApproved) {
      const me = { uid, ...after };
      await notifyUsers([me], {
        type: "account_approved", required: true, keyBase: `account_approved_${uid}`,
        title: "Your IFC Creatives Board account has been approved",
        body: "Welcome aboard! You can now access the board.",
      });
    }
  },
);

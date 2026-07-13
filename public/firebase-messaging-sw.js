/* Firebase Cloud Messaging service worker — handles push while the app is in
   the background / closed, and deep-links on tap.

   Registered by src/push.js with the Firebase web config passed as URL query
   params (all public values, so nothing secret lives in this static file).
   The compat SDK is used because service workers can't consume Vite env or ES
   module imports directly. */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

const params = new URLSearchParams(self.location.search);
firebase.initializeApp({
  apiKey: params.get("apiKey"),
  authDomain: params.get("authDomain"),
  projectId: params.get("projectId"),
  messagingSenderId: params.get("messagingSenderId"),
  appId: params.get("appId"),
});

const messaging = firebase.messaging();

// Background messages → show a notification that deep-links on tap.
messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(n.title || "IFC Creatives Board", {
    body: n.body || "",
    data: { url: data.url || "/" },
    tag: data.tag || undefined,
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      if (c.url.startsWith(self.location.origin) && "focus" in c) {
        await c.focus();
        if ("navigate" in c) c.navigate(url);
        return;
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});

// Minimal service worker (m14). Its only job is to exist: an installable PWA
// needs a registered worker with a fetch-capable scope, and Android's share
// target requires the app to be installed.
//
// There is DELIBERATELY no `fetch` handler. Everything this app renders is
// per-user authed data; caching it in the Cache API would risk serving one
// session's bookmarks after sign-out (and staleness on a feed that already
// polls via SWR). No handler => the browser goes to the network as usual.
self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

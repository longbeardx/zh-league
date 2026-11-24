// Offline support for the app's own files, network first. GitHub API calls are never cached.
const CACHE = "zh-league-v36";
const SHELL = ["./", "index.html", "league.js", "social.js", "app.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("zh-league-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fromNet = fetch(req, { cache: "no-cache" }).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
    const timeout = new Promise((r) => setTimeout(r, 3000));
    try { const res = await Promise.race([fromNet, timeout]); if (res) return res; } catch {}
    return (await cache.match(req)) || (await cache.match("index.html")) || fromNet;
  })());
});

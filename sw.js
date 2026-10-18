// Virkesfynd service worker
// - Appens filer: nätverk först, cache som reserv (så uppdateringar kommer fram direkt)
// - Kartrutor: cache först, så områden du tittat på finns kvar med svag täckning i skogen
const APP_CACHE = "vf-app-v14";
const PHOTO_CACHE = "vf-photos-v1";
const TILE_CACHE = "vf-tiles-v1";
const MAX_TILES = 3000;
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.50.0/dist/umd/supabase.js"];
const TILE_HOSTS = ["arcgisonline.com", "opentopomap.org", "tile.openstreetmap.org", "lantmateriet.se"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => ![APP_CACHE, TILE_CACHE, PHOTO_CACHE].includes(k)).map((k) => caches.delete(k)))));
  self.clients.claim();
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) {
    // Foton: spara en kopia (utan den tidsbegränsade nyckeln) så de syns offline
    if (url.pathname.includes("/storage/v1/object/sign/")) {
      const key = url.origin + url.pathname;
      e.respondWith(caches.open(PHOTO_CACHE).then(async (c) => {
        const hit = await c.match(key);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(key, res.clone());
        return res;
      }));
    }
    return; // övrig data går alltid direkt
  }

  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    e.respondWith(caches.open(TILE_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") { c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch { return new Response("", { status: 504 }); }
    }));
    return;
  }

  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (url.origin === location.origin || SHELL.includes(req.url))) {
      const copy = res.clone(); caches.open(APP_CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match("index.html"))));
});

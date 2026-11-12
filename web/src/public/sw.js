/*
 * Service worker of the web UI: lets the installed app start without an internet connection.
 *
 * The app is a single page (index.html holds scripts, styles and fonts). Only that page, the
 * manifest and the icons are kept for offline use. Everything else always comes from the
 * network and is never cached here: firmware files, channel.json and the cloud firmware must
 * match what is deployed right now.
 *
 * Strategy: network first. While online the page is always the deployed one; the copy in the
 * cache is only used when the network does not answer.
 *
 * Each version (main at the site root, dev in ./dev/) registers its own copy of this file, so
 * each one only looks after its own folder.
 */

const CACHE = "paperlesspaper-shell-v1";
const NETWORK_TIMEOUT_MS = 4000;
const SCOPE = new URL(self.registration.scope);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith("paperlesspaper-shell-") && name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/** The page of this version: its folder or index.html in it (not ./dev/ below the main version). */
function isOwnPage(url) {
  return url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + "index.html";
}

function isShellAsset(url) {
  return url.pathname === SCOPE.pathname + "manifest.webmanifest" || url.pathname.startsWith(SCOPE.pathname + "icons/");
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal, cache: "no-store" });
    if (response.ok) {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate" && isOwnPage(url)) {
    // one cache entry for the page, whatever query or file name it was opened with
    event.respondWith(networkFirst(request, SCOPE.href));
  } else if (isShellAsset(url)) {
    event.respondWith(networkFirst(request, url.origin + url.pathname));
  }
  // everything else (firmware, channel.json, ./factory/, another version): untouched
});

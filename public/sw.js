/**
 * Minimal service worker — just enough to make the app installable as a PWA.
 *
 * We intentionally do NOT cache API responses or live pages, because a remote-
 * desktop connection needs the real backend every time. The only thing we
 * cache is the manifest + icons so the install prompt shows up offline.
 */

const CACHE = 'remotely-shell-v1';
const PRECACHE = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => null))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Network-first for everything; only serve from cache if the network is
  // unavailable AND we have a copy (PRECACHE entries).
  if (event.request.method !== 'GET') return;
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request))
    );
  }
  // All other requests pass through transparently.
});

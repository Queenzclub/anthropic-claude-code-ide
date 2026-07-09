// Fleet Board Pro — service worker.
//
// Strategy: static app files are pre-cached at install, and every
// same-origin GET is served NETWORK-FIRST with the cache as an offline
// fallback. Network-first means a normal refresh always gets the latest
// deployed files — the cache only answers when the network is down.
//
// Supabase API calls and map tiles are cross-origin and are never
// intercepted or cached: live business data must never be served stale,
// and failed writes must fail visibly (no fake success, no fake
// locations).
//
// Bump CACHE_VERSION when deploying changes so old caches are cleared.

var CACHE_VERSION = 'fleetboard-v11';

var ASSETS = [
  './',
  'index.html',
  'admin.html',
  'manager.html',
  'outlet.html',
  'driver.html',
  'profile.html',
  'css/style.css',
  'js/config.js',
  'js/supabase-client.js',
  'js/auth.js',
  'js/ui.js',
  'js/login.js',
  'js/admin.js',
  'js/manager.js',
  'js/outlet.js',
  'js/driver.js',
  'js/profile.js',
  'js/notify.js',
  'js/pwa.js',
  'vendor/supabase.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // Add files one by one so a missing optional file (e.g. js/config.js
      // before setup) does not break the whole install.
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(url).catch(function () { /* skip missing */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE_VERSION;
      }).map(function (key) { return caches.delete(key); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Never touch non-GET requests or other origins (Supabase, map tiles).
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        if (response.ok) {
          var copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(event.request, copy);
          });
        }
        return response;
      })
      .catch(function () {
        return caches.match(event.request).then(function (cached) {
          if (cached) return cached;
          // Offline navigation to an uncached page: fall back to the app shell.
          if (event.request.mode === 'navigate') {
            return caches.match('index.html');
          }
          return Response.error();
        });
      })
  );
});

// Tapping an OS notification focuses an open app window (or opens one).
// Note: notifications are only shown while the app is running; delivering
// them when the app is fully closed would require Web Push (a push
// subscription + a server/Edge Function), which is not set up here.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        if ('focus' in clients[i]) return clients[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

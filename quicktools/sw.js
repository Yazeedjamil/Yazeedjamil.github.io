// Quick Tools remote - the service worker (PLAN Section 38 D20). It keeps the page itself (the shell) so the page
// opens without a connection and says so; it never touches a call to the server (another origin) and never queues
// anything. A new version is a new cache name: the next open installs it and drops the old one.
'use strict';
var VERSION = 'qt-remote-0.27.0-test-2';
var SHELL = [
  './', './index.html', './app.css', './app.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './fonts/Manrope-400.woff', './fonts/Manrope-600.woff', './fonts/Manrope-800.woff', './fonts/IBMPlexMono-400.woff'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // the server's calls go straight to the network
  // The shell: the network first (a fresh page when online), the kept copy when not.
  event.respondWith(fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(VERSION).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
    });
  }));
});

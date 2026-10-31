const CACHE_NAME = "pulsekeeper-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/app-icon.svg"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        return Promise.all(
          APP_SHELL.map(function (url) {
            return fetch(new Request(url, { cache: "reload" })).then(function (response) {
              if (response.ok) {
                return cache.put(url, response);
              }
            });
          })
        );
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return key !== CACHE_NAME;
          })
          .map(function (key) {
            return caches.delete(key);
          })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(function (networkResponse) {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
          const responseCopy = networkResponse.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, responseCopy);
          });
        }
        return networkResponse;
      })
      .catch(function () {
        return caches.match(event.request);
      })
  );
});

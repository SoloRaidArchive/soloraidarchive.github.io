const CACHE_PREFIX = "solo-raid-archive-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok || response.type === "opaque") {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.pathname.endsWith(".json")) {
    event.respondWith(fetch(request));
    return;
  }

  const acceptsHtml = request.headers.get("accept")?.includes("text/html");
  const isHtml = url.pathname.endsWith(".html");
  if (request.mode === "navigate" || request.destination === "document" || acceptsHtml || isHtml) {
    event.respondWith(networkFirst(request));
    return;
  }

  const isStaticAsset =
    url.pathname.startsWith("/assets/icons/") ||
    url.pathname.startsWith("/assets/sprites/") ||
    request.destination === "font";

  if (isStaticAsset) {
    event.respondWith(cacheFirst(request));
  }
});
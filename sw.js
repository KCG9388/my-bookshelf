/* Concento PWA service worker
 * 設計原則(安全第一,這是線上 Firebase 站):
 *  - 殼層/同源:網路優先(network-first)→ 永遠拿到最新 app.js,絕不服務舊版。
 *  - 書封(跨源圖片):持久 cache-first → 看過的封面存進手機 Cache Storage,
 *      之後重開/下拉刷新/離線都瞬間從本機載出(書封網址固定、圖片不變,cache-first 安全)。
 *      設容量上限 FIFO 汰舊,避免無限長大。
 *  - 其餘跨源(Firebase / Google 字型 / gstatic)一律放行,不攔。
 *  - 換版只要改 CACHE 名稱,activate 會清掉舊殼層快取(但保留書封快取,不必每次重抓)。
 */
const CACHE = "concento-shell-v1";
const COVER_CACHE = "concento-covers-v1";
const COVER_MAX = 300;   // 最多存幾張封面(超過就汰掉最舊的)
const SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "./favicon-32.png",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))).catch(() => {})
    )
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // 清掉舊殼層快取,但保留書封快取(換 app 版本時封面不必重抓)
    await Promise.all(
      keys.filter((k) => k !== CACHE && k !== COVER_CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// 跨源的「圖片」請求 = 書封(Google Books / OpenLibrary 等);同源圖片(app 圖示)走殼層邏輯
function isCoverRequest(url, req) {
  return req.destination === "image" && url.origin !== self.location.origin;
}

// 書封:先找本機快取,沒有才上網並存起來;離線且無快取才讓 <img> onerror 走退回
async function coverCacheFirst(req) {
  const cache = await caches.open(COVER_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);   // 跨源 no-cors → opaque response,可存可回
    try { await cache.put(req, res.clone()); trimCoverCache(cache); } catch (_) {}
    return res;
  } catch (_) {
    return (await cache.match(req)) || Response.error();
  }
}

// FIFO 汰舊:keys() 大致依插入順序,超量就從最舊開始刪
async function trimCoverCache(cache) {
  const keys = await cache.keys();
  const over = keys.length - COVER_MAX;
  for (let i = 0; i < over; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 書封 → 持久 cache-first(本機優先)
  if (isCoverRequest(url, req)) {
    e.respondWith(coverCacheFirst(req));
    return;
  }

  // 其餘跨源(Firebase·字型·gstatic)不攔,交給瀏覽器原生流程
  if (url.origin !== self.location.origin) return;

  // 同源殼層 → 網路優先,離線兜底
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((r) => r || caches.match("./index.html"))
      )
  );
});

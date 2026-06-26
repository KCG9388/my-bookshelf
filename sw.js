/* Concento PWA service worker
 * 設計原則(安全第一,這是線上 Firebase 站):
 *  - 網路優先(network-first):有網路時一律走網路 → 永遠拿到最新 app.js,絕不服務舊版。
 *  - 只接管「同源 GET」;跨源請求(Firebase / Google 字型 / gstatic)一律放行,不攔。
 *  - 離線時才用快取兜底(殼層 index/icon),導覽失敗回快取的 index.html。
 *  - 換版只要改 CACHE 名稱,activate 會清掉舊快取。
 */
const CACHE = "concento-shell-v1";
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
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // 只處理同源 GET;其餘(POST / 跨源 Firebase·字型)不攔,交給瀏覽器原生流程
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

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

/* 書目代理 Worker 的門禁測試(不需網路、不需 wrangler、不碰 Cloudflare):
 * 直接 import worker/src/index.js,把「往外打的 fetch」和 KV 換成假的,送各種請求看回應。
 * 跑法:node tests/unit_worker.mjs
 * 涵蓋:沒帶/帶錯 Origin 一律擋、/v1/fetch 網站白名單、轉址逐跳檢查、202 挑戰頁當失敗、2MB 截斷、batch body 上限、速率限制
 */
import worker from "../worker/src/index.js";

const OK_ORIGIN = "https://concento.io";
let upstream = [];   // 這次請求 Worker 往外打了哪些網址
let route = () => new Response("not mocked", { status: 599 });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  upstream.push({ url, init });
  return route(url, init);
};
const kv = new Map();
const CACHE = {
  get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null),
  put: async (k, v) => { kv.set(k, v); },
};
const env = { CACHE, GBOOKS_KEY: "test-key" };
const envNoKey = { CACHE };   // 還沒在後台設 secret GBOOKS_KEY 的狀態

let ipSeq = 0;
function makeReq(path, { origin = OK_ORIGIN, method = "GET", body, headers = {}, ip } = {}) {
  const h = new Headers(headers);
  if (origin) h.set("Origin", origin);
  ipSeq++;
  h.set("CF-Connecting-IP", ip || `198.51.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`);   // 預設每次換 IP,不撞速率限制
  const init = { method, headers: h };
  if (body !== undefined) { init.body = body; if (body instanceof ReadableStream) init.duplex = "half"; }
  return new Request("https://concento-api.test.workers.dev" + path, init);
}
async function call(path, opts = {}) { upstream = []; return worker.fetch(makeReq(path, opts), opts.env || env); }
const enc = encodeURIComponent;

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : "  → " + extra}`);
}

// ── 1. 門禁:沒帶 Origin / 別人的 Origin ──
let r = await call("/v1/search?q=dune", { origin: "" });
check("沒帶 Origin 打 /v1/search → 403 origin_required", r.status === 403 && (await r.json()).error === "origin_required", `status=${r.status}`);
check("  ↳ 沒有往外打任何上游", upstream.length === 0, `upstream=${upstream.length}`);

r = await call("/v1/fetch?url=" + enc("https://example.com/"), { origin: "" });
check("沒帶 Origin 打 /v1/fetch(舊版這樣就是開放代理)→ 403", r.status === 403, `status=${r.status}`);
check("  ↳ 沒有往外打", upstream.length === 0, `upstream=${upstream.length}`);

r = await call("/v1/batch", { origin: "", method: "POST", body: JSON.stringify({ isbns: ["9780441013593"] }), headers: { "Content-Type": "application/json" } });
check("沒帶 Origin 打 /v1/batch → 403", r.status === 403, `status=${r.status}`);

r = await call("/v1/popularity?title=Dune", { origin: "https://evil.example" });
check("別的網站的 Origin → 403 origin_not_allowed", r.status === 403 && (await r.json()).error === "origin_not_allowed", `status=${r.status}`);

r = await call("/", { origin: "" });
check("根目錄健康檢查不需要 Origin → 200", r.status === 200 && (await r.json()).ok === true, `status=${r.status}`);

r = await call("/v1/batch", { origin: "", method: "OPTIONS" });
check("預檢 OPTIONS 沒帶 Origin → 403", r.status === 403, `status=${r.status}`);
r = await call("/v1/batch", { method: "OPTIONS" });
check("預檢 OPTIONS 自家 Origin → 204 + CORS 標頭", r.status === 204 && r.headers.get("Access-Control-Allow-Origin") === OK_ORIGIN, `status=${r.status}`);

// ── 2. 自家網站正常使用不受影響 ──
route = (url) => url.startsWith("https://openlibrary.org/search.json")
  ? Response.json({ docs: [{ title: "Dune", author_name: ["Frank Herbert"], isbn: ["9780441013593"], cover_i: 1 }] })
  : new Response("nope", { status: 500 });
r = await call("/v1/search?q=dune&lang=en");
let j = await r.json();
check("自家 Origin 打 /v1/search → 200 有結果", r.status === 200 && j.items?.[0]?.title === "Dune", JSON.stringify(j).slice(0, 160));
check("  ↳ 回應帶 Access-Control-Allow-Origin", r.headers.get("Access-Control-Allow-Origin") === OK_ORIGIN);

r = await call("/v1/batch", { method: "POST", body: JSON.stringify({ isbns: ["9780441013593", "not-an-isbn"] }), headers: { "Content-Type": "application/json" } });
j = await r.json();
check("自家 Origin 打 /v1/batch → 200、壞 ISBN 被濾掉", r.status === 200 && j.count === 1 && j.results["9780441013593"]?.found === true, JSON.stringify(j).slice(0, 160));

r = await call("/v1/batch", { origin: "http://localhost:8124", method: "POST", body: JSON.stringify({ isbns: ["9780441013593"] }), headers: { "Content-Type": "application/json" } });
check("本機 preview(localhost:8124)也能用", r.status === 200, `status=${r.status}`);

// ── 3. batch body 上限 ──
const big = JSON.stringify({ isbns: Array(2000).fill("9780441013593") });
r = await call("/v1/batch", { method: "POST", body: big, headers: { "Content-Type": "application/json", "Content-Length": String(big.length) } });
check("batch body 超過 4KB(有 Content-Length)→ 413", r.status === 413, `status=${r.status}`);
const chunked = new ReadableStream({ start(c) { for (let i = 0; i < 50; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000))); c.close(); } });
r = await call("/v1/batch", { method: "POST", body: chunked });
j = await r.json();
check("batch 分塊上傳超過 4KB(沒 Content-Length)→ 拒絕、不查書", j.error === "body_too_large" && upstream.length === 0, JSON.stringify(j));

// ── 4. /v1/fetch 網站白名單 ──
route = () => new Response("SHOULD NOT BE FETCHED", { status: 200 });
const blocked = [
  "https://example.com/", "http://127.0.0.1/", "http://localhost:8787/", "http://169.254.169.254/latest/meta-data/",
  "https://goodreads.com.evil.com/", "https://evilgoodreads.com/", "https://user:pw@www.goodreads.com/",
  "https://www.goodreads.com:8443/", "ftp://www.goodreads.com/", "https://concento-api.st031031.workers.dev/v1/fetch?url=x",
  "https://www.google.com/search?q=isbn", "https://douban.com/", "not a url",
];
for (const u of blocked) {
  r = await call("/v1/fetch?url=" + enc(u));
  check(`白名單外 ${u} → 擋下且沒往外打`, (r.status === 403 || r.status === 400) && upstream.length === 0, `status=${r.status} upstream=${upstream.length}`);
}

route = () => new Response("<html>ISBN 9780441013593</html>", { status: 200 });
for (const u of ["https://www.goodreads.com/review/list/1?shelf=to-read", "https://search.books.com.tw/search/query/key/dune",
                 "https://readmoo.com/book/210", "https://www.amazon.co.jp/dp/4150117861", "https://book.douban.com/subject/1/"]) {
  r = await call("/v1/fetch?url=" + enc(u));
  check(`白名單內 ${new URL(u).hostname} → 200 回頁面文字`, r.status === 200 && (await r.text()).includes("9780441013593"), `status=${r.status}`);
}
check("  ↳ 上游用 redirect:manual(轉址自己逐跳檢查)", upstream[0]?.init?.redirect === "manual", JSON.stringify(upstream[0]?.init?.redirect));

// ── 5. 轉址逐跳檢查 ──
route = (url) => url.startsWith("https://a.co/")
  ? new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } })
  : new Response("SHOULD NOT BE FETCHED", { status: 200 });
r = await call("/v1/fetch?url=" + enc("https://a.co/d/abc123"));
j = await r.json();
check("白名單網址轉址到白名單外 → 502,而且沒去抓轉址目標", r.status === 502 && j.error === "redirect_not_allowed" && upstream.length === 1, `status=${r.status} n=${upstream.length}`);

route = (url) => {
  if (url.startsWith("https://amzn.asia/")) return new Response(null, { status: 301, headers: { Location: "https://www.amazon.co.jp/dp/4150117861" } });
  if (url === "https://www.amazon.co.jp/dp/4150117861") return new Response(null, { status: 302, headers: { Location: "/gp/product/4150117861" } });
  if (url === "https://www.amazon.co.jp/gp/product/4150117861") return new Response("ISBN-10: 4150117861", { status: 200 });
  return new Response("?", { status: 404 });
};
r = await call("/v1/fetch?url=" + enc("https://amzn.asia/d/xyz"));
check("白名單內互轉(短網址→商品頁→相對路徑)→ 200", r.status === 200 && upstream.length === 3 && (await r.text()).includes("4150117861"), `status=${r.status} n=${upstream.length}`);

route = () => new Response(null, { status: 302, headers: { Location: "https://www.goodreads.com/loop" } });
r = await call("/v1/fetch?url=" + enc("https://www.goodreads.com/start"));
check("轉址超過 4 跳 → 502,最多打 5 次", r.status === 502 && upstream.length === 5, `status=${r.status} n=${upstream.length}`);

// ── 6. 只有 200 算成功 / 截斷 ──
route = () => new Response("<html>bot challenge</html>", { status: 202 });
r = await call("/v1/fetch?url=" + enc("https://readmoo.com/book/210"));
check("上游 202 挑戰頁 → 502(前端才會換下一個代理)", r.status === 502 && r.headers.get("X-Upstream-Status") === "202", `status=${r.status}`);

route = () => new Response("nope", { status: 403 });
r = await call("/v1/fetch?url=" + enc("https://www.books.com.tw/products/0010"));
check("上游 403(博客來擋 Cloudflare)→ 502", r.status === 502, `status=${r.status}`);

route = () => new Response("9".repeat(2_500_000), { status: 200 });
r = await call("/v1/fetch?url=" + enc("https://openlibrary.org/people/x/lists"));
const body = await r.text();
check("超過 2MB 截斷 + X-Truncated=1", r.status === 200 && body.length === 2_000_000 && r.headers.get("X-Truncated") === "1", `len=${body.length}`);

// ── 7. 速率限制(同一 IP 一分鐘第 121 次)──
let last;
for (let i = 0; i < 121; i++) last = await call("/", { origin: "", ip: "192.0.2.77" });
check("同一 IP 一分鐘內第 121 次 → 429", last.status === 429, `status=${last.status}`);

// ── 8. 還沒設 Google Books 金鑰 → 查書三端點 503(前端退回自己直打),流行度 / 網頁抓取照常 ──
route = (url) => url.startsWith("https://openlibrary.org/search.json")
  ? Response.json({ docs: [{ title: "Dune Messiah", readinglog_count: 5, edition_count: 3 }] })
  : new Response("<html>ok</html>", { status: 200 });
for (const [path, method] of [["/v1/search?q=x", "GET"], ["/v1/isbn/9780441013593", "GET"], ["/v1/batch", "POST"]]) {
  r = await call(path, { env: envNoKey, method, body: method === "POST" ? JSON.stringify({ isbns: ["9780441013593"] }) : undefined });
  check(`沒金鑰 ${method} ${path.split("?")[0]} → 503 且沒往外打`, r.status === 503 && (await r.json()).error === "gb_key_missing" && upstream.length === 0, `status=${r.status} n=${upstream.length}`);
}
r = await call("/v1/popularity?title=Dune%20Messiah&author=Herbert", { env: envNoKey });
check("沒金鑰時 /v1/popularity 照常 200", r.status === 200, `status=${r.status}`);
r = await call("/v1/fetch?url=" + enc("https://openlibrary.org/works/OL1W"), { env: envNoKey });
check("沒金鑰時 /v1/fetch(名單內)照常 200", r.status === 200, `status=${r.status}`);

// ── 9. 快取規則:Google Books 沒正常回應時不快取(免得打折結果被記 7 天 / 把「沒有」記 1 天)──
kv.clear();
route = (url) => url.startsWith("https://www.googleapis.com/") ? new Response("quota", { status: 429 })
  : url.startsWith("https://openlibrary.org/search.json") ? Response.json({ docs: [{ title: "Dune", author_name: ["Frank Herbert"] }] })
  : new Response("?", { status: 404 });
r = await call("/v1/search?q=dune&lang=en"); j = await r.json();
check("GB 掛掉 → 200 只回 OL 結果", r.status === 200 && j.sources?.gb === "rejected" && j.items.length === 1, JSON.stringify(j.sources));
check("  ↳ 沒有寫進快取", kv.size === 0, `kv=${[...kv.keys()]}`);
r = await call("/v1/isbn/9780441013593"); j = await r.json();
check("GB 掛掉時 ISBN 查詢 → 回 OL 結果但不快取", r.status === 200 && j.found === true && kv.size === 0, `kv=${[...kv.keys()]}`);
route = (url) => url.startsWith("https://www.googleapis.com/")
  ? Response.json({ items: [{ volumeInfo: { title: "Dune", authors: ["Frank Herbert"], industryIdentifiers: [{ type: "ISBN_13", identifier: "9780441013593" }] } }] })
  : url.startsWith("https://openlibrary.org/search.json") ? Response.json({ docs: [] }) : new Response("?", { status: 404 });
r = await call("/v1/search?q=dune&lang=en"); j = await r.json();
check("GB 正常 → 結果寫進快取(新前綴 s2:)", j.sources?.gb === "fulfilled" && kv.has("s2:en:dune"), `kv=${[...kv.keys()]}`);
r = await call("/v1/search?q=dune&lang=en"); j = await r.json();
check("  ↳ 第二次命中快取", j.cached === true && upstream.length === 0, `cached=${j.cached} n=${upstream.length}`);
route = (url) => url.startsWith("https://www.googleapis.com/") ? Response.json({ totalItems: 0 })
  : url.startsWith("https://openlibrary.org/") ? Response.json({ docs: [] }) : new Response("?", { status: 404 });
r = await call("/v1/isbn/9789573317241"); j = await r.json();
check("GB 正常回「查無」→ 記 1 天的查無(新前綴 i2:)", j.found === false && kv.has("i2:9789573317241"), `kv=${[...kv.keys()]}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

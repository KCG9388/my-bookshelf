// ═══════════════════════════════════════════════════════════════════
//  Concento 書目代理(Cloudflare Worker)
//  為什麼要有這層:純前端直打 Google Books 會曝露金鑰、全站共用每日配額(幾個人匯入就吃光→全站搜尋掛)、
//  被瀏覽器 CORS 擋住博客來/讀墨這類繁中來源。這裡集中查詢 + KV 快取 + 藏金鑰 + 合併多來源;
//  前端一律「先打這裡、失敗退回直打」,所以這層掛了網站照常運作(零風險切換)。
//
//  端點(全部回 JSON,除了 /v1/fetch 回純文字):
//    GET  /v1/search?q=&lang=          Google Books 12 筆 + Open Library 8 筆 → 合併去重 → 統一欄位(含 isbn13)
//    GET  /v1/isbn/{isbn}              單本:GB isbn: 查 → OL isbn 查;查無也快取 1 天
//    POST /v1/batch  {isbns:[…]}       一次最多 10 本(免費層每請求 50 個子請求上限),前端自己分批
//    GET  /v1/fetch?url=               「網頁匯入」用的 CORS 代理:只准 FETCH_HOSTS 書籍網站、轉址逐跳檢查、2MB、10 秒、回純文字
//    GET  /v1/popularity?title=&author= OL readinglog/edition 流行度,查無回 -1(繁中書幾乎都是)
//
//  門禁:/v1/* 一律要帶 ALLOWED_ORIGINS 裡的 Origin(瀏覽器跨站呼叫一定會帶),沒帶(curl、腳本、掃描器)或不對 → 403,
//  在碰 KV / 上游之前就擋掉。Origin 腳本偽造得了,所以這只是擋掉隨手濫用的第一道,不是身分驗證;
//  /v1/fetch 另有網站白名單,就算偽造 Origin 也只能抓書店/書目頁,不再是任何網址都能轉的開放代理。
//
//  免費層限制怎麼扛:KV 每天 1,000 次寫入 → 速率計數放記憶體(每個 isolate 自己算),KV 只當查詢快取,
//  寫入失敗吞掉不影響回應;每請求 50 個子請求 → batch 上限 10、並行 4。
// ═══════════════════════════════════════════════════════════════════

const ALLOWED_ORIGINS = new Set([
  "https://concento.io",
  "https://kcg9388.github.io",
  "http://localhost:8124",
]);
const GB  = "https://www.googleapis.com/books/v1/volumes";
const OL  = "https://openlibrary.org/search.json";
const OL_FIELDS = "title,author_name,isbn,cover_i,first_publish_year,number_of_pages_median,subject,language,publisher";
const UA  = "Concento/1.0 (+https://concento.io)";
const TTL = { search: 7 * 86400, isbn: 30 * 86400, isbnMiss: 86400, pop: 30 * 86400 };
const RATE = { limit: 120, windowMs: 60_000 };
const MAX_BATCH = 10, BATCH_CONCURRENCY = 4;
const MAX_BATCH_BODY = 4096;   // 10 個 ISBN 的 JSON 約 200 bytes;擋超大 body 白燒 CPU
const rate = new Map();   // ip → { start, n }

export default {
  async fetch(req, env) {
    const url    = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors   = corsHeaders(origin);
    const p      = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: ALLOWED_ORIGINS.has(origin) ? 204 : 403, headers: cors });
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin_not_allowed" }, 403, cors);
    if (!origin && p.startsWith("/v1/")) return json({ error: "origin_required" }, 403, cors);   // 見檔頭「門禁」
    if (!allowRate(req.headers.get("CF-Connecting-IP") || "?")) return json({ error: "rate_limited" }, 429, cors);
    // 還沒設 Google Books 金鑰(secret GBOOKS_KEY)時,查書三個端點直接回 503 → 前端照「代理失敗」退回自己直打 Google Books,
    // 結果不打折(只靠 Open Library 的話繁中書幾乎查不到);金鑰一設好就自動恢復。流行度、網頁抓取用不到金鑰,照常服務。
    if (!env.GBOOKS_KEY && (p === "/v1/search" || p.startsWith("/v1/isbn/") || p === "/v1/batch")) return json({ error: "gb_key_missing" }, 503, cors);
    try {
      if (req.method === "GET"  && p === "/v1/search")        return json(await search(env, url.searchParams), 200, cors, TTL.search);
      if (req.method === "GET"  && p.startsWith("/v1/isbn/")) return json(await isbnLookup(env, decodeURIComponent(p.slice(9))), 200, cors, TTL.isbn);
      if (req.method === "POST" && p === "/v1/batch") {
        if (+(req.headers.get("Content-Length") || 0) > MAX_BATCH_BODY) return json({ error: "body_too_large" }, 413, cors);
        return json(await batch(env, req), 200, cors);
      }
      if (req.method === "GET"  && p === "/v1/fetch")         return proxyFetch(url.searchParams.get("url") || "", cors);
      if (req.method === "GET"  && p === "/v1/popularity")    return json(await popularity(env, url.searchParams), 200, cors, TTL.pop);
      if (p === "/" || p === "/v1") return json({ ok: true, service: "concento-api",
        endpoints: ["GET /v1/search?q=&lang=", "GET /v1/isbn/{isbn}", "POST /v1/batch {isbns:[]}", "GET /v1/fetch?url=", "GET /v1/popularity?title=&author="] }, 200, cors);
      return json({ error: "not_found" }, 404, cors);
    } catch (e) {
      return json({ error: "internal", message: String((e && e.message) || e) }, 500, cors);
    }
  },
};

// ── 回應 / CORS / 速率 ──
function corsHeaders(origin) {
  const h = { "Vary": "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
  if (ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(data, status = 200, cors = {}, maxAge = 0) {
  const headers = { ...cors, "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": (maxAge && status === 200) ? `public, max-age=${Math.min(maxAge, 86400)}` : "no-store" };
  return new Response(JSON.stringify(data), { status, headers });
}
function allowRate(ip) {
  const now = Date.now();
  let r = rate.get(ip);
  if (!r || now - r.start > RATE.windowMs) { r = { start: now, n: 0 }; rate.set(ip, r); }
  r.n++;
  if (rate.size > 5000) rate.clear();   // 別讓記憶體無限長
  return r.n <= RATE.limit;
}

// ── KV 快取(失敗一律吞掉:快取只是加速,不是正確性的一部分)──
async function cacheGet(env, key) { try { return await env.CACHE.get(key, "json"); } catch { return null; } }
async function cachePut(env, key, val, ttl) { try { await env.CACHE.put(key, JSON.stringify(val), { expirationTtl: ttl }); } catch {} }

// ── 上游請求(帶 UA 與逾時)──
async function getJSON(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: ac.signal });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ── ISBN / 文字正規化(與前端 app.js 同一套規則)──
function validISBN13(s) { if (!/^\d{13}$/.test(s)) return false; let sum = 0; for (let i = 0; i < 13; i++) sum += (+s[i]) * (i % 2 ? 3 : 1); return sum % 10 === 0; }
function validISBN10(s) { if (!/^\d{9}[\dX]$/.test(s)) return false; let sum = 0; for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : +s[i]) * (10 - i); return sum % 11 === 0; }
function isbn10to13(s) { const core = "978" + s.slice(0, 9); let sum = 0; for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1); return core + ((10 - sum % 10) % 10); }
function normIsbn13(raw) {
  const s = String(raw || "").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (s.length === 13) return validISBN13(s) ? s : "";
  if (s.length === 10) return validISBN10(s) ? isbn10to13(s) : "";
  return "";
}
const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
const CJK  = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;
function cleanDesc(d) {
  const txt = String(d || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  return txt.length >= 60 ? txt : "";
}
function tidyCover(u) {
  if (!u || !/^https?:\/\//i.test(u)) return u || "";
  u = u.replace(/^http:\/\//i, "https://");
  if (/books\.google/i.test(u)) u = u.replace(/([?&])edge=curl&?/i, "$1").replace(/[?&]$/, "");
  return u;
}

// ── 兩個來源 → 統一欄位 ──
function fromGB(it) {
  const v = it.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const pick = t => (ids.find(x => x.type === t) || {}).identifier;
  return {
    source: "gb",
    isbn13: normIsbn13(pick("ISBN_13")) || normIsbn13(pick("ISBN_10")),
    title: v.title || "", subtitle: v.subtitle || "",
    author: (v.authors || []).join(", "),
    genre: (v.categories || []).join(", "),
    pages: v.pageCount || 0,
    cover: v.imageLinks ? tidyCover(v.imageLinks.thumbnail || v.imageLinks.smallThumbnail || "") : "",
    year: (v.publishedDate || "").slice(0, 4),
    lang: v.language || "", publisher: v.publisher || "",
    description: cleanDesc(v.description || ""),
  };
}
function fromOL(d) {
  return {
    source: "ol",
    isbn13: (d.isbn || []).map(normIsbn13).find(Boolean) || "",
    title: d.title || "", subtitle: "",
    author: (d.author_name || []).slice(0, 2).join(", "),
    genre: (d.subject || []).slice(0, 2).join(", "),
    pages: d.number_of_pages_median || 0,
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : "",
    year: d.first_publish_year ? String(d.first_publish_year) : "",
    lang: (d.language || [])[0] || "", publisher: (d.publisher || [])[0] || "",
    description: "",
  };
}
// 合併:同 ISBN 或同(書名|第一作者)視為同一本,後到的只補前者缺的欄位;中文介面把 CJK 書名排前面
function merge(gbItems, olItems, lang) {
  const out = [], byIsbn = new Map(), byKey = new Map();
  const keyOf = b => norm(b.title) + "|" + norm((b.author || "").split(",")[0]);
  for (const b of [...gbItems, ...olItems]) {
    if (!b.title) continue;
    const prev = (b.isbn13 && byIsbn.get(b.isbn13)) || byKey.get(keyOf(b));
    if (prev) {
      for (const f of ["cover", "description", "pages", "year", "genre", "isbn13", "publisher"]) if (!prev[f] && b[f]) prev[f] = b[f];
      continue;
    }
    out.push(b);
    if (b.isbn13) byIsbn.set(b.isbn13, b);
    byKey.set(keyOf(b), b);
  }
  if (lang && lang.startsWith("zh")) out.sort((a, b) => (CJK.test(b.title) ? 1 : 0) - (CJK.test(a.title) ? 1 : 0));
  return out.slice(0, 20);
}

// ── /v1/search ──
async function search(env, sp) {
  const q = (sp.get("q") || "").trim().slice(0, 200);
  if (!q) return { q, items: [], error: "missing_q" };
  const lang = (sp.get("lang") || "").slice(0, 5);
  const key  = `s2:${lang}:${q.toLowerCase()}`;   // s2:2026-09-24 搬帳號測試時存過沒有 Google Books 的結果,換前綴讓它們自然過期
  const hit  = await cacheGet(env, key);
  if (hit) return { ...hit, cached: true };
  const isbn = normIsbn13(q);
  const [gb, ol] = await Promise.allSettled([
    env.GBOOKS_KEY ? getJSON(`${GB}?q=${encodeURIComponent(isbn ? "isbn:" + isbn : q)}&maxResults=12&key=${env.GBOOKS_KEY}`)
                   : Promise.reject(new Error("no_key")),
    getJSON(`${OL}?${isbn ? "isbn=" + isbn : "q=" + encodeURIComponent(q)}&limit=8&fields=${OL_FIELDS}`),
  ]);
  const gbItems = gb.status === "fulfilled" ? (gb.value.items || []).map(fromGB) : [];
  const olItems = ol.status === "fulfilled" ? (ol.value.docs  || []).map(fromOL) : [];
  const out = { q, items: merge(gbItems, olItems, lang), sources: { gb: gb.status, ol: ol.status } };
  if (gb.status === "fulfilled") await cachePut(env, key, out, TTL.search);   // Google Books 沒回應(配額用完/故障)時只回 OL 結果、不快取,免得打折的結果被記 7 天
  return out;
}

// ── /v1/isbn/{isbn} ──
async function isbnLookup(env, raw) {
  const isbn13 = normIsbn13(raw);
  if (!isbn13) return { isbn13: "", found: false, error: "invalid_isbn" };
  const key = `i2:${isbn13}`;   // i2:同 s2 的理由
  const hit = await cacheGet(env, key);
  if (hit) return { ...hit, cached: true };
  let book = null, gbOk = false;
  if (env.GBOOKS_KEY) {
    try { const d = await getJSON(`${GB}?q=isbn:${isbn13}&maxResults=1&key=${env.GBOOKS_KEY}`); gbOk = true; if (d.items?.[0]) book = fromGB(d.items[0]); } catch {}
  }
  if (!book) {
    try { const d = await getJSON(`${OL}?isbn=${isbn13}&limit=1&fields=${OL_FIELDS}`); if (d.docs?.[0]) book = fromOL(d.docs[0]); } catch {}
  }
  if (book && !book.isbn13) book.isbn13 = isbn13;
  const out = { isbn13, found: !!book, book };
  // 只在 Google Books 有正常回應時才快取(不論找到沒):它掛掉時的結果(OL 代打或「沒有」)不記,下次再問它
  if (gbOk) await cachePut(env, key, out, book ? TTL.isbn : TTL.isbnMiss);
  return out;
}

// ── POST /v1/batch ──
async function batch(env, req) {
  let body;
  try {
    const { buf, truncated } = await readUpTo(req.body, MAX_BATCH_BODY);   // 分塊上傳(沒帶 Content-Length)也不會整包讀進來
    if (truncated) return { error: "body_too_large", results: {} };
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch { return { error: "bad_json", results: {} }; }
  const list = [...new Set((Array.isArray(body?.isbns) ? body.isbns : []).map(normIsbn13).filter(Boolean))].slice(0, MAX_BATCH);
  const results = {};
  let i = 0;
  const worker = async () => { while (i < list.length) { const isbn = list[i++]; results[isbn] = await isbnLookup(env, isbn); } };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, list.length) }, worker));
  return { count: list.length, max: MAX_BATCH, results };
}

// ── /v1/fetch?url=(CORS 代理,給「網頁匯入」貼網址抽 ISBN 用)──
// 只准書籍相關網站(含其子網域)。其他網址回 403 → 前端 fetchPageForISBNs 自動改走 allorigins / r.jina.ai,功能照常;
// 這樣就算有人偽造 Origin,也沒辦法拿這裡當任意網址的開放代理(吃我們的額度、替別人轉流量、招來濫用檢舉)。
// 內網位址、IP、非預設埠、帳密網址本來就不在白名單裡,一併擋掉。
const FETCH_HOSTS = [
  // 台灣 / 中文書店與書目
  "books.com.tw", "readmoo.com", "taaze.tw", "kingstone.com.tw", "eslite.com", "sanmin.com.tw",
  "cite.com.tw", "pubu.com.tw", "bookwalker.com.tw", "hyread.com.tw", "isbn.ncl.edu.tw", "book.douban.com",
  // 國際書店與書單
  "goodreads.com", "openlibrary.org", "books.google.com", "books.google.com.tw", "kobo.com",
  "thestorygraph.com", "hardcover.app", "librarything.com", "bookshop.org", "barnesandnoble.com",
  "amazon.com", "amazon.co.jp", "amazon.co.uk", "amazon.de", "amazon.ca", "amazon.com.au",
  "a.co", "amzn.to", "amzn.asia", "amzn.eu",   // Amazon 分享短網址(轉到哪裡照樣逐跳檢查)
];
const MAX_BODY = 2_000_000, MAX_REDIRECTS = 4;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
function fetchTargetOk(u) {
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  return FETCH_HOSTS.some(d => h === d || h.endsWith("." + d));
}
async function proxyFetch(target, cors) {
  let u;
  try { u = new URL(target); } catch { return json({ error: "bad_url" }, 400, cors); }
  if (!fetchTargetOk(u)) return json({ error: "host_not_allowed" }, 403, cors);
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), 10000);
  try {
    let r;
    // 轉址自己一跳一跳跟:每一跳都要在白名單內(不然白名單網站的一個轉址就能把我們導去任意網址)
    for (let hop = 0; ; hop++) {
      r = await fetch(u.toString(), { redirect: "manual", signal: ac.signal, headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8" } });
      if (!REDIRECT.has(r.status)) break;
      try { await r.body?.cancel(); } catch {}
      let next = null;
      try { next = new URL(r.headers.get("Location") || "", u); } catch {}
      if (!next || hop >= MAX_REDIRECTS) return json({ error: "bad_redirect" }, 502, cors);
      if (!fetchTargetOk(next)) return json({ error: "redirect_not_allowed" }, 502, cors);
      u = next;
    }
    // 只有 200 算成功:讀墨這類「202 機器人挑戰頁」當失敗回 502,前端才會換下一個代理
    if (r.status !== 200) {
      try { await r.body?.cancel(); } catch {}
      return json({ error: "upstream_status", status: r.status }, 502, { ...cors, "X-Upstream-Status": String(r.status) });
    }
    // 原始位元組直接轉交(前端 r.text() 會自己用 UTF-8 解碼,結果和先解碼再編碼一樣),省下 2MB 來回轉碼的 CPU(免費方案每請求只有 10ms)
    const { buf, truncated } = await readUpTo(r.body, MAX_BODY);
    return new Response(buf, { status: 200, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store", "X-Upstream-Status": "200", "X-Truncated": truncated ? "1" : "0" } });
  } catch (e) {
    return json({ error: "fetch_failed", message: String((e && e.message) || e) }, 502, cors);
  } finally { clearTimeout(t); }
}

// 讀 stream 最多 max bytes 就停(不把整包讀進記憶體);truncated=讀到上限
async function readUpTo(stream, max) {
  if (!stream) return { buf: new Uint8Array(0), truncated: false };
  const reader = stream.getReader();
  const chunks = []; let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  try { await reader.cancel(); } catch {}
  const buf = new Uint8Array(Math.min(total, max)); let off = 0;
  for (const c of chunks) { const n = Math.min(c.length, buf.length - off); if (n <= 0) break; buf.set(c.subarray(0, n), off); off += n; }
  return { buf, truncated: total >= max };
}

// ── /v1/popularity(與前端 fetchPopularity 同一套規則,搬到伺服器端只是為了快取)──
const TITLE_STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for"]);
function distinctiveTitle(title) {
  const toks = String(title || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(w => w.length >= 3 && !TITLE_STOP.has(w));
  return toks.length >= 2;
}
async function olSignals(query) {
  const d = await getJSON(`${OL}?q=${encodeURIComponent(query)}&limit=5&fields=readinglog_count,edition_count`);
  const docs = d.docs || [];
  return { n: docs.length, rl: Math.max(0, ...docs.map(x => x.readinglog_count || 0), 0), ed: Math.max(0, ...docs.map(x => x.edition_count || 0), 0) };
}
async function olPopularity(title, author) {
  try {
    let { rl, ed, n } = await olSignals(`${title} ${author}`.trim());
    if (ed <= 2 && rl < 50 && distinctiveTitle(title)) { const alt = await olSignals(title); rl = Math.max(rl, alt.rl); ed = Math.max(ed, alt.ed); n += alt.n; }
    if (n === 0) return -1;
    const floor = ed >= 40 ? 9000 : ed >= 20 ? 3000 : ed >= 12 ? 1000 : 0;
    return Math.max(rl, floor);
  } catch { return null; }   // null = 上游掛了(不快取);-1 = 真的查無(快取)
}
async function popularity(env, sp) {
  const title  = (sp.get("title")  || "").trim().slice(0, 200);
  const author = (sp.get("author") || "").trim().slice(0, 100);
  if (!title) return { popularity: -1, error: "missing_title" };
  const key = `p:${norm(title)}|${norm(author)}`;
  const hit = await cacheGet(env, key);
  if (hit) return { ...hit, cached: true };
  const p = await olPopularity(title, author);
  if (p === null) return { popularity: -1, error: "upstream" };
  const out = { popularity: p };
  await cachePut(env, key, out, TTL.pop);
  return out;
}

/* Concento 前端煙霧測試(smoke test)
 * 用途:不需登入、不碰正式後端,直接在「已載入 app.js 的頁面」裡跑一輪功能回歸。
 * 跑法:
 *   1) 開 https://concento.io(或本機 preview),等 app.js 載入。
 *   2) 把本檔內容貼進 DevTools Console,或由自動化(preview_eval)注入後呼叫 runSmoke()。
 *   3) 看回傳 { total, passed, failed, fails }。failed>0 就是有回歸。
 * 設計:每測獨立 try/catch、跑完還原被動到的全域狀態,不污染正在看的頁面。
 * 限制:這層只測「前端邏輯/DOM 行為」。真・iOS Safari 手感(觸控/聚焦縮放/捲動鏈)
 *      與真後端讀寫,要靠真機 / Firebase Emulator+Playwright,見 [[bookshelf-env]]。
 */
function runSmoke() {
  const pass = [], fail = [];
  const ok  = (n) => pass.push(n);
  const bad = (n, d) => fail.push(n + " — " + d);
  const test = (n, fn) => { try { fn(); } catch (e) { bad(n, "throw: " + e.message); } };

  const bak = { allBooks, booksLoaded, currentLang, currentSort,
                currentFilter: JSON.parse(JSON.stringify(currentFilter)),
                selectedRating, finishStarRating };

  test("renderGrid 載入中狀態", () => {
    booksLoaded = false; allBooks = []; renderGrid();
    const t = bookGrid.textContent.trim();
    (t.includes("載入") || t.toLowerCase().includes("load")) ? ok("renderGrid 載入中狀態") : bad("renderGrid 載入中狀態", "got: " + t);
  });
  test("renderGrid 真空狀態", () => {
    booksLoaded = true; allBooks = []; renderGrid();
    const t = bookGrid.textContent.trim();
    (t.includes("找不到") || t.toLowerCase().includes("no books")) ? ok("renderGrid 真空狀態") : bad("renderGrid 真空狀態", "got: " + t);
  });
  test("renderGrid 有書渲染", () => {
    booksLoaded = true; allBooks = [{ id: "a", title: "書A", author: "x", status: "Now Reading" }]; renderGrid();
    document.querySelectorAll("#bookGrid .book-card").length === 1 ? ok("renderGrid 有書渲染") : bad("renderGrid 有書渲染", "no card");
  });
  test("版本篩選固定順序", () => {
    allBooks = [{ format: "Borrowed" }, { format: "Audiobook" }, { format: "Physical" }, { format: "Ebook" }];
    rebuildFormatFilter();
    const vals = [...document.getElementById("formatSelect").options].map(o => o.value).filter(v => v !== "all").join(",");
    vals === "Physical,Ebook,Audiobook,Borrowed" ? ok("版本篩選固定順序") : bad("版本篩選固定順序", vals);
  });
  test("狀態排序 status_asc", () => {
    allBooks = [{ id: "1", title: "a", status: "Finished",    createdAt: { seconds: 1 } },
                { id: "2", title: "b", status: "Now Reading", createdAt: { seconds: 1 } },
                { id: "3", title: "c", status: "TBR",         createdAt: { seconds: 1 } }];
    currentSort = "status_asc";
    currentFilter.status = "all"; currentFilter.search = ""; currentFilter.format = "all"; currentFilter.genre = "all"; currentFilter.year = "all";
    const order = filterBooks().map(b => b.status).join(">");
    order === "Now Reading>TBR>Finished" ? ok("狀態排序 status_asc") : bad("狀態排序 status_asc", order);
  });
  test("搜尋 ✕ 顯示/清除", () => {
    const si = document.getElementById("searchInput"), sc = document.getElementById("searchClear");
    si.value = "harry"; syncSearchClear();
    const shown = sc.style.display !== "none";
    sc.click();
    (shown && si.value === "" && currentFilter.search === "") ? ok("搜尋 ✕ 顯示/清除") : bad("搜尋 ✕ 顯示/清除", "shown=" + shown + " val=" + si.value);
  });
  test("詳情星等觸控拖曳", () => {
    document.getElementById("detailModal").classList.add("open");
    const sp = document.getElementById("starPicker"), r = sp.getBoundingClientRect();
    selectedRating = 0;
    const ev = new Event("touchmove", { cancelable: true }); ev.touches = [{ clientX: r.left + r.width * 0.7 }];
    sp.dispatchEvent(ev);
    document.getElementById("detailModal").classList.remove("open");
    selectedRating === 3.5 ? ok("詳情星等觸控拖曳") : bad("詳情星等觸控拖曳", "rating=" + selectedRating);
  });
  test("完成書星等觸控拖曳", () => {
    document.getElementById("finishReviewModal").classList.add("open");
    buildFinishStars();
    const fp = document.getElementById("finishStarInput"), r = fp.getBoundingClientRect();
    const ev = new Event("touchstart", { cancelable: true }); ev.touches = [{ clientX: r.left + r.width * 0.5 }];
    fp.dispatchEvent(ev);
    document.getElementById("finishReviewModal").classList.remove("open");
    (finishStarRating > 0 && ev.defaultPrevented) ? ok("完成書星等觸控拖曳") : bad("完成書星等觸控拖曳", "rating=" + finishStarRating + " prevented=" + ev.defaultPrevented);
  });
  test("i18n 中英切換", () => {
    setLang("zh-TW"); const zh = document.querySelector("#changelogFab .fb-fab-label").textContent;
    setLang("en");    const en = document.querySelector("#changelogFab .fb-fab-label").textContent;
    (zh === "更新日誌" && en === "What's New") ? ok("i18n 中英切換") : bad("i18n 中英切換", "zh=" + zh + " en=" + en);
  });
  test("更新日誌彈窗渲染", () => {
    document.getElementById("changelogFab").click();
    const n = document.querySelectorAll("#changelogList .cl-entry").length;
    document.getElementById("changelogModal").classList.remove("open");
    n >= 5 ? ok("更新日誌彈窗渲染") : bad("更新日誌彈窗渲染", "entries=" + n);
  });
  test("版本欄位選項齊全", () => {
    const v = [...document.getElementById("bookFormat").options].map(o => o.value).join(",");
    v === ",Physical,Ebook,Audiobook,Borrowed" ? ok("版本欄位選項齊全") : bad("版本欄位選項齊全", v);
  });
  test("auth 自救防迴圈守門", () => {
    sessionStorage.removeItem("authRecoverAt");
    const a = recentlyTriedAuthRecovery();
    sessionStorage.setItem("authRecoverAt", String(Date.now()));
    const b = recentlyTriedAuthRecovery();
    sessionStorage.removeItem("authRecoverAt");
    (!a && b) ? ok("auth 自救防迴圈守門") : bad("auth 自救防迴圈守門", "fresh=" + a + " set=" + b);
  });

  test("手機輸入框 16px(防 iOS 聚焦放大)", () => {
    if (window.innerWidth > 600) { ok("手機輸入框 16px [桌面寬度略過]"); return; }
    const ids = ["detailCurrentPage", "detailProgressPct", "progressMode", "bookTitle", "bookTotalPages", "searchInput", "finishReviewText"];
    const small = ids.filter(id => { const el = document.getElementById(id); return el && parseFloat(getComputedStyle(el).fontSize) < 16; });
    small.length === 0 ? ok("手機輸入框 16px(防 iOS 聚焦放大)") : bad("手機輸入框 16px(防 iOS 聚焦放大)", "<16px: " + small.join(","));
  });

  // 還原全域狀態
  allBooks = bak.allBooks; booksLoaded = bak.booksLoaded; currentSort = bak.currentSort;
  currentFilter = bak.currentFilter; selectedRating = bak.selectedRating; finishStarRating = bak.finishStarRating;
  if (currentLang !== bak.currentLang) setLang(bak.currentLang);
  try { renderGrid(); } catch (e) {}

  return { total: pass.length + fail.length, passed: pass.length, failed: fail.length, fails: fail };
}
if (typeof window !== "undefined") window.runSmoke = runSmoke;

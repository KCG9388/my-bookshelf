// ── Firebase Init ──
firebase.initializeApp(firebaseConfig);
const db   = firebase.firestore();
const auth = firebase.auth();

// ── State ──
let allBooks = [];
let currentUser  = null;
let booksCol     = null;
let booksUnsub   = null;
let currentFilter = { status: "all", year: "all", genre: "all", search: "", format: "all" };
let currentSort   = "createdAt_desc";
let currentDetailId = null;
let PAGE_SIZE = 24;          // 動態:依縮放比例算成「欄數 × 可塞排數」,讓每頁填滿、每排不缺本
let currentPage = 1;
// ── Phase B-3 狀態 ──
let activeCatalogKey = null;
let detailMode    = "shelf";   // "shelf" | "catalog"
let currentView   = "shelf";   // "shelf" | "explore"
let exploreBooks  = [];
let exploreLoaded = false;
let viewingPublicUid = null;
let myProfile = {};   // 快取本人 profile(含 shelfPublic/showReading,給動態判斷)
let feedSubtab = "following";

// ── DOM ──
const bookGrid      = document.getElementById("bookGrid");
const bookCountEl   = document.getElementById("bookCount");
const searchInput   = document.getElementById("searchInput");
const addModal      = document.getElementById("addModal");
const detailModal   = document.getElementById("detailModal");
const fetchStatus   = document.getElementById("fetchStatus");
const coverPreview  = document.getElementById("coverPreview");
const authModal     = document.getElementById("authModal");

// ══════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════

auth.onAuthStateChanged(user => {
  currentUser = user;
  if (user) {
    closeAuthModal();
    showApp();
    booksCol = db.collection("users").doc(user.uid).collection("books");
    updateUserUI(user);
    startBooksListener();
    ensureProfile(user)
      .then(() => backfillCatalog(user.uid))
      .then(() => migrateRatingsOnce(user.uid))
      .then(() => cleanupRatingNotesOnce(user.uid));
  } else {
    hideApp();
    showAuthModal();
    if (booksUnsub) { booksUnsub(); booksUnsub = null; }
    allBooks = [];
  }
});

function showApp() {
  document.getElementById("appHeader").style.display = "";
  document.getElementById("appBody").style.display   = "";
}
function hideApp() {
  document.getElementById("appHeader").style.display = "none";
  document.getElementById("appBody").style.display   = "none";
}
function showAuthModal() { authModal.classList.add("open"); }
function closeAuthModal() { authModal.classList.remove("open"); }

function updateUserUI(user) {
  const userInfo        = document.getElementById("userInfo");
  const userDisplayName = document.getElementById("userDisplayName");
  const userAvatarSm    = document.getElementById("userAvatarSm");

  userInfo.style.display = "";
  const name = user.displayName || user.email.split("@")[0];
  userDisplayName.textContent = name;

  if (user.photoURL) {
    userAvatarSm.innerHTML = `<img src="${user.photoURL}" alt="${escHtml(name)}" />`;
  } else {
    userAvatarSm.textContent = name.slice(0, 2).toUpperCase();
  }

  // 自動填入評論者姓名
  const reviewerNameEl = document.getElementById("reviewerName");
  if (reviewerNameEl && !reviewerNameEl.value) {
    reviewerNameEl.value = name;
  }
}

// 開始監聽使用者書庫
function startBooksListener() {
  if (booksUnsub) booksUnsub();
  booksUnsub = booksCol.orderBy("createdAt", "desc").onSnapshot(snapshot => {
    allBooks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    rebuildSidebarFilters();
    rebuildFormatFilter();
    refreshLayout();
  });
}

// ── 舊書庫自動匯入已移除（多人版修正）──
//   原本會在「每個新用戶」第一次登入時，問要不要把舊的 189 本複製進他帳號，
//   這在多人版是錯的：新用戶書庫就該是 0，自己匯入或輸入。
//   那 189 本舊書保留在 Firestore，Phase B 會拿來當「共享書目」的種子。

// ══════════════════════════════════════════
//  PHASE B-1 — 共享書庫 catalog + 使用者檔案
// ══════════════════════════════════════════

// 產生 catalog 鑰匙：正規化「書名+作者」（支援中英日文，去空白/標點/大小寫）
function catalogKeyFor(title, author) {
  const norm = s => (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")        // 去除重音記號
    .replace(/[^\p{L}\p{N}]+/gu, "");        // 只留字母與數字（Unicode）
  const k = (norm(title) + "_" + norm(author)).slice(0, 400);
  return k || "unknown";
}

// 把一本書 upsert 進共享 catalog（匿名，不含任何使用者資訊）
async function upsertCatalog(book) {
  const key = catalogKeyFor(book.title, book.author);
  const ref = db.collection("catalog").doc(key);
  try {
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        title:      book.title  || "",
        author:     book.author || "",
        genre:      book.genre  || "",
        totalPages: book.totalPages || 0,
        cover:      book.cover  || "",
        ratingCount: 0,
        ratingSum:   0,
        createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt:  firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      // 已存在：只補「原本沒有的封面」，絕不覆蓋評分聚合
      const patch = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      if (!snap.data().cover && book.cover) patch.cover = book.cover;
      await ref.set(patch, { merge: true });
    }
  } catch (e) { console.warn("catalog upsert failed:", e); }
  return key;
}

// 確保使用者公開檔案存在（顯示名稱/頭像/隱私開關；email 不放這裡）
async function ensureProfile(user) {
  const ref = db.collection("users").doc(user.uid);
  const base = {
    displayName: user.displayName || (user.email ? user.email.split("@")[0] : "Reader"),
    photoURL:    user.photoURL || "",
  };
  try {
    const snap = await ref.get();
    if (!snap.exists) {
      const init = {
        ...base,
        shelfPublic: false,   // 隱私預設：書庫不公開
        showReading: false,   // 隱私預設：不顯示「正在閱讀」
        createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
      };
      await ref.set(init);
      myProfile = init;
    } else {
      await ref.set(base, { merge: true });  // 只更新名稱/頭像，不動隱私開關
      myProfile = { ...snap.data(), ...base };
    }
  } catch (e) { console.warn("ensureProfile failed:", e); }
}

// 一次性：把使用者現有書架的書補進 catalog（冪等，用 profile 的 catalogSeeded 旗標守門）
async function backfillCatalog(uid) {
  const profRef = db.collection("users").doc(uid);
  try {
    const prof = await profRef.get();
    if (prof.exists && prof.data().catalogSeeded) return;
    const snap = await booksCol.get();
    for (const d of snap.docs) {
      const b   = d.data();
      const key = await upsertCatalog(b);
      if (!b.catalogKey) d.ref.update({ catalogKey: key }).catch(() => {});
    }
    await profRef.set({ catalogSeeded: true }, { merge: true });
    if (snap.size) console.log(`[catalog] 已把 ${snap.size} 本書補進共享書庫`);
  } catch (e) { console.warn("backfillCatalog failed:", e); }
}

// 一次性（僅限站長本人）：把舊書 notes 裡的 ★ 星等，轉成社群評分種子。
//   只認 SEED_OWNER_UID，避免測試帳號（持有 189 本複製品）污染評分。
const SEED_OWNER_UID = "oIogb2mbGdNPAZHvue0XMhOAi863";
async function migrateRatingsOnce(uid) {
  if (uid !== SEED_OWNER_UID) return;
  const profRef = db.collection("users").doc(uid);
  try {
    const prof = await profRef.get();
    if (prof.exists && prof.data().ratingsMigrated) return;   // 已遷移過
    const displayName = (prof.exists && prof.data().displayName) || "Reader";
    const photoURL    = (prof.exists && prof.data().photoURL)    || "";
    const snap = await booksCol.get();
    let migrated = 0;
    for (const d of snap.docs) {
      const b     = d.data();
      const stars = ((b.notes || "").match(/★/g) || []).length;   // 數實心星 = 星等
      if (stars < 1) continue;
      const key   = b.catalogKey || catalogKeyFor(b.title, b.author);
      // 用「讀完日期」當評分時間（沒有就用現在）
      let createdAt = firebase.firestore.FieldValue.serverTimestamp();
      if (b.finishDate) {
        const dt = new Date(b.finishDate);
        if (!isNaN(dt.getTime())) createdAt = firebase.firestore.Timestamp.fromDate(dt);
      }
      await applyReviewToCatalog(key, uid, {
        uid, reviewerName: displayName, rating: stars, text: "",
        readPercent: null, photoURL, createdAt,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        seededFromNotes: true,
      });
      migrated++;
    }
    await profRef.set({ ratingsMigrated: true }, { merge: true });
    if (migrated) console.log(`[ratings] 已把 ${migrated} 本書的星等轉成社群評分種子`);
  } catch (e) { console.warn("migrateRatingsOnce failed:", e); }
}

// ── Sign Out ──
document.getElementById("signOutBtn").addEventListener("click", () => {
  if (confirm("確定要登出嗎？")) auth.signOut();
});

// ── Auth Modal 邏輯 ──
let authMode = "signin";

document.querySelectorAll(".auth-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    authMode = tab.dataset.mode;
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");

    const isSignup = authMode === "signup";
    document.getElementById("authConfirmWrap").style.display    = isSignup ? "" : "none";
    document.getElementById("authDisplayNameWrap").style.display = isSignup ? "" : "none";
    document.getElementById("authSubmitBtn").textContent         = isSignup ? "Create Account" : "Sign In";
    document.getElementById("forgotPasswordBtn").style.display   = isSignup ? "none" : "";
    document.getElementById("authPassword").autocomplete = isSignup ? "new-password" : "current-password";
    clearAuthError();
  });
});

// Google 登入
document.getElementById("googleSignInBtn").addEventListener("click", async () => {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user") {
      showAuthError(getAuthErrorMessage(e.code));
    }
  }
});

// Email 登入 / 註冊
document.getElementById("authSubmitBtn").addEventListener("click", handleAuthSubmit);
["authEmail","authPassword","authConfirmPassword","authDisplayName"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") handleAuthSubmit(); });
});

async function handleAuthSubmit() {
  const email    = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  clearAuthError();

  if (!email || !password) { showAuthError("Please enter email and password."); return; }

  const btn = document.getElementById("authSubmitBtn");
  btn.disabled = true;
  btn.textContent = "...";

  try {
    if (authMode === "signup") {
      const confirmPw    = document.getElementById("authConfirmPassword").value;
      const displayName  = document.getElementById("authDisplayName").value.trim();
      if (password !== confirmPw) {
        showAuthError("Passwords do not match.");
        btn.disabled = false; btn.textContent = "Create Account"; return;
      }
      if (password.length < 6) {
        showAuthError("Password must be at least 6 characters.");
        btn.disabled = false; btn.textContent = "Create Account"; return;
      }
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      if (displayName) await cred.user.updateProfile({ displayName });
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
  } catch (e) {
    showAuthError(getAuthErrorMessage(e.code));
    btn.disabled = false;
    btn.textContent = authMode === "signup" ? "Create Account" : "Sign In";
  }
}

// 忘記密碼
document.getElementById("forgotPasswordBtn").addEventListener("click", async () => {
  const email = document.getElementById("authEmail").value.trim();
  if (!email) { showAuthError("Enter your email address first."); return; }
  try {
    await auth.sendPasswordResetEmail(email);
    showAuthError("✓ Password reset email sent! Check your inbox.", true);
  } catch (e) {
    showAuthError(getAuthErrorMessage(e.code));
  }
});

function showAuthError(msg, isSuccess = false) {
  const el = document.getElementById("authError");
  el.textContent = msg;
  el.style.display = "";
  el.style.background = isSuccess ? "#d4edda" : "#fde8e8";
  el.style.color      = isSuccess ? "#1a6632" : "#c0392b";
}
function clearAuthError() {
  const el = document.getElementById("authError");
  el.style.display = "none";
  el.textContent = "";
}
function getAuthErrorMessage(code) {
  const msgs = {
    "auth/user-not-found":        "No account found with this email.",
    "auth/wrong-password":        "Incorrect password.",
    "auth/invalid-credential":    "Incorrect email or password.",
    "auth/email-already-in-use":  "This email is already registered.",
    "auth/invalid-email":         "Invalid email address.",
    "auth/weak-password":         "Password must be at least 6 characters.",
    "auth/too-many-requests":     "Too many attempts. Please try again later.",
    "auth/network-request-failed":"Network error. Check your connection.",
  };
  return msgs[code] || "An error occurred. Please try again.";
}

// ══════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════

function filterBooks() {
  const { status, year, genre, search, format } = currentFilter;
  let books = allBooks.filter(b => {
    if (status !== "all" && b.status !== status) return false;
    if (year   !== "all" && String(b.startYear) !== year) return false;
    if (genre  !== "all" && (b.genre || "").toLowerCase() !== genre.toLowerCase()) return false;
    if (format !== "all" && (b.format || "").toLowerCase() !== format.toLowerCase()) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(b.title || "").toLowerCase().includes(q) && !(b.author || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const [field, dir] = currentSort.split("_");
  books.sort((a, b) => {
    let va, vb;
    if (field === "title" || field === "author") {
      va = (a[field] || "").toLowerCase(); vb = (b[field] || "").toLowerCase();
    } else if (field === "finishDate") {
      va = a.finishDate || ""; vb = b.finishDate || "";
    } else if (field === "progress") {
      va = calcPct(a.currentPage, a.totalPages) ?? -1;
      vb = calcPct(b.currentPage, b.totalPages) ?? -1;
    } else if (field === "totalPages") {
      va = a.totalPages || 0; vb = b.totalPages || 0;
    } else {
      va = a.createdAt?.seconds || 0; vb = b.createdAt?.seconds || 0;
    }
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1  : -1;
    return 0;
  });
  return books;
}

function renderGrid() {
  const books = filterBooks();
  bookCountEl.textContent = t(books.length === 1 ? "{n} book" : "{n} books", { n: books.length });

  if (books.length === 0) {
    bookGrid.innerHTML = `<div class="empty-state">No books found.</div>`;
    document.getElementById("pagination").style.display = "none";
    return;
  }

  const totalPages = Math.ceil(books.length / PAGE_SIZE);
  if (currentPage > totalPages) currentPage = 1;
  const pageBooks = books.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  bookGrid.innerHTML = pageBooks.map(b => {
    const pct = calcPct(b.currentPage, b.totalPages);
    const coverHTML = b.cover
      ? `<div class="book-cover"><img src="${escHtml(b.cover)}" alt="${escHtml(b.title)}" onerror="this.parentElement.innerHTML='<div class=no-cover><div class=no-cover-icon>📖</div><div class=no-cover-title>${escHtml(b.title)}</div></div>'" /></div>`
      : `<div class="no-cover"><div class="no-cover-icon">📖</div><div class="no-cover-title">${escHtml(b.title)}</div></div>`;
    return `
      <div class="book-card" data-id="${b.id}">
        ${coverHTML}
        <div class="book-info">
          <div class="book-title">${escHtml(b.title)}</div>
          <div class="book-author">${escHtml(b.author || "")}</div>
          <div class="book-genre">${escHtml(b.genre || "")}</div>
          <div class="progress-wrap">${pct !== null ? `
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
              <div class="progress-pct">${pct}%</div>` : ""}
          </div>
          <div class="book-status-row"><span class="status-badge status-${escHtml(b.status)}">${escHtml(t(b.status))}</span></div>
        </div>
      </div>`;
  }).join("");

  bookGrid.querySelectorAll(".book-card").forEach(card => {
    card.addEventListener("click", () => openDetail(card.dataset.id));
  });

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const pg = document.getElementById("pagination");
  if (totalPages <= 1) { pg.style.display = "none"; return; }
  pg.style.display = "flex";

  const show   = new Set([1, totalPages, currentPage, currentPage-1, currentPage+1, currentPage-2, currentPage+2].filter(p => p >= 1 && p <= totalPages));
  const sorted = [...show].sort((a,b) => a-b);

  let html = `<button class="page-btn" ${currentPage===1?"disabled":""} onclick="goPage(${currentPage-1})">‹</button>`;
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) html += `<span class="page-info">…</span>`;
    html += `<button class="page-btn ${p===currentPage?"active":""}" onclick="goPage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" ${currentPage===totalPages?"disabled":""} onclick="goPage(${currentPage+1})">›</button>`;
  html += `<span class="page-info">${currentPage} / ${totalPages}</span>`;
  pg.innerHTML = html;
}

function goPage(p) {
  currentPage = p;
  renderGrid();
  document.querySelector(".main").scrollTop = 0;
}

function calcPct(current, total) {
  if (!total || total <= 0) return null;
  if (!current || current <= 0) return 0;
  return Math.min(100, Math.round((current / total) * 100));
}

function escHtml(str) {
  return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Sidebar filters ──
function rebuildSidebarFilters() {
  const years  = [...new Set(allBooks.map(b => b.startYear).filter(Boolean))].sort((a,b) => b-a);
  const genres = [...new Set(allBooks.map(b => b.genre).filter(Boolean))].sort();

  const yearFilter = document.getElementById("yearFilter");
  yearFilter.innerHTML = `<option value="all">${t("All Years")}</option>` +
    years.map(y => `<option value="${y}">${y}</option>`).join("");
  yearFilter.value = currentFilter.year;
  yearFilter.onchange = () => setFilter("year", yearFilter.value);

  const genreFilter = document.getElementById("genreFilter");
  genreFilter.innerHTML = `<option value="all">${t("All Genres")}</option>` +
    genres.map(g => `<option value="${escHtml(g)}">${escHtml(g)}</option>`).join("");
  genreFilter.value = currentFilter.genre;
  genreFilter.onchange = () => setFilter("genre", genreFilter.value);
}

function setFilter(key, val) {
  currentFilter[key] = val;
  currentPage = 1;
  renderGrid();
  updateActiveFilters();
}

document.getElementById("statusFilter").querySelectorAll("li").forEach(li => {
  li.addEventListener("click", () => {
    setFilter("status", li.dataset.filter);
    document.getElementById("statusFilter").querySelectorAll("li").forEach(x => x.classList.remove("active"));
    li.classList.add("active");
  });
});

searchInput.addEventListener("input", e => {
  currentFilter.search = e.target.value.trim();
  currentPage = 1;
  renderGrid();
});

// ── Filter Bar ──
document.getElementById("sortSelect").addEventListener("change", e => {
  currentSort = e.target.value;
  currentPage = 1;
  renderGrid();
});

document.getElementById("formatSelect").addEventListener("change", e => {
  currentFilter.format = e.target.value;
  currentPage = 1;
  renderGrid();
  updateActiveFilters();
});

document.getElementById("clearFiltersBtn").addEventListener("click", () => {
  currentFilter = { ...currentFilter, status: "all", year: "all", genre: "all", format: "all", search: "" };
  document.getElementById("searchInput").value = "";
  document.getElementById("formatSelect").value = "all";
  document.getElementById("sortSelect").value = "createdAt_desc";
  currentSort = "createdAt_desc";
  currentPage = 1;
  document.querySelectorAll("#statusFilter li").forEach(li => li.classList.remove("active"));
  document.querySelector("#statusFilter li[data-filter='all']").classList.add("active");
  document.getElementById("yearFilter").value  = "all";
  document.getElementById("genreFilter").value = "all";
  renderGrid();
  updateActiveFilters();
});

// 排序 / 版本浮層:點按鈕開關、點外面關閉
(function setupSortPopover() {
  const btn = document.getElementById("sortToggleBtn");
  const pop = document.getElementById("sortPopover");
  if (!btn || !pop) return;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    pop.style.display = pop.style.display === "none" ? "" : "none";
  });
  document.addEventListener("click", e => {
    if (pop.style.display !== "none" && !pop.contains(e.target) && e.target !== btn)
      pop.style.display = "none";
  });
})();

// ── 書卡縮放 + 依比例自動填滿頁面 ──
const ZMIN = 120, ZMAX = 260, ZDEF = 160, ZSTEP = 16;
let _infoH = 150;  // 卡片資訊區高度(固定),量測後快取

function getCardW() {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue("--card-w"), 10) || ZDEF;
}

// 依目前卡片寬與可視區,算出「欄數 × 可塞排數」當作每頁數量 → 每排填滿、無殘缺
function computePageSize() {
  const grid = document.getElementById("bookGrid");
  if (!grid || !grid.clientWidth) return PAGE_SIZE;
  const cs   = getComputedStyle(grid);
  const gap  = parseFloat(cs.columnGap) || 20;
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop)  + parseFloat(cs.paddingBottom);
  const cardW = getCardW();
  const info = grid.querySelector(".book-info");
  if (info) _infoH = info.getBoundingClientRect().height;
  const cardH  = cardW * 1.5 + _infoH;
  const innerW = grid.clientWidth  - padX;
  const innerH = grid.clientHeight - padY;
  const cols = Math.max(1, Math.floor((innerW + gap) / (cardW + gap)));
  const rows = Math.max(1, Math.floor((innerH + gap) / (cardH + gap)));
  return cols * rows;
}

function refreshLayout() {
  // 第一趟:用估計值算頁面數量並渲染
  const next = computePageSize();
  if (next) PAGE_SIZE = next;
  if (currentView === "shelf") renderGrid();
  // 第二趟:用剛渲染出的真實卡片高度修正(僅在數量有變時再渲染一次,不會無限循環)
  const corrected = computePageSize();
  if (corrected && corrected !== PAGE_SIZE) {
    PAGE_SIZE = corrected;
    if (currentView === "shelf") renderGrid();
  }
}

// 只改卡片大小(便宜的 CSS 變更,拖曳時即時用)
function applyCardW(w) {
  w = Math.max(ZMIN, Math.min(ZMAX, Math.round(w)));
  document.documentElement.style.setProperty("--card-w", w + "px");
  localStorage.setItem("cardW", w);
  const range = document.getElementById("zoomRange");
  if (range && +range.value !== w) range.value = w;
  return w;
}
// 改大小 + 重算每頁填滿(按鈕/放開拖曳時用)
function setZoom(w) { applyCardW(w); refreshLayout(); }

(function setupZoom() {
  const saved = applyCardW(parseInt(localStorage.getItem("cardW"), 10) || ZDEF);
  const range = document.getElementById("zoomRange");
  const out   = document.getElementById("zoomOutBtn");
  const inn   = document.getElementById("zoomInBtn");
  if (range) {
    range.value = saved;
    range.addEventListener("input",  () => applyCardW(+range.value)); // 拖曳中:即時縮放
    range.addEventListener("change", () => refreshLayout());          // 放開:重算填滿
  }
  if (out) out.addEventListener("click", () => setZoom(getCardW() - ZSTEP));
  if (inn) inn.addEventListener("click", () => setZoom(getCardW() + ZSTEP));
  let t; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(refreshLayout, 150); });
})();

function updateActiveFilters() {
  const chips    = document.getElementById("activeFilters");
  const clearBtn = document.getElementById("clearFiltersBtn");
  const active   = [];
  if (currentFilter.format !== "all") active.push(`Format: ${currentFilter.format}`);
  chips.innerHTML = active.map(a => `<span class="filter-chip">${escHtml(a)}</span>`).join("");
  clearBtn.style.display = (active.length || currentFilter.status !== "all" || currentFilter.year !== "all" || currentFilter.genre !== "all" || currentFilter.search) ? "" : "none";
}

function rebuildFormatFilter() {
  const formats = [...new Set(allBooks.map(b => b.format).filter(Boolean))].sort();
  const sel = document.getElementById("formatSelect");
  const cur = sel.value;
  sel.innerHTML = `<option value="all">${t("All Formats")}</option>` + formats.map(f => `<option value="${escHtml(f)}">${escHtml(f)}</option>`).join("");
  if (formats.includes(cur)) sel.value = cur;
}

// ── Refresh Button ──
document.getElementById("refreshBtn").addEventListener("click", async () => {
  if (!booksCol) return;
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spinning");

  const seen = new Map();
  const toDelete = [];
  for (const b of allBooks) {
    const key = b.title.trim().toLowerCase();
    if (seen.has(key)) toDelete.push(b.id);
    else seen.set(key, b.id);
  }

  if (toDelete.length > 0) {
    const ok = confirm(t(toDelete.length === 1 ? "Found {n} duplicate book. Remove them?" : "Found {n} duplicate books. Remove them?", { n: toDelete.length }));
    if (ok) {
      for (const id of toDelete) await booksCol.doc(id).delete();
    }
  }

  const missing = allBooks.filter(b => !b.cover && !toDelete.includes(b.id));
  if (missing.length) queueCoverFetch(missing);

  btn.classList.remove("spinning");
  if (toDelete.length === 0 && missing.length === 0) {
    alert("✓ Library is up to date. No duplicates or missing covers found.");
  }
});

// ══════════════════════════════════════════
//  ADD / EDIT MODAL
// ══════════════════════════════════════════

document.getElementById("openAddModal").addEventListener("click", () => openAddModal());
document.getElementById("closeAddModal").addEventListener("click", closeAddModal);
document.getElementById("cancelAdd").addEventListener("click", closeAddModal);

function openAddModal(prefill) {
  resetAddForm();
  if (prefill) {
    fillForm(prefill);
  } else {
    addModal.dataset.mode = "add";
    currentDetailId = null;
    document.querySelector("#addModal .modal-header h2").textContent = t("Add Book");
  }
  addModal.classList.add("open");
}
function closeAddModal() { addModal.classList.remove("open"); }

// ── Fetch book info ──
document.getElementById("fetchBookBtn").addEventListener("click", fetchBookInfo);
document.getElementById("bookSearchInput").addEventListener("keydown", e => { if (e.key === "Enter") fetchBookInfo(); });

async function fetchBookInfo() {
  const query = document.getElementById("bookSearchInput").value.trim();
  if (!query) return;
  fetchStatus.textContent = "Searching...";

  const isISBN  = /^[\d\-X]{10,17}$/.test(query.replace(/\s/g, ""));
  const cleanISBN = query.replace(/[\s\-]/g, "");

  // 1. Open Library by ISBN
  if (isISBN) {
    try {
      const res  = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${cleanISBN}&format=json&jscmd=data`);
      const data = await res.json();
      const key  = `ISBN:${cleanISBN}`;
      if (data[key]) {
        const info    = data[key];
        const cover   = info.cover ? (info.cover.large || info.cover.medium || info.cover.small || "") : "";
        const authors = (info.authors || []).map(a => a.name).join(", ");
        const subjects= (info.subjects || []).map(s => s.name || s).slice(0, 2).join(", ");
        fillForm({ title: info.title || "", author: authors, genre: subjects, totalPages: info.number_of_pages || "", cover });
        fetchStatus.textContent = `Found: "${info.title}"`;
        return;
      }
    } catch {}
  }

  // 2. Google Books
  try {
    const apiQuery = isISBN ? `isbn:${cleanISBN}` : encodeURIComponent(query);
    const res  = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${apiQuery}&maxResults=1&key=${GBOOKS_KEY}`);
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      const info  = data.items[0].volumeInfo;
      const cover = info.imageLinks
        ? (info.imageLinks.extraLarge || info.imageLinks.large || info.imageLinks.thumbnail || "").replace("http://","https://")
        : "";
      fillForm({ title: info.title || "", author: (info.authors || []).join(", "), genre: (info.categories || []).join(", "), totalPages: info.pageCount || "", cover });
      fetchStatus.textContent = `Found: "${info.title}"`;
      return;
    }
  } catch {}

  // 3. Open Library by title search
  try {
    const res  = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=1`);
    const data = await res.json();
    if (data.docs && data.docs.length > 0) {
      const doc     = data.docs[0];
      const coverId = doc.cover_i;
      const cover   = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "";
      const authors = (doc.author_name || []).slice(0, 2).join(", ");
      const subjects= (doc.subject || []).slice(0, 2).join(", ");
      fillForm({ title: doc.title || "", author: authors, genre: subjects, totalPages: doc.number_of_pages_median || "", cover });
      fetchStatus.textContent = `Found: "${doc.title}"`;
      return;
    }
  } catch {}

  fetchStatus.textContent = "No results found. Fill in manually.";
}

function fillForm({ title="", author="", genre="", totalPages="", cover="" } = {}) {
  if (title)      document.getElementById("bookTitle").value      = title;
  if (author)     document.getElementById("bookAuthor").value     = author;
  if (genre)      document.getElementById("bookGenre").value      = genre;
  if (totalPages) document.getElementById("bookTotalPages").value = totalPages;
  if (cover)      setCover(cover);
}

// ── Cover Picker ──
const GALLERY_GRADIENTS = [
  "linear-gradient(135deg,#667eea,#764ba2)",
  "linear-gradient(135deg,#f093fb,#f5576c)",
  "linear-gradient(135deg,#4facfe,#00f2fe)",
  "linear-gradient(135deg,#43e97b,#38f9d7)",
  "linear-gradient(135deg,#fa709a,#fee140)",
  "linear-gradient(135deg,#f7971e,#ffd200)",
  "linear-gradient(135deg,#ff6b6b,#feca57)",
  "linear-gradient(135deg,#a8edea,#fed6e3)",
  "linear-gradient(135deg,#d299c2,#fef9d7)",
  "linear-gradient(135deg,#0f0c29,#302b63,#24243e)",
  "linear-gradient(135deg,#2d3436,#636e72)",
  "linear-gradient(135deg,#11998e,#38ef7d)",
  "linear-gradient(135deg,#ee0979,#ff6a00)",
  "linear-gradient(135deg,#1a1a2e,#16213e,#0f3460)",
  "linear-gradient(135deg,#fc5c7d,#6a3093)",
  "linear-gradient(135deg,#c94b4b,#4b134f)",
  "linear-gradient(135deg,#e0c3fc,#8ec5fc)",
  "linear-gradient(135deg,#fddb92,#d1fdff)",
];

function setCover(value) {
  document.getElementById("coverUrl").value = value;
  if (!value) {
    coverPreview.innerHTML = `<span>No Cover</span>`;
    coverPreview.style.background = "";
  } else if (value.startsWith("linear-gradient") || value.startsWith("#")) {
    coverPreview.innerHTML = "";
    coverPreview.style.background = value;
  } else {
    coverPreview.style.background = "";
    coverPreview.innerHTML = `<img src="${escHtml(value)}" alt="cover" onerror="this.parentElement.innerHTML='<span>No Cover</span>'" />`;
  }
}

const galleryGrid = document.getElementById("galleryGrid");
GALLERY_GRADIENTS.forEach(g => {
  const sw = document.createElement("div");
  sw.className = "gallery-swatch";
  sw.style.background = g;
  sw.title = "Use this gradient";
  sw.addEventListener("click", () => { setCover(g); closePicker(); });
  galleryGrid.appendChild(sw);
});

const pickerPanel = document.getElementById("coverPickerPanel");
document.getElementById("btnChangeCover").addEventListener("click", () => {
  pickerPanel.style.display = pickerPanel.style.display === "none" ? "" : "none";
});
document.getElementById("pickerCloseBtn").addEventListener("click", closePicker);
document.getElementById("pickerRemoveBtn").addEventListener("click", () => { setCover(""); closePicker(); });
function closePicker() { pickerPanel.style.display = "none"; }

document.querySelectorAll(".picker-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".picker-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".picker-pane").forEach(p => p.style.display = "none");
    document.getElementById("pane-" + tab.dataset.tab).style.display = "";
  });
});

const coverDropZone  = document.getElementById("coverDropZone");
const coverFileInput = document.getElementById("coverFileInput");
coverDropZone.addEventListener("dragover",  e => { e.preventDefault(); coverDropZone.classList.add("drag-over"); });
coverDropZone.addEventListener("dragleave", () => coverDropZone.classList.remove("drag-over"));
coverDropZone.addEventListener("drop",      e => { e.preventDefault(); coverDropZone.classList.remove("drag-over"); handleCoverFile(e.dataTransfer.files[0]); });
coverFileInput.addEventListener("change",   e => handleCoverFile(e.target.files[0]));

function handleCoverFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = ev => { setCover(ev.target.result); closePicker(); };
  reader.readAsDataURL(file);
}

document.addEventListener("paste", e => {
  if (pickerPanel.style.display === "none") return;
  const item = [...e.clipboardData.items].find(i => i.type.startsWith("image/"));
  if (item) handleCoverFile(item.getAsFile());
});

document.getElementById("coverLinkSubmit").addEventListener("click", () => {
  const url = document.getElementById("coverLinkInput").value.trim();
  if (url) { setCover(url); closePicker(); document.getElementById("coverLinkInput").value = ""; }
});
document.getElementById("coverLinkInput").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("coverLinkSubmit").click();
});

document.getElementById("refetchCoverBtn").addEventListener("click", async () => {
  const btn    = document.getElementById("refetchCoverBtn");
  const title  = document.getElementById("bookTitle").value.trim();
  const author = document.getElementById("bookAuthor").value.trim();
  if (!title) { alert("Please enter a title first."); return; }
  btn.classList.add("loading"); btn.disabled = true;
  const cover = await fetchCoverUrl(title, author);
  btn.classList.remove("loading"); btn.disabled = false;
  if (cover) setCover(cover);
  else alert("No cover found. Try a different title or use the Link / Upload tab.");
});

// ── Screenshot Capture & Crop ──
let cropStart = null, cropRect = null, screenshotImageData = null;
const overlay    = document.getElementById("screenshotOverlay");
const canvas     = document.getElementById("screenshotCanvas");
const ctx        = canvas.getContext("2d");
const selBox     = document.getElementById("screenshotSelection");
const confirmBox = document.getElementById("screenshotConfirm");

document.getElementById("startScreenshotBtn").addEventListener("click", async () => {
  closePicker();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "always" }, audio: false });
    const video  = document.createElement("video");
    video.srcObject = stream;
    await video.play();
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    stream.getTracks().forEach(t => t.stop());
    screenshotImageData = canvas.toDataURL("image/png");
    overlay.style.display = "flex";
    selBox.style.display = "none";
    confirmBox.style.display = "none";
    cropStart = null; cropRect = null;
  } catch (e) {
    if (e.name !== "NotAllowedError") alert("Screenshot failed: " + e.message);
  }
});

document.getElementById("screenshotCancel").addEventListener("click", () => { overlay.style.display = "none"; });

canvas.addEventListener("mousedown", e => {
  const r = canvas.getBoundingClientRect();
  cropStart = { x: e.clientX - r.left, y: e.clientY - r.top };
  selBox.style.display = "none";
  confirmBox.style.display = "none";
  cropRect = null;
});
canvas.addEventListener("mousemove", e => {
  if (!cropStart) return;
  const r  = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left, cy = e.clientY - r.top;
  const x  = Math.min(cropStart.x, cx), y = Math.min(cropStart.y, cy);
  const w  = Math.abs(cx - cropStart.x), h = Math.abs(cy - cropStart.y);
  selBox.style.cssText = `display:block;left:${r.left+x}px;top:${r.top+y}px;width:${w}px;height:${h}px;`;
  cropRect = { x, y, w, h, scaleX: canvas.width/r.width, scaleY: canvas.height/r.height };
});
canvas.addEventListener("mouseup", () => {
  if (!cropRect || cropRect.w < 10 || cropRect.h < 10) { cropStart = null; return; }
  cropStart = null;
  confirmBox.style.display = "flex";
});

document.getElementById("screenshotUse").addEventListener("click", () => {
  const { x, y, w, h, scaleX, scaleY } = cropRect;
  const tmp = document.createElement("canvas");
  tmp.width  = w * scaleX; tmp.height = h * scaleY;
  tmp.getContext("2d").drawImage(canvas, x*scaleX, y*scaleY, w*scaleX, h*scaleY, 0, 0, tmp.width, tmp.height);
  setCover(tmp.toDataURL("image/png"));
  overlay.style.display = "none";
});
document.getElementById("screenshotRetry").addEventListener("click", () => {
  selBox.style.display = "none";
  confirmBox.style.display = "none";
  cropRect = null; cropStart = null;
});

function resetAddForm() {
  ["bookSearchInput","bookTitle","bookAuthor","bookGenre","bookCurrentPage","bookStartDate","bookFinishDate","bookNotes"]
    .forEach(id => document.getElementById(id).value = "");
  document.getElementById("bookTotalPages").value = "";
  document.getElementById("bookStatus").value = "Want to Read";
  setCover(""); closePicker();
  fetchStatus.textContent = "";
}

// ── Save Book ──
document.getElementById("saveBook").addEventListener("click", async () => {
  if (!booksCol) { alert(t("Please sign in first.")); return; }
  const title = document.getElementById("bookTitle").value.trim();
  if (!title) { alert(t("Title is required.")); return; }

  const startDate = document.getElementById("bookStartDate").value;
  const book = {
    title,
    author:      document.getElementById("bookAuthor").value.trim(),
    genre:       document.getElementById("bookGenre").value.trim(),
    totalPages:  parseInt(document.getElementById("bookTotalPages").value) || 0,
    currentPage: parseInt(document.getElementById("bookCurrentPage").value) || 0,
    status:      document.getElementById("bookStatus").value,
    cover:       document.getElementById("coverUrl").value.trim(),
    startDate,
    finishDate:  document.getElementById("bookFinishDate").value,
    notes:       document.getElementById("bookNotes").value.trim(),
    startYear:   startDate ? new Date(startDate).getFullYear() : new Date().getFullYear(),
    userId:      currentUser?.uid || null,
    createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    const existing = (currentDetailId && addModal.dataset.mode === "edit") ? allBooks.find(b => b.id === currentDetailId) : null;
    const statusChanged = !existing || existing.status !== book.status;
    book.catalogKey = await upsertCatalog(book);   // 同步進共享書庫，並記下指向 catalog 的鑰匙
    if (currentDetailId && addModal.dataset.mode === "edit") {
      await booksCol.doc(currentDetailId).update({ ...book });
    } else {
      await booksCol.add(book);
    }
    // 動態事件(依隱私旗標)
    if (statusChanged) {
      const ctx = { key: book.catalogKey, title: book.title, cover: book.cover };
      if (book.status === "Finished" && myProfile.shelfPublic)      logActivity("finished", ctx);
      else if (book.status === "Now Reading" && myProfile.showReading) logActivity("now_reading", ctx);
    }
    closeAddModal();
  } catch (e) {
    alert("Save failed: " + e.message);
  }
});

// ══════════════════════════════════════════
//  DETAIL MODAL
// ══════════════════════════════════════════

function openDetail(id) {
  currentDetailId = id;
  const b = allBooks.find(x => x.id === id);
  if (!b) return;

  // 書架模式:還原私人書架專屬區塊、隱藏「加入書架」鈕
  detailMode = "shelf";
  activeCatalogKey = b.catalogKey || catalogKeyFor(b.title, b.author);
  document.querySelectorAll(".detail-shelf-only").forEach(el => el.style.display = "");
  const addShelfBtn = document.getElementById("addToShelfBtn");
  if (addShelfBtn) addShelfBtn.style.display = "none";
  document.getElementById("detailCover").style.display = "";

  document.getElementById("detailTitle").textContent  = b.title;
  document.getElementById("detailAuthor").textContent = b.author || "";
  document.getElementById("detailGenre").textContent  = b.genre  || "";

  const statusEl = document.getElementById("detailStatus");
  statusEl.innerHTML = `<span class="status-badge status-${escHtml(b.status)}">${escHtml(t(b.status))}</span>`;

  const pct = calcPct(b.currentPage, b.totalPages);
  document.getElementById("detailProgressBar").style.width  = pct !== null ? pct + "%" : "0%";
  document.getElementById("detailProgressText").textContent = pct !== null
    ? `${b.currentPage || 0} / ${b.totalPages} pages (${pct}%)`
    : "No page info";

  document.getElementById("detailCurrentPage").value         = b.currentPage || 0;
  document.getElementById("detailTotalPages").textContent    = `/ ${b.totalPages || "?"} pages`;

  const coverEl = document.getElementById("detailCover");
  if (b.cover) {
    coverEl.src = b.cover;
    coverEl.onerror = () => { coverEl.src = ""; coverEl.style.display = "none"; };
    coverEl.style.display = "";
  } else {
    coverEl.style.display = "none";
  }

  const dates = [];
  if (b.startDate)  dates.push(`Started: ${b.startDate}`);
  if (b.finishDate) dates.push(`Finished: ${b.finishDate}`);
  document.getElementById("detailDates").textContent = dates.join("  ·  ");
  document.getElementById("detailNotes").textContent = b.notes || "";

  detailModal.classList.add("open");
  loadReviews(b.catalogKey || catalogKeyFor(b.title, b.author));
  loadDiscussion(b.catalogKey || catalogKeyFor(b.title, b.author));

  // Reset review form
  selectedRating = 0;
  renderStars(0);
  updateStarLabel(0, true);
  document.getElementById("reviewText").value = "";

  // Auto-fill reviewer name from current user
  if (currentUser) {
    const name = currentUser.displayName || currentUser.email.split("@")[0];
    document.getElementById("reviewerName").value = name;
  }

  // Auto read %
  const reviewPct = calcPct(b.currentPage, b.totalPages) ?? 0;
  document.getElementById("reviewPct").value = reviewPct;
  const readInfoEl = document.getElementById("reviewReadInfo");
  if (b.totalPages) {
    readInfoEl.innerHTML = `📖 Based on your progress: <strong>${reviewPct}%</strong> read (${b.currentPage || 0} / ${b.totalPages} pages)`;
  } else {
    readInfoEl.innerHTML = `📖 No page data — your progress will be shown as <strong>${reviewPct}%</strong>`;
  }
}

document.getElementById("closeDetailModal").addEventListener("click", () => {
  detailModal.classList.remove("open");
  if (reviewsUnsub) { reviewsUnsub(); reviewsUnsub = null; }
});
detailModal.addEventListener("click", e => {
  if (e.target === detailModal) {
    detailModal.classList.remove("open");
    if (reviewsUnsub) { reviewsUnsub(); reviewsUnsub = null; }
  }
});

// ══════════════════════════════════════════
//  REVIEWS
// ══════════════════════════════════════════

let selectedRating = 0;
let reviewsUnsub   = null;

// Build quarter-star picker
(function buildStarPicker() {
  const picker = document.getElementById("starPicker");
  picker.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const unit = document.createElement("span");
    unit.className    = "star-unit";
    unit.dataset.star = i;
    unit.innerHTML    = `<span class="star-bg">★</span><span class="star-fg">★</span>`;
    picker.appendChild(unit);
  }

  function ratingFromEvent(e) {
    const rect      = picker.getBoundingClientRect();
    const x         = Math.max(0, e.clientX - rect.left);
    const starWidth = rect.width / 5;
    const starIdx   = Math.min(4, Math.floor(x / starWidth));
    const fraction  = (x - starIdx * starWidth) / starWidth;
    const quarter   = Math.ceil(fraction / 0.25) * 0.25 || 0.25;
    return Math.min(5, +(starIdx + quarter).toFixed(2));
  }

  picker.addEventListener("mousemove",  e => { renderStars(ratingFromEvent(e)); updateStarLabel(ratingFromEvent(e), false); });
  picker.addEventListener("mouseleave", () => { renderStars(selectedRating); updateStarLabel(selectedRating, true); });
  picker.addEventListener("click",      e => {
    selectedRating = ratingFromEvent(e);
    renderStars(selectedRating);
    updateStarLabel(selectedRating, true);
  });
})();

function renderStars(rating) {
  document.querySelectorAll("#starPicker .star-unit").forEach((unit, i) => {
    const fg   = unit.querySelector(".star-fg");
    const diff = rating - i;
    if (diff >= 1)     fg.style.width = "100%";
    else if (diff > 0) fg.style.width = (diff * 100).toFixed(0) + "%";
    else               fg.style.width = "0%";
  });
}

function updateStarLabel(rating, committed) {
  const el = document.getElementById("starPickLabel");
  if (!rating) { el.textContent = t("Select rating"); el.style.color = "#9b9a97"; return; }
  const label =
    rating <= 1 ? t("😞 Didn't like it") :
    rating <= 2 ? t("😐 It was ok")       :
    rating <= 3 ? t("🙂 Liked it")        :
    rating <= 4 ? t("😊 Really liked it") :
                  t("🤩 Amazing!");
  el.textContent = `${rating} — ${label}`;
  el.style.color = committed ? "#f0a500" : "#6b6b68";
}

function starsHTML(rating) {
  if (!rating) return "";
  let html = "";
  for (let i = 1; i <= 5; i++) {
    const diff = rating - (i - 1);
    if      (diff >= 1)    html += `<span style="color:#f0a500">★</span>`;
    else if (diff >= 0.75) html += `<span style="color:#f0a500;opacity:.85">★</span>`;
    else if (diff >= 0.5)  html += `<span style="color:#f0a500;opacity:.6">★</span>`;
    else if (diff >= 0.25) html += `<span style="color:#f0a500;opacity:.35">★</span>`;
    else                   html += `<span style="color:#ddd">★</span>`;
  }
  return html;
}

// 目前詳情 Modal 對應的 catalog 鑰匙(書架模式與探索模式共用)
function currentCatalogKey() { return activeCatalogKey; }

// 新增/編輯公開評論（一人一書一則：用 uid 當文件 id），並用交易同步更新平均分
async function applyReviewToCatalog(catalogKey, uid, reviewData) {
  const catRef = db.collection("catalog").doc(catalogKey);
  const revRef = catRef.collection("reviews").doc(uid);
  await db.runTransaction(async tx => {
    const catSnap = await tx.get(catRef);
    const revSnap = await tx.get(revRef);
    let sum   = (catSnap.exists && catSnap.data().ratingSum)   || 0;
    let count = (catSnap.exists && catSnap.data().ratingCount) || 0;
    const newR = reviewData.rating || 0;
    if (revSnap.exists) {
      sum = sum - (revSnap.data().rating || 0) + newR;   // 編輯：調整差額
    } else {
      sum += newR; count += 1;                            // 新增
    }
    const data = { ...reviewData };
    if (revSnap.exists && revSnap.data().createdAt) data.createdAt = revSnap.data().createdAt; // 編輯保留原始時間
    tx.set(revRef, data);
    tx.set(catRef, {
      ratingSum: sum, ratingCount: count,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

// 刪除自己的公開評論，並用交易回扣平均分
async function removeReviewFromCatalog(catalogKey, uid) {
  const catRef = db.collection("catalog").doc(catalogKey);
  const revRef = catRef.collection("reviews").doc(uid);
  await db.runTransaction(async tx => {
    const revSnap = await tx.get(revRef);
    const catSnap = await tx.get(catRef);
    if (!revSnap.exists) return;
    const r = revSnap.data().rating || 0;
    let sum   = (catSnap.exists && catSnap.data().ratingSum)   || 0;
    let count = (catSnap.exists && catSnap.data().ratingCount) || 0;
    tx.delete(revRef);
    tx.set(catRef, {
      ratingSum:   Math.max(0, sum - r),
      ratingCount: Math.max(0, count - 1),
      updatedAt:   firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

// 讀取某本書的「全站公開評論」
function loadReviews(catalogKey) {
  if (reviewsUnsub) reviewsUnsub();
  if (!catalogKey) { renderReviews([]); return; }
  const reviewsCol = db.collection("catalog").doc(catalogKey).collection("reviews");
  reviewsUnsub = reviewsCol.orderBy("createdAt", "desc").onSnapshot(
    snap => renderReviews(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err  => { console.warn("loadReviews:", err); renderReviews([]); }
  );
}

function renderReviews(reviews) {
  const aggScore    = document.getElementById("aggScore");
  const aggStars    = document.getElementById("aggStars");
  const aggCount    = document.getElementById("aggCount");
  const ratingBars  = document.getElementById("ratingBars");
  const reviewsList = document.getElementById("reviewsList");

  if (!reviews.length) {
    aggScore.textContent = "—"; aggStars.innerHTML = ""; aggCount.textContent = t("No reviews yet");
    ratingBars.innerHTML = "";
    reviewsList.innerHTML = `<div class="reviews-empty">${t("📝 No reviews yet — be the first!")}</div>`;
    return;
  }

  const withRating = reviews.filter(r => r.rating > 0);
  const avg = withRating.length ? withRating.reduce((s,r) => s+r.rating, 0) / withRating.length : 0;
  aggScore.textContent = avg.toFixed(1);
  aggStars.innerHTML   = starsHTML(avg);
  aggCount.textContent = t(reviews.length === 1 ? "{n} review" : "{n} reviews", { n: reviews.length });

  const counts = [0,0,0,0,0,0];
  withRating.forEach(r => { const n = Math.round(r.rating); if (n >= 1 && n <= 5) counts[n]++; });
  ratingBars.innerHTML = [5,4,3,2,1].map(n => {
    const pct = withRating.length ? Math.round((counts[n]/withRating.length)*100) : 0;
    return `<div class="rating-bar-row">
      <span class="bar-label">${n}★</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span class="bar-count">${counts[n]}</span>
    </div>`;
  }).join("");

  reviewsList.innerHTML = reviews.map(r => {
    const isOwn    = currentUser && (r.uid === currentUser.uid || r.id === currentUser.uid);
    const initials = (r.reviewerName || "?").slice(0, 2).toUpperCase();
    const date     = r.createdAt?.toDate
      ? r.createdAt.toDate().toLocaleDateString("en-US", { year:"numeric", month:"short", day:"numeric" })
      : "";
    return `<div class="review-card">
      <div class="review-top">
        <div class="reviewer-avatar">${escHtml(initials)}</div>
        <div class="reviewer-name clickable" data-uid="${escHtml(r.uid || r.id || "")}">${escHtml(r.reviewerName || "Anonymous")}</div>
        ${r.rating ? `<div class="review-stars">${starsHTML(r.rating)}<span class="review-score">${r.rating}</span></div>` : ""}
        ${r.readPercent != null ? `<div class="review-read-badge">Read ${r.readPercent}%</div>` : ""}
        ${isOwn ? `<button class="btn-delete-review" data-id="${r.id}" title="Delete your review">🗑</button>` : ""}
      </div>
      ${r.text ? `<div class="review-text">${escHtml(r.text)}</div>` : ""}
      <div class="review-date">${date}</div>
      <div class="review-replies" data-rev="${escHtml(r.uid || r.id || "")}">
        <button class="review-reply-toggle" data-rev="${escHtml(r.uid || r.id || "")}">💬 ${t("Reply")}</button>
      </div>
    </div>`;
  }).join("");

  // Bind delete buttons
  reviewsList.querySelectorAll(".btn-delete-review").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete your review?")) return;
      try {
        await removeReviewFromCatalog(currentCatalogKey(), currentUser.uid);
      } catch(e) { alert("Failed to delete: " + e.message); }
    });
  });

  // Bind 評論者名稱 → 看對方公開書架
  reviewsList.querySelectorAll(".reviewer-name.clickable").forEach(el => {
    el.addEventListener("click", () => {
      const uid = el.dataset.uid;
      if (uid) { detailModal.classList.remove("open"); loadPublicShelf(uid); }
    });
  });

  // Bind 回覆展開
  reviewsList.querySelectorAll(".review-reply-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.style.display = "none";
      expandReplies(btn.dataset.rev, btn.closest(".review-replies"));
    });
  });
}

document.getElementById("submitReviewBtn").addEventListener("click", async () => {
  if (!currentUser) { alert(t("Please sign in first.")); return; }
  const name = document.getElementById("reviewerName").value.trim();
  const text = document.getElementById("reviewText").value.trim();
  const pct  = parseInt(document.getElementById("reviewPct").value);
  if (!name)           { alert(t("Please enter your name or nickname.")); return; }
  if (!selectedRating) { alert(t("Please select a star rating.")); return; }

  const catalogKey = currentCatalogKey();
  if (!catalogKey)     { alert(t("Cannot locate this book in the catalog.")); return; }

  const btn = document.getElementById("submitReviewBtn");
  btn.disabled = true; btn.textContent = t("Submitting...");
  try {
    await applyReviewToCatalog(catalogKey, currentUser.uid, {
      uid:          currentUser.uid,
      reviewerName: name,
      rating:       selectedRating,
      text,
      readPercent:  Number.isFinite(pct) ? pct : null,
      photoURL:     currentUser.photoURL || "",
      createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:    firebase.firestore.FieldValue.serverTimestamp(),
    });
    logActivity("review",
      { key: catalogKey, title: document.getElementById("detailTitle").textContent, cover: document.getElementById("detailCover").src },
      { rating: selectedRating, text });
    document.getElementById("reviewText").value = "";
    selectedRating = 0; renderStars(0); updateStarLabel(0, true);
  } catch(e) { alert(t("Failed") + ": " + e.message); }
  btn.disabled = false; btn.textContent = t("Submit Review");
});

document.getElementById("updatePageBtn").addEventListener("click", async () => {
  if (!currentDetailId || !booksCol) return;
  const newPage = parseInt(document.getElementById("detailCurrentPage").value) || 0;
  const b = allBooks.find(x => x.id === currentDetailId);
  const updates = { currentPage: newPage };
  if (b && b.totalPages && newPage >= b.totalPages) updates.status = "Finished";
  await booksCol.doc(currentDetailId).update(updates);
  openDetail(currentDetailId);
});

document.getElementById("editBookBtn").addEventListener("click", () => {
  const b = allBooks.find(x => x.id === currentDetailId);
  if (!b) return;
  detailModal.classList.remove("open");
  addModal.dataset.mode = "edit";
  openAddModal({ title: b.title, author: b.author, genre: b.genre, totalPages: b.totalPages, cover: b.cover });
  document.getElementById("bookCurrentPage").value = b.currentPage || 0;
  document.getElementById("bookStatus").value       = b.status || "Want to Read";
  document.getElementById("bookStartDate").value    = b.startDate || "";
  document.getElementById("bookFinishDate").value   = b.finishDate || "";
  document.getElementById("bookNotes").value        = b.notes || "";
  document.querySelector("#addModal .modal-header h2").textContent = t("Edit Book");
});

document.getElementById("deleteBookBtn").addEventListener("click", async () => {
  if (!currentDetailId || !booksCol) return;
  if (!confirm("Delete this book?")) return;
  await booksCol.doc(currentDetailId).delete();
  detailModal.classList.remove("open");
});

// ══════════════════════════════════════════
//  IMPORT MODAL
// ══════════════════════════════════════════

const importModal     = document.getElementById("importModal");
const importFileInput = document.getElementById("importFileInput");
const importDropZone  = document.getElementById("importDropZone");
const startImportBtn  = document.getElementById("startImportBtn");
let parsedBooks = [];

document.getElementById("openImportModal").addEventListener("click", () => { resetImport(); importModal.classList.add("open"); });
document.getElementById("closeImportModal").addEventListener("click", closeImport);
document.getElementById("cancelImport").addEventListener("click", closeImport);
importModal.addEventListener("click", e => { if (e.target === importModal) closeImport(); });

function closeImport() { importModal.classList.remove("open"); resetImport(); }

function resetImport() {
  parsedBooks = [];
  importFileInput.value = "";
  document.getElementById("importPreview").style.display  = "none";
  document.getElementById("importProgress").style.display = "none";
  document.getElementById("importDropZone").style.display = "";
  importDropZone.innerHTML = `<div class="upload-icon">📂</div><div class="upload-text">${t("Drag & drop your CSV file here")}<br/><span>${t("or click to browse")}</span></div><input type="file" id="importFileInput" accept=".csv" style="display:none" />`;
  bindFileInput();
  startImportBtn.disabled  = true;
  startImportBtn.textContent = "Import Books";
}

function bindFileInput() {
  const fi = document.getElementById("importFileInput");
  importDropZone.addEventListener("click",    () => fi.click());
  fi.addEventListener("change",               e  => handleFile(e.target.files[0]));
  importDropZone.addEventListener("dragover", e  => { e.preventDefault(); importDropZone.classList.add("drag-over"); });
  importDropZone.addEventListener("dragleave",() => importDropZone.classList.remove("drag-over"));
  importDropZone.addEventListener("drop",     e  => { e.preventDefault(); importDropZone.classList.remove("drag-over"); handleFile(e.dataTransfer.files[0]); });
}
bindFileInput();

function handleFile(file) {
  if (!file || !file.name.endsWith(".csv")) { alert("Please upload a .csv file exported from Notion."); return; }
  const reader = new FileReader();
  reader.onload = e => parseNotionCSV(e.target.result, file.name);
  reader.readAsText(file, "UTF-8");
}

function parseNotionCSV(text, filename) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) { alert("CSV appears empty."); return; }
  const headers = parseCSVRow(lines[0]).map(h => h.trim().toLowerCase());

  const col = name => {
    const aliases = {
      title:       ["title"],
      author:      ["author", " author"],
      genre:       ["genre"],
      status:      ["status"],
      currentpage: ["current page","currentpage","current_page"],
      totalpages:  ["total pages","totalpages","total_pages"],
      finishdate:  ["date finished","finish date","finishdate","date_finished"],
      startdate:   ["date started","start date","startdate","date_started"],
      rating:      ["rate","rating"],
    };
    const list = aliases[name] || [name];
    for (const a of list) { const i = headers.indexOf(a); if (i !== -1) return i; }
    return -1;
  };

  if (col("title") === -1) { alert("Could not find a 'Title' column."); return; }

  parsedBooks = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVRow(lines[i]);
    const get   = name => (cells[col(name)] || "").trim();

    const title = cleanNotionCell(get("title"));
    if (!title) continue;

    const finishDate = parseNotionDate(cleanNotionCell(get("finishdate")));
    const startDate  = parseNotionDate(cleanNotionCell(get("startdate")));
    const finishYear = finishDate ? new Date(finishDate).getFullYear() : null;
    const startYear  = startDate  ? new Date(startDate).getFullYear()  : null;
    const ratingRaw  = cleanNotionCell(get("rating"));
    const stars      = (ratingRaw.match(/★/g) || []).length;
    const notes      = stars > 0 ? `Rating: ${"★".repeat(stars)}${"☆".repeat(5-stars)}` : "";

    parsedBooks.push({
      title,
      author:      cleanNotionCell(get("author")),
      genre:       cleanNotionCell(get("genre")),
      status:      cleanNotionCell(get("status")) || "Want to Read",
      currentPage: parseInt(cleanNotionCell(get("currentpage"))) || 0,
      totalPages:  parseInt(cleanNotionCell(get("totalpages"))) || 0,
      finishDate, startDate,
      startYear:   startYear || finishYear || new Date().getFullYear(),
      cover: "", notes,
      userId:    currentUser?.uid || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
  showPreview(filename);
}

function cleanNotionCell(str) {
  if (!str) return "";
  return str.replace(/\s*\(https?:\/\/[^)]+\)/g, "").trim();
}
function parseNotionDate(str) {
  if (!str) return "";
  const d = new Date(str);
  if (isNaN(d)) return "";
  return d.toISOString().split("T")[0];
}
function parseCSVRow(line) {
  const result = []; let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQuote && line[i+1] === '"') { cur += '"'; i++; } else inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur); cur = ""; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

function showPreview(filename) {
  importDropZone.innerHTML = `<div class="upload-icon">✅</div><div class="upload-text"><div class="upload-filename">${filename}</div><span style="color:#6b6b68;text-decoration:none">${t("Click to change file")}</span></div><input type="file" id="importFileInput" accept=".csv" style="display:none" />`;
  bindFileInput();

  const preview = document.getElementById("importPreview");
  document.getElementById("previewSummary").textContent = t("Found {n} books ready to import.", { n: parsedBooks.length });

  const sample = parsedBooks.slice(0, 5);
  const table  = document.getElementById("previewTable");
  table.innerHTML = `
    <thead><tr><th>Title</th><th>Author</th><th>Genre</th><th>Status</th><th>Pages</th></tr></thead>
    <tbody>${sample.map(b => `<tr>
      <td title="${b.title}">${b.title}</td>
      <td title="${b.author}">${b.author}</td>
      <td>${b.genre}</td><td>${b.status}</td>
      <td>${b.totalPages || "—"}</td>
    </tr>`).join("")}
    ${parsedBooks.length > 5 ? `<tr><td colspan="5" style="color:#9b9a97;text-align:center">... and ${parsedBooks.length - 5} more</td></tr>` : ""}
    </tbody>`;

  preview.style.display   = "";
  startImportBtn.disabled = false;
}

// ══════════════════════════════════════════
//  BACKGROUND COVER FETCHER
// ══════════════════════════════════════════

const GBOOKS_KEY = "AIzaSyBBMm9HLyzazJ3HzWIA7hCc3ehNYV_qxUQ";
let coverFetchQueue   = [];
let coverFetchRunning = false;

const toast      = document.getElementById("coverFetchToast");
const toastFill  = document.getElementById("toastFill");
const toastLabel = document.getElementById("toastLabel");
document.getElementById("toastClose").addEventListener("click", () => toast.classList.remove("visible"));

function queueCoverFetch(books) {
  const noCover = books.filter(b => !b.cover && b.title);
  if (!noCover.length) return;
  coverFetchQueue.push(...noCover.map(b => ({ id: b.id, title: b.title, author: b.author || "" })));
  if (!coverFetchRunning) runCoverFetch();
}

async function runCoverFetch() {
  if (!booksCol) return;
  coverFetchRunning = true;
  toast.classList.add("visible");
  const total = coverFetchQueue.length;
  let done = 0;

  while (coverFetchQueue.length > 0) {
    const item = coverFetchQueue.shift();
    const book = allBooks.find(b => b.id === item.id);
    if (book?.cover) { done++; continue; }

    const cover = await fetchCoverUrl(item.title, item.author);
    if (cover) await booksCol.doc(item.id).update({ cover });

    done++;
    const pct = Math.round((done / total) * 100);
    toastFill.style.width  = pct + "%";
    toastLabel.textContent = `${done} / ${total} — ${item.title}`;
    await new Promise(r => setTimeout(r, 350));
  }

  toastLabel.textContent = `✓ Finished updating covers!`;
  toastFill.style.width  = "100%";
  setTimeout(() => toast.classList.remove("visible"), 3500);
  coverFetchRunning = false;
}

async function fetchCoverUrl(title, author) {
  try {
    const q    = encodeURIComponent(`${title} ${author}`.trim());
    const res  = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&key=${GBOOKS_KEY}`);
    const data = await res.json();
    if (data.items?.[0]?.volumeInfo?.imageLinks) {
      const imgs = data.items[0].volumeInfo.imageLinks;
      return (imgs.extraLarge || imgs.large || imgs.thumbnail || "").replace("http://", "https://");
    }
  } catch {}
  try {
    const res  = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(title)}&limit=1`);
    const data = await res.json();
    const coverId = data.docs?.[0]?.cover_i;
    if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
  } catch {}
  return "";
}

startImportBtn.addEventListener("click", async () => {
  if (!parsedBooks.length || !booksCol) return;
  startImportBtn.disabled = true;
  document.getElementById("importPreview").style.display  = "none";
  document.getElementById("importDropZone").style.display = "none";

  const progressEl = document.getElementById("importProgress");
  const fillEl     = document.getElementById("importProgressFill");
  const labelEl    = document.getElementById("importProgressLabel");
  const logEl      = document.getElementById("importLog");
  progressEl.style.display = "";

  const existingTitles = new Set(allBooks.map(b => b.title.trim().toLowerCase()));
  let success = 0, skipped = 0, failed = 0;

  for (let i = 0; i < parsedBooks.length; i++) {
    const pct  = Math.round(((i + 1) / parsedBooks.length) * 100);
    fillEl.style.width  = pct + "%";
    labelEl.textContent = t("Importing {i} / {total}...", { i: i + 1, total: parsedBooks.length });
    const book = parsedBooks[i];

    if (existingTitles.has(book.title.trim().toLowerCase())) {
      skipped++;
      const line = document.createElement("div");
      line.style.color  = "#9b9a97";
      line.textContent  = `— skipped (duplicate): ${book.title}`;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
      continue;
    }

    try {
      book.catalogKey = await upsertCatalog(book);   // 匯入的書也進共享書庫
      await booksCol.add(book);
      existingTitles.add(book.title.trim().toLowerCase());
      success++;
      const line = document.createElement("div");
      line.style.color = "#1a6632";
      line.textContent = `✓ ${book.title}`;
      logEl.appendChild(line);
    } catch(e) {
      failed++;
      const line = document.createElement("div");
      line.style.color = "#c0392b";
      line.textContent = `✗ ${book.title}: ${e.message}`;
      logEl.appendChild(line);
    }
    logEl.scrollTop = logEl.scrollHeight;
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 200));
  }

  labelEl.textContent = t("Done! ✓ {ok} imported", { ok: success })
    + (skipped ? t(", {n} skipped", { n: skipped }) : "")
    + (failed ? t(", ✗ {n} failed", { n: failed }) : "") + ".";
  labelEl.style.color = "#1a6632";
  startImportBtn.textContent = "Close";
  startImportBtn.disabled    = false;
  startImportBtn.onclick     = () => { closeImport(); queueCoverFetch(allBooks); };
});

// ══════════════════════════════════════════
//  PHASE B-3 — 探索頁 / 隱私設定 / 公開書架
// ══════════════════════════════════════════

// ── 頁面切換:我的書架 / 探索 ──
function switchView(view) {
  currentView = view;
  document.querySelectorAll(".nav-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".shelf-only").forEach(el =>
    el.style.display = view === "shelf" ? "" : "none");
  document.getElementById("sidebar").style.display = view === "shelf" ? "" : "none";
  document.getElementById("shelfView").style.display   = view === "shelf"   ? "" : "none";
  document.getElementById("exploreView").style.display = view === "explore" ? "" : "none";
  document.getElementById("feedView").style.display    = view === "feed"    ? "" : "none";
  if (view === "explore") {
    document.getElementById("publicBanner").style.display = "none";
    if (!exploreLoaded || viewingPublicUid) { viewingPublicUid = null; loadExplore(); }
    exploreLoaded = true;
  }
  if (view === "feed") loadFeed();
}
document.querySelectorAll(".nav-tab").forEach(tab =>
  tab.addEventListener("click", () => switchView(tab.dataset.view)));
document.getElementById("exploreSortSelect").addEventListener("change", renderExplore);

// ── 共享書庫平均分 ──
function avgOf(c) {
  const n = c.ratingCount || 0;
  return n > 0 ? (c.ratingSum || 0) / n : 0;
}

// ── 載入共享書庫 ──
async function loadExplore() {
  const grid = document.getElementById("exploreGrid");
  grid.innerHTML = `<div class="loading">${t("Loading...")}</div>`;
  try {
    const snap = await db.collection("catalog").get();
    exploreBooks = snap.docs.map(d => ({ key: d.id, ...d.data() }));
    renderExplore();
  } catch (e) {
    grid.innerHTML = `<div class="loading">${t("Failed to load")}: ${escHtml(e.message)}</div>`;
  }
}

function renderExplore() {
  const grid = document.getElementById("exploreGrid");
  const sort = document.getElementById("exploreSortSelect").value;
  let list = [...exploreBooks];
  if (sort === "rating")        list.sort((a,b) => avgOf(b) - avgOf(a) || (b.ratingCount||0) - (a.ratingCount||0));
  else if (sort === "popular")  list.sort((a,b) => (b.ratingCount||0) - (a.ratingCount||0));
  else                          list.sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0));

  document.getElementById("exploreCount").textContent = t("{n} books", { n: list.length });
  if (!list.length) { grid.innerHTML = `<div class="loading">${t("No books in the shared library yet")}</div>`; return; }

  grid.innerHTML = list.map(c => {
    const avg   = avgOf(c);
    const cover = c.cover
      ? `<div class="book-cover"><img src="${escHtml(c.cover)}" alt="" loading="lazy" /></div>`
      : `<div class="no-cover"><div class="no-cover-icon">📖</div><div class="no-cover-title">${escHtml(c.title||"")}</div></div>`;
    const rating = c.ratingCount
      ? `<div class="card-rating"><span class="cr-star">${starsHTML(avg)}</span><span>${avg.toFixed(1)}</span><span class="cr-count">(${c.ratingCount})</span></div>`
      : `<div class="card-rating cr-empty">${t("No ratings yet")}</div>`;
    return `<div class="book-card" data-key="${escHtml(c.key)}">
      ${cover}
      <div class="book-info">
        <div class="book-title">${escHtml(c.title||"")}</div>
        <div class="book-author">${escHtml(c.author||"")}</div>
        ${rating}
      </div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".book-card").forEach(card =>
    card.addEventListener("click", () => {
      const c = exploreBooks.find(x => x.key === card.dataset.key);
      if (c) openCatalogDetail(c);
    }));
}

// ── 開啟共享書(探索)詳情:重用詳情 Modal,隱藏私人書架專屬區塊 ──
function openCatalogDetail(c) {
  detailMode       = "catalog";
  activeCatalogKey = c.key;
  currentDetailId  = null;

  document.getElementById("detailTitle").textContent  = c.title  || "";
  document.getElementById("detailAuthor").textContent = c.author || "";
  document.getElementById("detailGenre").textContent  = c.genre  || "";
  document.getElementById("detailStatus").innerHTML   = "";
  const coverImg = document.getElementById("detailCover");
  coverImg.src = c.cover || "";
  coverImg.style.display = c.cover ? "" : "none";

  // 隱藏私人書架專屬區塊,顯示「加入我的書架」
  document.querySelectorAll(".detail-shelf-only").forEach(el => el.style.display = "none");
  const addBtn  = document.getElementById("addToShelfBtn");
  const onShelf = allBooks.some(b => (b.catalogKey || catalogKeyFor(b.title, b.author)) === c.key);
  addBtn.style.display = "";
  addBtn.disabled      = onShelf;
  addBtn.textContent   = onShelf ? t("✓ Already on your shelf") : t("➕ Add to My Shelf");

  const readInfo = document.getElementById("reviewReadInfo");
  if (readInfo) readInfo.innerHTML = "";
  document.getElementById("reviewPct").value = 0;
  if (currentUser) {
    document.getElementById("reviewerName").value =
      currentUser.displayName || (currentUser.email ? currentUser.email.split("@")[0] : "");
  }
  selectedRating = 0; renderStars(0); updateStarLabel(0, true);
  document.getElementById("reviewText").value = "";

  detailModal.classList.add("open");
  loadReviews(c.key);
  loadDiscussion(c.key);
}

// ── 從探索把書加入我的書架 ──
document.getElementById("addToShelfBtn").addEventListener("click", async () => {
  if (!currentUser || !booksCol) { alert(t("Please sign in first.")); return; }
  const c = exploreBooks.find(x => x.key === activeCatalogKey)
         || (viewingPublicUid ? { key: activeCatalogKey } : null);
  if (!c) return;
  const btn = document.getElementById("addToShelfBtn");
  btn.disabled = true; btn.textContent = t("Adding...");
  try {
    await booksCol.add({
      title: c.title || document.getElementById("detailTitle").textContent || "",
      author: c.author || document.getElementById("detailAuthor").textContent || "",
      genre: c.genre || "", totalPages: c.totalPages || 0, currentPage: 0,
      status: "Want to Read", cover: c.cover || document.getElementById("detailCover").src || "",
      startDate: "", finishDate: "", notes: "",
      startYear: new Date().getFullYear(),
      userId: currentUser.uid, catalogKey: c.key,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    btn.textContent = t("✓ Added to shelf");
  } catch (e) {
    alert(t("Failed to add") + ": " + e.message);
    btn.disabled = false; btn.textContent = t("➕ Add to My Shelf");
  }
});

// ── 隱私設定 ──
document.getElementById("openPrivacyBtn").addEventListener("click", async () => {
  if (!currentUser) { alert(t("Please sign in first.")); return; }
  try {
    const snap = await db.collection("users").doc(currentUser.uid).get();
    const d = snap.exists ? snap.data() : {};
    document.getElementById("prefShelfPublic").checked = !!d.shelfPublic;
    document.getElementById("prefShowReading").checked = !!d.showReading;
  } catch (e) { console.warn(e); }
  document.getElementById("privacyModal").classList.add("open");
});
function closePrivacy() { document.getElementById("privacyModal").classList.remove("open"); }
document.getElementById("closePrivacyModal").addEventListener("click", closePrivacy);
document.getElementById("cancelPrivacy").addEventListener("click", closePrivacy);
document.getElementById("privacyModal").addEventListener("click", e => {
  if (e.target.id === "privacyModal") closePrivacy();
});
document.getElementById("savePrivacyBtn").addEventListener("click", async () => {
  if (!currentUser) return;
  const btn = document.getElementById("savePrivacyBtn");
  btn.disabled = true; btn.textContent = t("Saving...");
  try {
    myProfile.shelfPublic = document.getElementById("prefShelfPublic").checked;
    myProfile.showReading = document.getElementById("prefShowReading").checked;
    await db.collection("users").doc(currentUser.uid).set({
      shelfPublic: myProfile.shelfPublic,
      showReading: myProfile.showReading,
    }, { merge: true });
    closePrivacy();
  } catch (e) { alert(t("Failed to save") + ": " + e.message); }
  btn.disabled = false; btn.textContent = t("Save");
});

// ── 一次性:清掉私人書架 notes 裡的舊星等文字(只保留真正的筆記) ──
async function cleanupRatingNotesOnce(uid) {
  const profRef = db.collection("users").doc(uid);
  try {
    const prof = await profRef.get();
    if (prof.exists && prof.data().notesCleaned) return;
    const snap = await booksCol.get();
    let cleaned = 0;
    for (const d of snap.docs) {
      const notes = d.data().notes || "";
      if (!/[★☆]/.test(notes)) continue;
      const stripped = notes.replace(/Rating:\s*[★☆]+/g, "").replace(/[★☆]+/g, "").trim();
      if (stripped !== notes) { await d.ref.update({ notes: stripped }); cleaned++; }
    }
    await profRef.set({ notesCleaned: true }, { merge: true });
    if (cleaned) console.log(`[notes] 已清理 ${cleaned} 本書的舊星等文字`);
  } catch (e) { console.warn("cleanupRatingNotesOnce failed:", e); }
}

// ── 看某使用者的公開書架(B3c)──
async function loadPublicShelf(uid) {
  // 直接切到探索容器(不走 switchView,避免它非同步載入 catalog 後覆蓋掉公開書架)
  currentView = "explore";
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.toggle("active", t.dataset.view === "explore"));
  document.querySelectorAll(".shelf-only").forEach(el => el.style.display = "none");
  document.getElementById("sidebar").style.display = "none";
  document.getElementById("shelfView").style.display   = "none";
  document.getElementById("exploreView").style.display = "";
  exploreLoaded = true;
  viewingPublicUid = uid;
  const grid   = document.getElementById("exploreGrid");
  const banner = document.getElementById("publicBanner");
  const pbText = banner.querySelector(".pb-text");
  grid.innerHTML = `<div class="loading">${t("Loading...")}</div>`;
  try {
    const prof  = await db.collection("users").doc(uid).get();
    const pdata = prof.exists ? prof.data() : {};
    const name  = pdata.displayName || "Reader";
    setupFollowButton(uid);
    if (!pdata.shelfPublic) {
      banner.style.display = "flex"; pbText.textContent = t("🔒 {name}'s library is private", { name });
      grid.innerHTML = `<div class="loading">${t("This user has no public library")}</div>`;
      return;
    }
    const snap  = await db.collection("users").doc(uid).collection("books").orderBy("createdAt","desc").get();
    const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    banner.style.display = "flex"; pbText.textContent = t("📖 {name}'s library ({n} books)", { name, n: books.length });
    renderPublicShelf(books);
  } catch (e) {
    banner.style.display = "flex"; pbText.textContent = t("🔒 Cannot load this shelf");
    grid.innerHTML = `<div class="loading">${t("Could not load — they may have made it private")}</div>`;
  }
}

function renderPublicShelf(books) {
  const grid = document.getElementById("exploreGrid");
  document.getElementById("exploreCount").textContent = "";
  if (!books.length) { grid.innerHTML = `<div class="loading">${t("This shelf is empty")}</div>`; return; }
  grid.innerHTML = books.map(b => {
    const cover = b.cover
      ? `<div class="book-cover"><img src="${escHtml(b.cover)}" alt="" loading="lazy" /></div>`
      : `<div class="no-cover"><div class="no-cover-icon">📖</div><div class="no-cover-title">${escHtml(b.title||"")}</div></div>`;
    const pct = (b.totalPages && b.currentPage) ? Math.min(100, Math.round(b.currentPage / b.totalPages * 100)) : 0;
    return `<div class="book-card" data-key="${escHtml(b.catalogKey || catalogKeyFor(b.title, b.author))}">
      ${cover}
      <div class="book-info">
        <div class="book-title">${escHtml(b.title||"")}</div>
        <div class="book-author">${escHtml(b.author||"")}</div>
        <div class="book-genre">${escHtml(b.status ? t(b.status) : "")}${pct ? ` · ${pct}%` : ""}</div>
      </div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".book-card").forEach(card =>
    card.addEventListener("click", async () => {
      try {
        const snap = await db.collection("catalog").doc(card.dataset.key).get();
        if (snap.exists) openCatalogDetail({ key: card.dataset.key, ...snap.data() });
      } catch (e) { console.warn(e); }
    }));
}

document.getElementById("publicBackBtn").addEventListener("click", () => {
  viewingPublicUid = null;
  document.getElementById("publicBanner").style.display = "none";
  loadExplore();
});

// ══════════════════════════════════════════
//  i18n — 多語系(英文基準 + 繁中,自動偵測 + 可切換)
// ══════════════════════════════════════════
const LANGS = ["en", "zh-TW"];
let currentLang = "en";

const DICT = {
  // 導覽 / 側欄
  "My Shelf": { "zh-TW": "我的書架" }, "Explore": { "zh-TW": "探索" }, "Feed": { "zh-TW": "動態" },
  "Status": { "zh-TW": "狀態" }, "⬜ All": { "zh-TW": "⬜ 全部" },
  "⏳ Now Reading": { "zh-TW": "⏳ 正在閱讀" }, "⏭ TBR": { "zh-TW": "⏭ 待讀" },
  "📋 Want to Read": { "zh-TW": "📋 想讀" }, "✅ Finished": { "zh-TW": "✅ 已讀完" }, "🚫 DNF": { "zh-TW": "🚫 棄讀" },
  "Year": { "zh-TW": "年份" }, "All Years": { "zh-TW": "所有年份" },
  "Genre": { "zh-TW": "類型" }, "All Genres": { "zh-TW": "所有類型" },
  "+ New Book": { "zh-TW": "+ 新增書籍" }, "⬆ Import from Notion": { "zh-TW": "⬆ 從 Notion 匯入" },
  "⚙ Privacy": { "zh-TW": "⚙ 隱私設定" }, "Sign out": { "zh-TW": "登出" },
  // 篩選列
  "Sort by": { "zh-TW": "排序" },
  "Date Added ↓": { "zh-TW": "加入日期 ↓" }, "Date Added ↑": { "zh-TW": "加入日期 ↑" },
  "Title A → Z": { "zh-TW": "書名 A → Z" }, "Title Z → A": { "zh-TW": "書名 Z → A" },
  "Author A → Z": { "zh-TW": "作者 A → Z" }, "Date Finished ↓": { "zh-TW": "讀完日期 ↓" },
  "Progress ↓": { "zh-TW": "進度 ↓" }, "Pages ↓": { "zh-TW": "頁數 ↓" },
  "Format": { "zh-TW": "版本" }, "All Formats": { "zh-TW": "所有版本" },
  "✕ Clear filters": { "zh-TW": "✕ 清除篩選" },
  "Rating ↓": { "zh-TW": "評分 ↓" }, "Popularity ↓": { "zh-TW": "熱度 ↓" }, "Recently Added": { "zh-TW": "最新加入" },
  "Search books...": { "zh-TW": "搜尋書籍..." },
  // 截圖 / Toast
  "Drag to select the area you want as the cover": { "zh-TW": "拖曳選取要當封面的區域" },
  "✕ Cancel": { "zh-TW": "✕ 取消" }, "✓ Use this area": { "zh-TW": "✓ 使用此區域" }, "↺ Re-select": { "zh-TW": "↺ 重選" },
  // 新增書籍 Modal
  "Add Book": { "zh-TW": "新增書籍" }, "Edit Book": { "zh-TW": "編輯書籍" },
  "Enter ISBN or book title...": { "zh-TW": "輸入 ISBN 或書名..." }, "Search": { "zh-TW": "搜尋" },
  "Cover": { "zh-TW": "封面" }, "No Cover": { "zh-TW": "無封面" },
  "🖼 Change Cover": { "zh-TW": "🖼 更換封面" }, "🔄 Re-fetch": { "zh-TW": "🔄 重新抓取" },
  "🎨 Gallery": { "zh-TW": "🎨 圖庫" }, "📁 Upload": { "zh-TW": "📁 上傳" }, "🔗 Link": { "zh-TW": "🔗 連結" }, "✂️ Screenshot": { "zh-TW": "✂️ 截圖" },
  "click to browse": { "zh-TW": "點擊瀏覽" }, "or Ctrl+V to paste an image": { "zh-TW": "或按 Ctrl+V 貼上圖片" },
  "Paste an image URL...": { "zh-TW": "貼上圖片網址..." }, "Submit": { "zh-TW": "送出" },
  "Works with any image URL from the web.": { "zh-TW": "可用網路上任何圖片網址。" },
  "Capture any area of your screen as a book cover.": { "zh-TW": "擷取螢幕任一區域當作書封。" },
  "📸 Start Screen Capture": { "zh-TW": "📸 開始截取螢幕" },
  "🗑 Remove cover": { "zh-TW": "🗑 移除封面" }, "Close": { "zh-TW": "關閉" },
  "Title *": { "zh-TW": "書名 *" }, "Book title": { "zh-TW": "書名" }, "Author *": { "zh-TW": "作者 *" }, "Author name": { "zh-TW": "作者名" },
  "e.g. Fantasy, Mystery": { "zh-TW": "例:奇幻、推理" }, "Total Pages": { "zh-TW": "總頁數" }, "e.g. 400": { "zh-TW": "例:400" },
  "Want to Read": { "zh-TW": "想讀" }, "TBR": { "zh-TW": "待讀" }, "Now Reading": { "zh-TW": "正在閱讀" }, "Finished": { "zh-TW": "已讀完" }, "DNF": { "zh-TW": "棄讀" },
  "Current Page": { "zh-TW": "目前頁數" }, "e.g. 120": { "zh-TW": "例:120" },
  "Start Date": { "zh-TW": "開始日期" }, "Finish Date": { "zh-TW": "讀完日期" },
  "Notes": { "zh-TW": "筆記" }, "Your thoughts...": { "zh-TW": "你的想法..." },
  "Cancel": { "zh-TW": "取消" }, "Save Book": { "zh-TW": "儲存書籍" }, "Save": { "zh-TW": "儲存" },
  // 詳情 / 評論
  "Book Detail": { "zh-TW": "書籍詳情" }, "Progress": { "zh-TW": "進度" },
  "Update current page:": { "zh-TW": "更新目前頁數:" }, "Update": { "zh-TW": "更新" },
  "Edit": { "zh-TW": "編輯" }, "Delete": { "zh-TW": "刪除" }, "➕ Add to My Shelf": { "zh-TW": "➕ 加入我的書架" },
  "✍️ Write a Review": { "zh-TW": "✍️ 寫評論" }, "Your name or nickname": { "zh-TW": "你的名字或暱稱" },
  "Select rating": { "zh-TW": "選擇評分" }, "Share your thoughts... (optional)": { "zh-TW": "分享你的想法...(選填)" }, "Submit Review": { "zh-TW": "送出評論" },
  // 隱私
  "Control who can see your shelf. Everything is private by default.": { "zh-TW": "控制誰能看到你的書架。預設全部不公開。" },
  "Make my library public": { "zh-TW": "公開我的書庫" },
  "When on, others can browse the books you've read / are reading / want to read, with status and progress.": { "zh-TW": "開啟後,別人可以瀏覽你讀過/在讀/想讀的書,以及狀態與進度。" },
  "Show \"Now Reading\"": { "zh-TW": "顯示「正在閱讀」" },
  "Highlight what you're currently reading on your public library (requires public library).": { "zh-TW": "在你的公開書庫醒目顯示目前正在讀的書(需先公開書庫)。" },
  "📌 Your public ratings/reviews are always public regardless of this setting — they only disappear if you delete them.": { "zh-TW": "📌 你的公開評分/評論一律公開,不受此設定影響——刪除才會消失。" },
  // 匯入
  "⬆ Import from Notion": { "zh-TW": "⬆ 從 Notion 匯入" },
  "Importing...": { "zh-TW": "匯入中..." }, "Import Books": { "zh-TW": "匯入書籍" },
  "📋 How to export from Notion": { "zh-TW": "📋 如何從 Notion 匯出" },
  "Found {n} books ready to import.": { "zh-TW": "找到 {n} 本書可匯入。" },
  "Found {n} duplicate books. Remove them?": { "zh-TW": "找到 {n} 本重複的書,要移除嗎?" },
  "Found {n} duplicate book. Remove them?": { "zh-TW": "找到 {n} 本重複的書,要移除嗎?" },
  "Drag & drop your CSV file here": { "zh-TW": "拖曳你的 CSV 檔到這裡" },
  "or click to browse": { "zh-TW": "或點擊瀏覽" },
  "Click to change file": { "zh-TW": "點擊更換檔案" }, "Importing {i} / {total}...": { "zh-TW": "匯入中 {i} / {total}..." },
  "Done! ✓ {ok} imported": { "zh-TW": "完成!✓ 已匯入 {ok} 本" }, ", {n} skipped": { "zh-TW": ",跳過 {n} 本" }, ", ✗ {n} failed": { "zh-TW": ",✗ 失敗 {n} 本" },
  // 登入
  "Your personal reading tracker": { "zh-TW": "你的個人閱讀紀錄" },
  "Continue with Google": { "zh-TW": "使用 Google 繼續" }, "or continue with email": { "zh-TW": "或使用 Email 繼續" },
  "Sign In": { "zh-TW": "登入" }, "Create Account": { "zh-TW": "建立帳號" },
  "Your name (e.g. Jane)": { "zh-TW": "你的名字(例:小明)" }, "Email address": { "zh-TW": "Email 地址" },
  "Password": { "zh-TW": "密碼" }, "Confirm password": { "zh-TW": "確認密碼" }, "Forgot password?": { "zh-TW": "忘記密碼?" },
  // 動態字串(JS 用 t() 取)
  "Loading...": { "zh-TW": "載入中..." }, "{n} books": { "zh-TW": "{n} 本書" }, "{n} book": { "zh-TW": "{n} 本書" },
  "No reviews yet": { "zh-TW": "尚無評論" }, "📝 No reviews yet — be the first!": { "zh-TW": "📝 還沒有評論——當第一個!" },
  "{n} reviews": { "zh-TW": "{n} 則評論" }, "{n} review": { "zh-TW": "{n} 則評論" },
  "No ratings yet": { "zh-TW": "尚無評分" }, "No books in the shared library yet": { "zh-TW": "共享書庫還沒有書" },
  "Failed to load": { "zh-TW": "載入失敗" }, "✓ Already on your shelf": { "zh-TW": "✓ 已在你的書架" },
  "Failed": { "zh-TW": "失敗" }, "Failed to save": { "zh-TW": "儲存失敗" },
  "Follow": { "zh-TW": "追蹤" }, "Following": { "zh-TW": "已追蹤" },
  "← Back to Explore": { "zh-TW": "← 回探索" },
  "📰 Feed": { "zh-TW": "📰 動態" }, "All": { "zh-TW": "全部" },
  "No activity yet": { "zh-TW": "還沒有動態" }, "No activity from people you follow yet": { "zh-TW": "你追蹤的人還沒有動態" },
  "{name} reviewed {book}": { "zh-TW": "{name} 評論了《{book}》" },
  "{name} is now reading {book}": { "zh-TW": "{name} 正在讀《{book}》" },
  "{name} finished {book}": { "zh-TW": "{name} 讀完了《{book}》" },
  "Reply": { "zh-TW": "回覆" }, "Write a reply...": { "zh-TW": "寫回覆..." }, "Send": { "zh-TW": "送出" },
  "No replies yet": { "zh-TW": "還沒有回覆" },
  "💬 Book Club Discussion": { "zh-TW": "💬 讀書會討論" }, "Join the discussion...": { "zh-TW": "加入討論..." },
  "Be the first to start the discussion!": { "zh-TW": "搶第一個開始討論吧!" },
  "Adding...": { "zh-TW": "加入中..." }, "✓ Added to shelf": { "zh-TW": "✓ 已加入書架" }, "Failed to add": { "zh-TW": "加入失敗" },
  "Submitting...": { "zh-TW": "送出中..." }, "Saving...": { "zh-TW": "儲存中..." },
  "Please sign in first.": { "zh-TW": "請先登入。" }, "Cannot locate this book in the catalog.": { "zh-TW": "找不到這本書的書庫資料。" },
  "🔒 {name}'s library is private": { "zh-TW": "🔒 {name} 的書庫未公開" },
  "This user has no public library": { "zh-TW": "這位使用者沒有公開書庫" },
  "📖 {name}'s library ({n} books)": { "zh-TW": "📖 {name} 的書庫({n} 本)" },
  "This shelf is empty": { "zh-TW": "這個書架是空的" }, "🔒 Cannot load this shelf": { "zh-TW": "🔒 無法載入此書架" },
  "Could not load — they may have made it private": { "zh-TW": "對方可能未公開書架" },
  "Title is required.": { "zh-TW": "請填書名。" }, "Please select a star rating.": { "zh-TW": "請選擇星等評分。" },
  "Please enter your name or nickname.": { "zh-TW": "請輸入你的名字或暱稱。" },
  "😞 Didn't like it": { "zh-TW": "😞 不喜歡" }, "😐 It was ok": { "zh-TW": "😐 普通" }, "🙂 Liked it": { "zh-TW": "🙂 喜歡" },
  "😊 Really liked it": { "zh-TW": "😊 很喜歡" }, "🤩 Amazing!": { "zh-TW": "🤩 超讚!" },
};

// 含 HTML 標籤的整塊內容(無法用純文字翻)
const HTML_DICT = {
  "import-steps": {
    "zh-TW": `<li>在 Notion 打開你的書籍資料庫頁面</li><li>點右上角 <strong>⋯</strong> → <strong>Export</strong>(匯出)</li><li>格式(Format)選 <strong>CSV</strong></li><li>點 <strong>Export</strong> 並儲存檔案</li><li>在下方上傳 <code>.csv</code> 檔</li>`
  },
  "import-cols": {
    "zh-TW": `⚠️ 你的 Notion 資料庫必須包含這些欄位:<br/><code>Title</code>、<code>Author</code>、<code>Status</code>、<code>Total Pages</code>、<code>Current Page</code>、<code>Genre</code>、<code>Date Finished</code>`
  },
  "import-upload": {
    "zh-TW": `拖曳你的 CSV 檔到這裡<br/><span>或點擊瀏覽</span>`
  },
};

function detectLang() {
  const saved = localStorage.getItem("lang");
  if (saved && LANGS.includes(saved)) return saved;
  return (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}

// 取翻譯;vars 可帶 {n}、{name} 等變數
function t(en, vars) {
  let s = (currentLang !== "en" && DICT[en] && DICT[en][currentLang]) ? DICT[en][currentLang] : en;
  if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
  return s;
}

// 翻譯靜態 DOM(葉節點文字 + placeholder),跳過動態書格與使用者資料
function translateStatic(lang) {
  // 含 HTML 標籤的整塊內容
  document.querySelectorAll("[data-i18n-html]").forEach(el => {
    const key = el.dataset.i18nHtml;
    if (!el.dataset.i18nOrig) el.dataset.i18nOrig = el.innerHTML;
    el.innerHTML = (lang !== "en" && HTML_DICT[key] && HTML_DICT[key][lang]) ? HTML_DICT[key][lang] : el.dataset.i18nOrig;
  });
  document.querySelectorAll("button, label, span, option, li, h2, h3, p, div, a").forEach(el => {
    if (el.children.length) return;
    if (el.closest("[data-i18n-html], #bookGrid, #exploreGrid, #reviewsList, #galleryGrid, #previewTable, #importLog, .filter-chips, #yearFilter, #genreFilter, #formatSelect")) return;
    const key = el.dataset.i18nKey || el.textContent.trim();
    if (!key || (!DICT[key] && !el.dataset.i18nKey)) return;
    el.dataset.i18nKey = key;
    el.textContent = (lang !== "en" && DICT[key] && DICT[key][lang]) ? DICT[key][lang] : key;
  });
  document.querySelectorAll("input[placeholder], textarea[placeholder]").forEach(el => {
    const key = el.dataset.i18nPh || el.getAttribute("placeholder");
    if (!key || (!DICT[key] && !el.dataset.i18nPh)) return;
    el.dataset.i18nPh = key;
    el.setAttribute("placeholder", (lang !== "en" && DICT[key] && DICT[key][lang]) ? DICT[key][lang] : key);
  });
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("lang", lang);
  document.documentElement.lang = lang === "zh-TW" ? "zh-TW" : "en";
  translateStatic(lang);
  const btn = document.getElementById("langToggle");
  if (btn) btn.textContent = lang === "en" ? "中" : "EN";
  // 重新渲染含動態文字的可見區塊
  try {
    if (allBooks.length) { rebuildSidebarFilters(); rebuildFormatFilter(); }
    if (currentView === "explore" && !viewingPublicUid) renderExplore();
    else renderGrid();
  } catch (e) {}
}

document.getElementById("langToggle").addEventListener("click", () =>
  setLang(currentLang === "en" ? "zh-TW" : "en"));

setLang(detectLang());

// ══════════════════════════════════════════
//  PHASE B-4a — 追蹤系統(單向)
// ══════════════════════════════════════════
async function isFollowing(targetUid) {
  if (!currentUser) return false;
  try {
    const snap = await db.collection("users").doc(currentUser.uid).collection("following").doc(targetUid).get();
    return snap.exists;
  } catch (e) { return false; }
}

async function toggleFollow(targetUid) {
  const meRef   = db.collection("users").doc(currentUser.uid).collection("following").doc(targetUid);
  const themRef = db.collection("users").doc(targetUid).collection("followers").doc(currentUser.uid);
  const snap = await meRef.get();
  if (snap.exists) {
    await meRef.delete();
    await themRef.delete().catch(() => {});
    return false;
  }
  const ts = firebase.firestore.FieldValue.serverTimestamp();
  await meRef.set({ createdAt: ts });
  await themRef.set({ createdAt: ts, displayName: currentUser.displayName || "", photoURL: currentUser.photoURL || "" }).catch(() => {});
  return true;
}

function paintFollowBtn(following) {
  const btn = document.getElementById("publicFollowBtn");
  btn.classList.toggle("following", following);
  btn.textContent = following ? t("Following") : t("Follow");
}

// 進入某人公開書架時設定追蹤鈕(本人/未登入則隱藏)
async function setupFollowButton(uid) {
  const btn = document.getElementById("publicFollowBtn");
  if (!currentUser || uid === currentUser.uid) { btn.style.display = "none"; return; }
  btn.style.display = "";
  btn.dataset.target = uid;
  paintFollowBtn(await isFollowing(uid));
}

document.getElementById("publicFollowBtn").addEventListener("click", async () => {
  const btn = document.getElementById("publicFollowBtn");
  const target = btn.dataset.target;
  if (!target || !currentUser) return;
  btn.disabled = true;
  try {
    paintFollowBtn(await toggleFollow(target));
  } catch (e) { alert(t("Failed") + ": " + e.message); }
  btn.disabled = false;
});

// ══════════════════════════════════════════
//  PHASE B-4b — 動態牆(全站事件流)
// ══════════════════════════════════════════
let feedCache = [];

// 寫一筆公開動態事件
async function logActivity(type, book, extra) {
  if (!currentUser) return;
  try {
    await db.collection("activity").add({
      uid:         currentUser.uid,
      displayName: currentUser.displayName || (currentUser.email ? currentUser.email.split("@")[0] : "Reader"),
      photoURL:    currentUser.photoURL || "",
      type,
      bookKey:   (book && book.key)   || "",
      bookTitle: (book && book.title) || "",
      bookCover: (book && book.cover) || "",
      rating: (extra && extra.rating) || null,
      text:   (extra && extra.text)   || "",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn("logActivity:", e); }
}

async function loadFeed() {
  const list = document.getElementById("feedList");
  list.innerHTML = `<div class="loading">${t("Loading...")}</div>`;
  try {
    const snap = await db.collection("activity").orderBy("createdAt", "desc").limit(80).get();
    feedCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFeed();
  } catch (e) {
    list.innerHTML = `<div class="feed-empty">${t("Failed to load")}: ${escHtml(e.message)}</div>`;
  }
}

async function getFollowingSet() {
  if (!currentUser) return new Set();
  try {
    const snap = await db.collection("users").doc(currentUser.uid).collection("following").get();
    return new Set(snap.docs.map(d => d.id));
  } catch (e) { return new Set(); }
}

async function renderFeed() {
  const list = document.getElementById("feedList");
  let items = feedCache;
  if (feedSubtab === "following") {
    const set = await getFollowingSet();
    if (currentUser) set.add(currentUser.uid);   // 動態牆也含自己
    items = feedCache.filter(a => set.has(a.uid));
  }
  if (!items.length) {
    list.innerHTML = `<div class="feed-empty">${t(feedSubtab === "following" ? "No activity from people you follow yet" : "No activity yet")}</div>`;
    return;
  }
  list.innerHTML = items.map(a => {
    const initials = (a.displayName || "?").slice(0, 2).toUpperCase();
    const avatar = a.photoURL
      ? `<div class="feed-avatar" data-uid="${escHtml(a.uid)}"><img src="${escHtml(a.photoURL)}" alt=""></div>`
      : `<div class="feed-avatar" data-uid="${escHtml(a.uid)}">${escHtml(initials)}</div>`;
    const nameHtml = `<span class="feed-name" data-uid="${escHtml(a.uid)}">${escHtml(a.displayName || "Reader")}</span>`;
    const bookHtml = `<span class="feed-book" data-key="${escHtml(a.bookKey)}">${escHtml(a.bookTitle || "")}</span>`;
    let line;
    if (a.type === "review")        line = t("{name} reviewed {book}", { name: nameHtml, book: bookHtml }) + (a.rating ? ` <span style="color:#f0a500">${starsHTML(a.rating)}</span>` : "");
    else if (a.type === "now_reading") line = t("{name} is now reading {book}", { name: nameHtml, book: bookHtml });
    else if (a.type === "finished")    line = t("{name} finished {book}", { name: nameHtml, book: bookHtml });
    else line = `${nameHtml} · ${bookHtml}`;
    const date  = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().toLocaleDateString() : "";
    const cover = a.bookCover ? `<img class="feed-cover" data-key="${escHtml(a.bookKey)}" src="${escHtml(a.bookCover)}" alt="">` : "";
    return `<div class="feed-item">
      ${avatar}
      <div class="feed-body">
        <div class="feed-text">${line}</div>
        ${a.text ? `<div class="feed-review-text">${escHtml(a.text)}</div>` : ""}
        <div class="feed-meta">${date}</div>
      </div>
      ${cover}
    </div>`;
  }).join("");

  list.querySelectorAll(".feed-name, .feed-avatar").forEach(el => el.addEventListener("click", () => {
    if (el.dataset.uid) loadPublicShelf(el.dataset.uid);
  }));
  list.querySelectorAll(".feed-book, .feed-cover").forEach(el => el.addEventListener("click", async () => {
    const key = el.dataset.key;
    if (!key) return;
    try { const snap = await db.collection("catalog").doc(key).get(); if (snap.exists) openCatalogDetail({ key, ...snap.data() }); } catch (e) {}
  }));
}

document.querySelectorAll(".feed-subtab").forEach(btn => btn.addEventListener("click", () => {
  feedSubtab = btn.dataset.feed;
  document.querySelectorAll(".feed-subtab").forEach(b => b.classList.toggle("active", b === btn));
  renderFeed();
}));

// ══════════════════════════════════════════
//  PHASE B-4c — 評論回覆
// ══════════════════════════════════════════
function myDisplayName() {
  return currentUser ? (currentUser.displayName || (currentUser.email ? currentUser.email.split("@")[0] : "Reader")) : "Reader";
}

async function expandReplies(reviewUid, container) {
  if (!container || container.dataset.expanded === "1") return;
  container.dataset.expanded = "1";
  container.insertAdjacentHTML("beforeend",
    `<div class="replies-list" id="replies-${reviewUid}"><div class="replies-empty">${t("Loading...")}</div></div>` +
    (currentUser ? `<div class="reply-input-row">
        <input type="text" class="reply-input" placeholder="${escHtml(t("Write a reply..."))}" maxlength="300">
        <button class="reply-send">${escHtml(t("Send"))}</button>
      </div>` : ""));
  await renderReplies(reviewUid);
  const sendBtn = container.querySelector(".reply-send");
  const input   = container.querySelector(".reply-input");
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      await db.collection("catalog").doc(currentCatalogKey()).collection("reviews").doc(reviewUid).collection("replies").add({
        uid: currentUser.uid, displayName: myDisplayName(), photoURL: currentUser.photoURL || "",
        text, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      input.value = "";
      await renderReplies(reviewUid);
    } catch (e) { alert(t("Failed") + ": " + e.message); }
    sendBtn.disabled = false;
  }
  if (sendBtn) sendBtn.addEventListener("click", send);
  if (input)   input.addEventListener("keydown", e => { if (e.key === "Enter") send(); });
}

async function renderReplies(reviewUid) {
  const el = document.getElementById("replies-" + reviewUid);
  if (!el) return;
  const repCol = db.collection("catalog").doc(currentCatalogKey()).collection("reviews").doc(reviewUid).collection("replies");
  let docs;
  try { docs = (await repCol.orderBy("createdAt", "asc").get()).docs; }
  catch (e) { el.innerHTML = `<div class="replies-empty">${t("Failed to load")}</div>`; return; }
  if (!docs.length) { el.innerHTML = `<div class="replies-empty">${t("No replies yet")}</div>`; return; }
  el.innerHTML = docs.map(d => {
    const r = d.data();
    const date = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toLocaleDateString() : "";
    const mine = currentUser && r.uid === currentUser.uid;
    return `<div class="reply-item">
      <span class="reply-name clickable" data-uid="${escHtml(r.uid)}">${escHtml(r.displayName || "Reader")}</span>
      <span class="reply-text">${escHtml(r.text)}</span>
      <span class="reply-date">${date}</span>
      ${mine ? `<button class="reply-del" data-id="${d.id}" title="Delete">🗑</button>` : ""}
    </div>`;
  }).join("");
  el.querySelectorAll(".reply-del").forEach(b => b.addEventListener("click", async () => {
    try { await repCol.doc(b.dataset.id).delete(); await renderReplies(reviewUid); } catch (e) {}
  }));
  el.querySelectorAll(".reply-name.clickable").forEach(n => n.addEventListener("click", () => {
    if (n.dataset.uid) { detailModal.classList.remove("open"); loadPublicShelf(n.dataset.uid); }
  }));
}

// ══════════════════════════════════════════
//  PHASE B-4d — 讀書會討論
// ══════════════════════════════════════════
async function loadDiscussion(catalogKey) {
  const list = document.getElementById("discussionList");
  if (!list) return;
  if (!catalogKey) { list.innerHTML = ""; return; }
  list.innerHTML = `<div class="discussion-empty">${t("Loading...")}</div>`;
  let docs;
  try { docs = (await db.collection("catalog").doc(catalogKey).collection("discussion").orderBy("createdAt", "asc").get()).docs; }
  catch (e) { list.innerHTML = `<div class="discussion-empty">${t("Failed to load")}</div>`; return; }
  if (!docs.length) { list.innerHTML = `<div class="discussion-empty">${t("Be the first to start the discussion!")}</div>`; return; }
  list.innerHTML = docs.map(d => {
    const m = d.data();
    const initials = (m.displayName || "?").slice(0, 2).toUpperCase();
    const date = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate().toLocaleDateString() : "";
    const mine = currentUser && m.uid === currentUser.uid;
    const avatar = m.photoURL
      ? `<div class="disc-avatar" data-uid="${escHtml(m.uid)}"><img src="${escHtml(m.photoURL)}" alt=""></div>`
      : `<div class="disc-avatar" data-uid="${escHtml(m.uid)}">${escHtml(initials)}</div>`;
    return `<div class="disc-item">
      ${avatar}
      <div class="disc-body">
        <div class="disc-head"><span class="disc-name clickable" data-uid="${escHtml(m.uid)}">${escHtml(m.displayName || "Reader")}</span><span class="disc-date">${date}</span>${mine ? `<button class="disc-del" data-id="${d.id}" title="Delete">🗑</button>` : ""}</div>
        <div class="disc-text">${escHtml(m.text)}</div>
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll(".disc-del").forEach(b => b.addEventListener("click", async () => {
    try { await db.collection("catalog").doc(catalogKey).collection("discussion").doc(b.dataset.id).delete(); loadDiscussion(catalogKey); } catch (e) {}
  }));
  list.querySelectorAll(".disc-name.clickable, .disc-avatar").forEach(n => n.addEventListener("click", () => {
    if (n.dataset.uid) { detailModal.classList.remove("open"); loadPublicShelf(n.dataset.uid); }
  }));
}

async function sendDiscussion() {
  if (!currentUser) { alert(t("Please sign in first.")); return; }
  const input = document.getElementById("discussionInput");
  const text  = input.value.trim();
  const key   = currentCatalogKey();
  if (!text || !key) return;
  const btn = document.getElementById("discussionSend");
  btn.disabled = true;
  try {
    await db.collection("catalog").doc(key).collection("discussion").add({
      uid: currentUser.uid, displayName: myDisplayName(), photoURL: currentUser.photoURL || "",
      text, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    input.value = "";
    await loadDiscussion(key);
  } catch (e) { alert(t("Failed") + ": " + e.message); }
  btn.disabled = false;
}
document.getElementById("discussionSend").addEventListener("click", sendDiscussion);
document.getElementById("discussionInput").addEventListener("keydown", e => { if (e.key === "Enter") sendDiscussion(); });

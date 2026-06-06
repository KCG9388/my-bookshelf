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
const PAGE_SIZE = 24;
let currentPage = 1;
// ── Phase B-3 狀態 ──
let activeCatalogKey = null;
let detailMode    = "shelf";   // "shelf" | "catalog"
let currentView   = "shelf";   // "shelf" | "explore"
let exploreBooks  = [];
let exploreLoaded = false;
let viewingPublicUid = null;

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
  document.getElementById("sidebar").style.display    = "";
  document.getElementById("mainContent").style.display = "";
}
function hideApp() {
  document.getElementById("sidebar").style.display    = "none";
  document.getElementById("mainContent").style.display = "none";
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
    renderGrid();
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
      await ref.set({
        ...base,
        shelfPublic: false,   // 隱私預設：書庫不公開
        showReading: false,   // 隱私預設：不顯示「正在閱讀」
        createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await ref.set(base, { merge: true });  // 只更新名稱/頭像，不動隱私開關
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
  bookCountEl.textContent = `${books.length} book${books.length !== 1 ? "s" : ""}`;

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
          ${b.genre ? `<div class="book-genre">${escHtml(b.genre)}</div>` : ""}
          ${pct !== null ? `
            <div class="progress-wrap">
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
              <div class="progress-pct">${pct}%</div>
            </div>` : ""}
          <div><span class="status-badge status-${escHtml(b.status)}">${escHtml(b.status)}</span></div>
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
  yearFilter.innerHTML = `<li class="${currentFilter.year==="all"?"active":""}" data-year="all">All Years</li>` +
    years.map(y => `<li class="${currentFilter.year===String(y)?"active":""}" data-year="${y}">${y}</li>`).join("");
  yearFilter.querySelectorAll("li").forEach(li => {
    li.addEventListener("click", () => {
      setFilter("year", li.dataset.year);
      yearFilter.querySelectorAll("li").forEach(x => x.classList.remove("active"));
      li.classList.add("active");
    });
  });

  const genreFilter = document.getElementById("genreFilter");
  genreFilter.innerHTML = `<li class="${currentFilter.genre==="all"?"active":""}" data-genre="all">All Genres</li>` +
    genres.map(g => `<li class="${currentFilter.genre===g?"active":""}" data-genre="${g}">${escHtml(g)}</li>`).join("");
  genreFilter.querySelectorAll("li").forEach(li => {
    li.addEventListener("click", () => {
      setFilter("genre", li.dataset.genre);
      genreFilter.querySelectorAll("li").forEach(x => x.classList.remove("active"));
      li.classList.add("active");
    });
  });
}

function setFilter(key, val) {
  currentFilter[key] = val;
  currentPage = 1;
  renderGrid();
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
  document.querySelectorAll(".filter-list li").forEach(li => li.classList.remove("active"));
  document.querySelectorAll("#statusFilter li[data-filter='all'], #yearFilter li[data-year='all'], #genreFilter li[data-genre='all']").forEach(li => li.classList.add("active"));
  renderGrid();
  updateActiveFilters();
});

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
  sel.innerHTML = `<option value="all">All Formats</option>` + formats.map(f => `<option value="${escHtml(f)}">${escHtml(f)}</option>`).join("");
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
    const ok = confirm(`Found ${toDelete.length} duplicate book${toDelete.length > 1 ? "s" : ""}. Remove them?`);
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
  if (prefill) fillForm(prefill);
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
  if (!booksCol) { alert("Please sign in first."); return; }
  const title = document.getElementById("bookTitle").value.trim();
  if (!title) { alert("Title is required."); return; }

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
    book.catalogKey = await upsertCatalog(book);   // 同步進共享書庫，並記下指向 catalog 的鑰匙
    if (currentDetailId && addModal.dataset.mode === "edit") {
      await booksCol.doc(currentDetailId).update({ ...book });
    } else {
      await booksCol.add(book);
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
  statusEl.innerHTML = `<span class="status-badge status-${escHtml(b.status)}">${escHtml(b.status)}</span>`;

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
  if (!rating) { el.textContent = "Select rating"; el.style.color = "#9b9a97"; return; }
  const label =
    rating <= 1 ? "😞 Didn't like it" :
    rating <= 2 ? "😐 It was ok"       :
    rating <= 3 ? "🙂 Liked it"        :
    rating <= 4 ? "😊 Really liked it" :
                  "🤩 Amazing!";
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
    aggScore.textContent = "—"; aggStars.innerHTML = ""; aggCount.textContent = "No reviews yet";
    ratingBars.innerHTML = "";
    reviewsList.innerHTML = `<div class="reviews-empty">📝 No reviews yet — be the first!</div>`;
    return;
  }

  const withRating = reviews.filter(r => r.rating > 0);
  const avg = withRating.length ? withRating.reduce((s,r) => s+r.rating, 0) / withRating.length : 0;
  aggScore.textContent = avg.toFixed(1);
  aggStars.innerHTML   = starsHTML(avg);
  aggCount.textContent = `${reviews.length} review${reviews.length > 1 ? "s" : ""}`;

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
}

document.getElementById("submitReviewBtn").addEventListener("click", async () => {
  if (!currentUser) { alert("Please sign in first."); return; }
  const name = document.getElementById("reviewerName").value.trim();
  const text = document.getElementById("reviewText").value.trim();
  const pct  = parseInt(document.getElementById("reviewPct").value);
  if (!name)           { alert("Please enter your name or nickname."); return; }
  if (!selectedRating) { alert("Please select a star rating."); return; }

  const catalogKey = currentCatalogKey();
  if (!catalogKey)     { alert("Cannot locate this book in the catalog."); return; }

  const btn = document.getElementById("submitReviewBtn");
  btn.disabled = true; btn.textContent = "Submitting...";
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
    document.getElementById("reviewText").value = "";
    selectedRating = 0; renderStars(0); updateStarLabel(0, true);
  } catch(e) { alert("Failed: " + e.message); }
  btn.disabled = false; btn.textContent = "Submit Review";
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
  document.querySelector("#addModal .modal-header h2").textContent = "Edit Book";
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
  importDropZone.innerHTML = `<div class="upload-icon">📂</div><div class="upload-text">Drag &amp; drop your CSV file here<br/><span>or click to browse</span></div><input type="file" id="importFileInput" accept=".csv" style="display:none" />`;
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
  importDropZone.innerHTML = `<div class="upload-icon">✅</div><div class="upload-text"><div class="upload-filename">${filename}</div><span style="color:#6b6b68;text-decoration:none">Click to change file</span></div><input type="file" id="importFileInput" accept=".csv" style="display:none" />`;
  bindFileInput();

  const preview = document.getElementById("importPreview");
  document.getElementById("previewSummary").textContent = `Found ${parsedBooks.length} books ready to import.`;

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
    labelEl.textContent = `Importing ${i + 1} / ${parsedBooks.length}...`;
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

  labelEl.textContent = `Done! ✓ ${success} imported${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ✗ ${failed} failed` : ""}.`;
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
  document.getElementById("shelfView").style.display   = view === "shelf"   ? "" : "none";
  document.getElementById("exploreView").style.display = view === "explore" ? "" : "none";
  if (view === "explore") {
    document.getElementById("publicBanner").style.display = "none";
    if (!exploreLoaded || viewingPublicUid) { viewingPublicUid = null; loadExplore(); }
    exploreLoaded = true;
  }
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
  grid.innerHTML = `<div class="loading">Loading...</div>`;
  try {
    const snap = await db.collection("catalog").get();
    exploreBooks = snap.docs.map(d => ({ key: d.id, ...d.data() }));
    renderExplore();
  } catch (e) {
    grid.innerHTML = `<div class="loading">載入失敗:${escHtml(e.message)}</div>`;
  }
}

function renderExplore() {
  const grid = document.getElementById("exploreGrid");
  const sort = document.getElementById("exploreSortSelect").value;
  let list = [...exploreBooks];
  if (sort === "rating")        list.sort((a,b) => avgOf(b) - avgOf(a) || (b.ratingCount||0) - (a.ratingCount||0));
  else if (sort === "popular")  list.sort((a,b) => (b.ratingCount||0) - (a.ratingCount||0));
  else                          list.sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0));

  document.getElementById("exploreCount").textContent = `${list.length} books`;
  if (!list.length) { grid.innerHTML = `<div class="loading">共享書庫還沒有書</div>`; return; }

  grid.innerHTML = list.map(c => {
    const avg   = avgOf(c);
    const cover = c.cover
      ? `<div class="book-cover"><img src="${escHtml(c.cover)}" alt="" loading="lazy" /></div>`
      : `<div class="no-cover"><div class="no-cover-icon">📖</div><div class="no-cover-title">${escHtml(c.title||"")}</div></div>`;
    const rating = c.ratingCount
      ? `<div class="card-rating"><span class="cr-star">${starsHTML(avg)}</span><span>${avg.toFixed(1)}</span><span class="cr-count">(${c.ratingCount})</span></div>`
      : `<div class="card-rating cr-empty">尚無評分</div>`;
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
  addBtn.textContent   = onShelf ? "✓ 已在你的書架" : "➕ 加入我的書架";

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
}

// ── 從探索把書加入我的書架 ──
document.getElementById("addToShelfBtn").addEventListener("click", async () => {
  if (!currentUser || !booksCol) { alert("請先登入"); return; }
  const c = exploreBooks.find(x => x.key === activeCatalogKey)
         || (viewingPublicUid ? { key: activeCatalogKey } : null);
  if (!c) return;
  const btn = document.getElementById("addToShelfBtn");
  btn.disabled = true; btn.textContent = "加入中...";
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
    btn.textContent = "✓ 已加入書架";
  } catch (e) {
    alert("加入失敗:" + e.message);
    btn.disabled = false; btn.textContent = "➕ 加入我的書架";
  }
});

// ── 隱私設定 ──
document.getElementById("openPrivacyBtn").addEventListener("click", async () => {
  if (!currentUser) { alert("請先登入"); return; }
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
  btn.disabled = true; btn.textContent = "儲存中...";
  try {
    await db.collection("users").doc(currentUser.uid).set({
      shelfPublic: document.getElementById("prefShelfPublic").checked,
      showReading: document.getElementById("prefShowReading").checked,
    }, { merge: true });
    closePrivacy();
  } catch (e) { alert("儲存失敗:" + e.message); }
  btn.disabled = false; btn.textContent = "儲存";
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
  document.getElementById("shelfView").style.display   = "none";
  document.getElementById("exploreView").style.display = "";
  exploreLoaded = true;
  viewingPublicUid = uid;
  const grid   = document.getElementById("exploreGrid");
  const banner = document.getElementById("publicBanner");
  const pbText = banner.querySelector(".pb-text");
  grid.innerHTML = `<div class="loading">Loading...</div>`;
  try {
    const prof  = await db.collection("users").doc(uid).get();
    const pdata = prof.exists ? prof.data() : {};
    const name  = pdata.displayName || "Reader";
    if (!pdata.shelfPublic) {
      banner.style.display = "flex"; pbText.textContent = `🔒 ${name} 的書架未公開`;
      grid.innerHTML = `<div class="loading">這位使用者沒有公開書架</div>`;
      return;
    }
    const snap  = await db.collection("users").doc(uid).collection("books").orderBy("createdAt","desc").get();
    const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    banner.style.display = "flex"; pbText.textContent = `📖 ${name} 的公開書架(${books.length} 本)`;
    renderPublicShelf(books);
  } catch (e) {
    banner.style.display = "flex"; pbText.textContent = `🔒 無法載入此書架`;
    grid.innerHTML = `<div class="loading">對方可能未公開書架</div>`;
  }
}

function renderPublicShelf(books) {
  const grid = document.getElementById("exploreGrid");
  document.getElementById("exploreCount").textContent = "";
  if (!books.length) { grid.innerHTML = `<div class="loading">這個書架是空的</div>`; return; }
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
        <div class="book-genre">${escHtml(b.status||"")}${pct ? ` · ${pct}%` : ""}</div>
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

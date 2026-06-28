// ── Firebase Init ──
firebase.initializeApp(firebaseConfig);
const db   = firebase.firestore();
const auth = firebase.auth();
// 明確要求登入狀態存 IndexedDB(本就是預設,寫死防環境差異/未來 SDK 變更把 token 存不住)
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

// ── State ──
let allBooks = [];
let currentUser  = null;
let booksCol     = null;
let booksUnsub   = null;
let booksLoaded  = false;   // 首次書庫 snapshot 是否已回來(用來分辨「載入中」vs「真的沒書」,避免 bookmark 開啟閃「沒有書」)
let currentFilter = { status: "all", year: "all", genre: "all", search: "", format: "all" };
let currentSort   = "createdAt_desc";
let currentDetailId = null;
// ── Phase B-3 狀態 ──
let activeCatalogKey = null;
let detailMode    = "shelf";   // "shelf" | "catalog"
let currentView   = "shelf";   // "shelf" | "explore"
let exploreBooks  = [];
let exploreLoaded = false;
let viewingPublicUid = null;
let lastPublicShelf = null;   // 快取目前看的公開書架 {books,name,state} → 語言切換時重渲染面板
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

// 信箱驗證分界線：帳號建立早於此一律放行（grandfather 既有/demo 帳號，
// 它們用假信箱收不到驗證信；只有此刻之後新註冊的 email/密碼帳號才強制驗證）
const EMAIL_VERIFY_CUTOFF = Date.UTC(2026, 5, 10, 0, 0, 0);

function needsEmailVerify(user) {
  if (user.emailVerified) return false;
  // 只擋 email/密碼註冊；Google 等第三方登入的信箱天生已驗證
  const isPassword = (user.providerData || []).some(p => p.providerId === "password");
  if (!isPassword) return false;
  // grandfather：分界線之前建立的舊帳號（含 demo 假信箱）放行
  const created = Date.parse((user.metadata && user.metadata.creationTime) || "");
  if (created && created < EMAIL_VERIFY_CUTOFF) return false;
  return true;
}

let everEnteredApp = false;        // 這次頁面載入是否曾真正進過 app(判斷 null 是「主動登出」還是「階段被異常丟掉」)
let userInitiatedSignOut = false;  // 使用者按了登出鈕才設 true

// 60 秒內已嘗試過自救重整 → 不再重整(防迴圈:session 真的死掉時別一直 reload)
function recentlyTriedAuthRecovery() {
  try {
    const t = parseInt(sessionStorage.getItem("authRecoverAt") || "0", 10);
    return t && (Date.now() - t < 60000);
  } catch (_) { return false; }
}

auth.onAuthStateChanged(user => {
  currentUser = user;
  if (user) {
    if (needsEmailVerify(user)) { showVerifyGate(user); return; }
    everEnteredApp = true;
    enterApp(user);
  } else {
    // 不是使用者主動登出、原本又在 app 內、且有網路 → 多半是 token 刷新/階段還原暫時失敗
    // (手機 + 約 1 小時 token 邊界最常見)。先重整一次讓 Firebase 從 IndexedDB 重新還原 session;
    // 暫時性 blip 會無痛救回,真的掉了才落到 landing(60 秒守門防迴圈)。
    if (!userInitiatedSignOut && everEnteredApp && navigator.onLine && !recentlyTriedAuthRecovery()) {
      try { localStorage.setItem("lastAuthDrop", JSON.stringify({ at: Date.now(), online: navigator.onLine, ua: navigator.userAgent.slice(0, 160) })); } catch (_) {}
      try { sessionStorage.setItem("authRecoverAt", String(Date.now())); } catch (_) {}
      location.reload();
      return;
    }
    userInitiatedSignOut = false;
    everEnteredApp = false;
    closeVerifyGate();
    hideApp();
    showLanding();          // 未登入 → 產品介紹首頁(按 CTA 才彈登入框)
    if (booksUnsub) { booksUnsub(); booksUnsub = null; }
    allBooks = [];
    booksLoaded = false;
  }
});

// ── Landing(未登入首頁)──
function showLanding() { document.getElementById("landingView").style.display = ""; }
function hideLanding() { document.getElementById("landingView").style.display = "none"; }
["ldSignInBtn", "ldCtaHero", "ldCtaBottom"].forEach(id =>
  document.getElementById(id).addEventListener("click", () => showAuthModal()));
// 從 landing 打開登入框後,點背景可關回 landing
document.getElementById("authModal").addEventListener("click", e => {
  if (e.target.id === "authModal" && !currentUser) closeAuthModal();
});
// 「看看怎麼運作」平滑捲到特色區
document.getElementById("ldLearnBtn").addEventListener("click", () =>
  document.getElementById("ldFeatures").scrollIntoView({ behavior: "smooth" }));
// 區塊捲動進場動畫
const ldObserver = new IntersectionObserver(
  entries => entries.forEach(en => { if (en.isIntersecting) en.target.classList.add("in"); }),
  { threshold: 0.12 });
// 只動畫「內容物」,不動 section 本身(section 帶背景色,整塊藏起來會露出深底閃爍)
document.querySelectorAll(
  "#landingView .ld-shot-frame, #landingView .ld-feature, #landingView .ld-section-title," +
  "#landingView .ld-eyebrow.on-light, #landingView .ld-showcase-text, #landingView .ld-cta-card"
).forEach(el => {
  el.classList.add("ld-reveal");
  ldObserver.observe(el);
});

// 通過驗證關卡後正式進入 app
function enterApp(user) {
  closeVerifyGate();
  closeAuthModal();
  hideLanding();
  showApp();
  booksCol = db.collection("users").doc(user.uid).collection("books");
  updateUserUI(user);
  startBooksListener();
  ensureProfile(user)
    .then(() => backfillCatalog(user.uid))
    .then(() => migrateRatingsOnce(user.uid))
    .then(() => cleanupRatingNotesOnce(user.uid));
}

// ── 待驗證關卡 UI ──
let _resendCooldown = false;
function showVerifyGate(user) {
  closeAuthModal();
  hideApp();
  const sub = document.getElementById("verifySub");
  if (sub) sub.innerHTML = `${escHtml(t("We sent a verification link to:"))}<br><strong>${escHtml(user.email || "")}</strong>`;
  const msg = document.getElementById("verifyMsg");
  if (msg) msg.style.display = "none";
  document.getElementById("verifyModal").classList.add("open");
}
function closeVerifyGate() {
  const m = document.getElementById("verifyModal");
  if (m) m.classList.remove("open");
}
function showVerifyMsg(msg, ok = false) {
  const el = document.getElementById("verifyMsg");
  el.textContent = msg;
  el.style.display = "";
  el.style.background = ok ? "#DCE8D2" : "#fde8e8";
  el.style.color      = ok ? "#53704D" : "#c0392b";
}

document.getElementById("verifyContinueBtn").addEventListener("click", async () => {
  const u = auth.currentUser;
  if (!u) { closeVerifyGate(); showAuthModal(); return; }
  const btn = document.getElementById("verifyContinueBtn");
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = t("Checking...");
  try {
    await u.reload();
    if (!needsEmailVerify(auth.currentUser)) {
      enterApp(auth.currentUser);
    } else {
      showVerifyMsg(t("Not verified yet. Please click the link in your email."), false);
    }
  } catch (e) {
    showVerifyMsg(getAuthErrorMessage(e.code), false);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
});

document.getElementById("resendVerifyBtn").addEventListener("click", async () => {
  const u = auth.currentUser;
  if (!u || _resendCooldown) return;
  const btn = document.getElementById("resendVerifyBtn");
  try {
    await u.sendEmailVerification();
    showVerifyMsg(t("✓ Verification email resent. Check your inbox."), true);
    _resendCooldown = true; btn.disabled = true;
    setTimeout(() => { _resendCooldown = false; btn.disabled = false; }, 30000);
  } catch (e) {
    showVerifyMsg(getAuthErrorMessage(e.code), false);
  }
});

document.getElementById("verifySignOutBtn").addEventListener("click", () => { userInitiatedSignOut = true; auth.signOut(); });

function showApp() {
  document.getElementById("appHeader").style.display = "";
  document.getElementById("sidebar").style.display   = "";
  document.getElementById("appBody").style.display   = "";
  setViewClass(currentView || "shelf");   // 進 app 立刻套分頁背景(書架=散物紙紋)
}
function hideApp() {
  document.getElementById("appHeader").style.display = "none";
  document.getElementById("sidebar").style.display   = "none";
  document.getElementById("appBody").style.display   = "none";
  setViewClass(null);                     // 回登入/landing → 還原預設暖紙背景
}
// 分頁背景 class(view-shelf / view-explore / view-feed),CSS 依此切換背景圖
function setViewClass(v) {
  document.body.classList.remove("view-shelf", "view-explore", "view-feed");
  if (v) document.body.classList.add("view-" + v);
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
  booksLoaded = false;   // 重新訂閱 → 回到「載入中」,等第一筆 snapshot
  booksUnsub = booksCol.orderBy("createdAt", "desc").onSnapshot(snapshot => {
    allBooks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    booksLoaded = true;   // 首筆(及之後)snapshot 已到 → 之後若空才是「真的沒書」
    rebuildSidebarFilters();
    rebuildFormatFilter();
    refreshLayout();
    maybeShowFirstBookPrivacyNotice();
  });
}

// 書架出現第一本書時，提醒「公開」狀態的使用者：你的書庫目前公開、可改私密。
// 只對「預設公開」的人(新帳號)跳，且一輩子只跳一次(profile 旗標 shelfPublicNoticeSeen)。
function maybeShowFirstBookPrivacyNotice() {
  if (!currentUser || allBooks.length < 1) return;
  if (!myProfile || myProfile.shelfPublic !== true) return;   // 私密的人不必提醒
  if (myProfile.shelfPublicNoticeSeen) return;                // 已看過 → 不再跳
  myProfile.shelfPublicNoticeSeen = true;                     // 先設記憶體旗標，擋住快照連發重複跳
  const m = document.getElementById("shelfPublicNoticeModal");
  if (m) m.classList.add("open");
  db.collection("users").doc(currentUser.uid)
    .set({ shelfPublicNoticeSeen: true }, { merge: true })
    .catch(() => {});                                          // 持久化：跨裝置也只跳一次
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

// 洗掉 Google Books 簡介裡夾帶的 HTML 標籤,只留純文字;
// 太短的多半是「Originally published: ...」之類的出版 metadata,不是真簡介 → 不採用
function cleanDesc(d) {
  const txt = String(d || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
  return txt.length >= 60 ? txt : "";
}

// 把一本書 upsert 進共享 catalog（匿名，不含任何使用者資訊）
async function upsertCatalog(book, desc) {
  const key = catalogKeyFor(book.title, book.author);
  const ref = db.collection("catalog").doc(key);
  const d   = cleanDesc(desc);
  try {
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        title:      book.title  || "",
        author:     book.author || "",
        genre:      book.genre  || "",
        totalPages: book.totalPages || 0,
        cover:      book.cover  || "",
        description: d,
        ratingCount: 0,
        ratingSum:   0,
        createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt:  firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      // 已存在：只補「原本沒有的封面/簡介」，絕不覆蓋評分聚合
      const patch = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      if (!snap.data().cover && book.cover) patch.cover = book.cover;
      if (!snap.data().description && d)    patch.description = d;
      await ref.set(patch, { merge: true });
    }
  } catch (e) { console.warn("catalog upsert failed:", e); }
  return key;
}

// 四碼鑑別碼(0000–9999):同名使用者靠它區分，全站顯示成 name#tag
function genTag() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}
// 輕量查重:撈同名使用者已用掉的 tag 盡量避開;查詢失敗(規則/網路)就退回純隨機(碰撞機率極低)
async function uniqueTag(name) {
  let tag = genTag();
  try {
    const snap = await db.collection("users").where("displayName", "==", name).limit(50).get();
    const used = new Set(snap.docs.map(d => d.data().tag).filter(Boolean));
    for (let i = 0; i < 20 && used.has(tag); i++) tag = genTag();
  } catch (e) { /* 退回純隨機 */ }
  return tag;
}
// 顯示名:有鑑別碼就接 #tag
function fmtName(p) {
  if (!p) return "Reader";
  const n = p.displayName || "Reader";
  return p.tag ? `${n}#${p.tag}` : n;
}
// 去正規化資料(評論/動態/討論)用:名稱 + 可選 #tag(舊資料沒 tag 就只顯示名稱)
function nameTag(name, tag) { return tag ? `${name || "Reader"}#${tag}` : (name || "Reader"); }
// 寫入去正規化資料時要帶上的本人鑑別碼(沒有就 null)
function myTag() { return (myProfile && myProfile.tag) || null; }
// 本人頭像來源:一律以 profile photoURL 為準(自訂 base64 頭像也走這裡),退回 Auth 照片
function myPhoto() { return (myProfile && myProfile.photoURL) || (currentUser && currentUser.photoURL) || ""; }

// 把使用者選的圖在瀏覽器端壓成小頭像(最長邊 128px、JPEG)→ 回傳 base64 data URL
// 這樣頭像直接存進 Firestore profile,免開 Firebase Storage / 免 Blaze 綁卡
function resizeImageToDataURL(file, maxSide = 128, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      try { resolve(canvas.toDataURL("image/jpeg", quality)); }
      catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}
// ensureProfile 拿到(含 tag 的)profile 後,把右上角名字補上 #tag、頭像換成 profile 的 photoURL
function refreshIdentityUI() {
  const nameEl = document.getElementById("userDisplayName");
  const avEl   = document.getElementById("userAvatarSm");
  if (nameEl) nameEl.textContent = fmtName(myProfile);
  if (avEl) {
    const url = myProfile.photoURL || (currentUser && currentUser.photoURL) || "";
    const nm  = myProfile.displayName || "R";
    if (url) avEl.innerHTML = `<img src="${url}" alt="${escHtml(nm)}" />`;
    else     avEl.textContent = nm.slice(0, 2).toUpperCase();
  }
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
        tag:          await uniqueTag(base.displayName),  // 四碼鑑別碼
        bio:          "",
        discord:      "",
        discordPublic: true,  // Discord 是否在公開檔案顯示(預設開)
        favBook:      null,   // 年度最愛的書 {key,title,cover}
        shelfPublic:  true,   // 預設：書庫公開（社群比對需要；只影響新帳號，現有使用者不變）
        showReading:  true,   // 「正在閱讀」也預設公開（KC 2026-06-14；只影響新帳號）
        followerCount: 0,     // 初始化 → discovery 的 orderBy(followerCount) 才排得到
        reviewCount:   0,
        createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
      };
      await ref.set(init);
      myProfile = init;
    } else {
      const d = snap.data();
      const patch = { ...base };               // 只更新名稱/頭像，不動隱私開關
      if (d.followerCount == null) patch.followerCount = 0;   // 自我修復:補上缺的計數欄
      if (d.reviewCount   == null) patch.reviewCount   = 0;   //  → 公開後在 discovery 排得到
      if (d.tag == null) patch.tag = await uniqueTag(d.displayName || base.displayName);  // 老帳號補鑑別碼
      await ref.set(patch, { merge: true });
      myProfile = { ...d, ...patch };
    }
    refreshIdentityUI();
    applySortPref();   // 套用雲端記住的書架排序(跨裝置同步)
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
  if (confirm("確定要登出嗎？")) { userInitiatedSignOut = true; auth.signOut(); }
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
    document.getElementById("authTermsWrap").style.display       = isSignup ? "flex" : "none";
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
        showAuthError("Passwords do not match."); return;
      }
      if (password.length < 6) {
        showAuthError("Password must be at least 6 characters."); return;
      }
      if (!document.getElementById("authAgreeTerms").checked) {
        showAuthError(t("Please agree to the Terms of Use and Privacy Policy to continue.")); return;
      }
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      if (displayName) await cred.user.updateProfile({ displayName });
      // 寄驗證信；onAuthStateChanged 會接手把新帳號擋進待驗證關卡
      cred.user.sendEmailVerification().catch(() => {});
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
  } catch (e) {
    showAuthError(getAuthErrorMessage(e.code));
  } finally {
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
  el.style.background = isSuccess ? "#DCE8D2" : "#fde8e8";
  el.style.color      = isSuccess ? "#53704D" : "#c0392b";
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

// 「依閱讀狀態」排序的優先序(數字小=排前):正在讀 → TBR → 想讀 → 完成 →（DNF 最後)
const STATUS_SORT = { "Now Reading": 0, "TBR": 1, "Want to Read": 2, "Finished": 3, "DNF": 4 };

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
  // 進度排序只顯示「正在讀」的書:否則永遠只看到 100% 讀完的(會議結論)
  if (field === "progress") {
    books = books.filter(b => {
      if (b.status === "Now Reading") return true;
      const p = bookPct(b);
      return p !== null && p > 0 && p < 100 && b.status !== "Finished" && b.status !== "DNF";
    });
  }
  books.sort((a, b) => {
    if (field === "status") {
      // 依閱讀狀態分群排;同狀態內照加入日期(新→舊)
      const pa = STATUS_SORT[a.status] ?? 9, pb = STATUS_SORT[b.status] ?? 9;
      if (pa !== pb) return pa - pb;
      return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    }
    let va, vb;
    if (field === "title" || field === "author") {
      va = (a[field] || "").toLowerCase(); vb = (b[field] || "").toLowerCase();
    } else if (field === "finishDate") {
      va = a.finishDate || ""; vb = b.finishDate || "";
    } else if (field === "progress") {
      va = bookPct(a) ?? -1;
      vb = bookPct(b) ?? -1;
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
    // 還沒載入完 → 顯示「載入中」,別誤報「沒有書」(bookmark/PWA 開啟的載入空檔最明顯)
    bookGrid.innerHTML = `<div class="empty-state">${booksLoaded ? t("No books found.") : t("Loading...")}</div>`;
    updateShelfNav();
    return;
  }

  bookGrid.innerHTML = books.map(b => {
    const pct = bookPct(b);
    const coverHTML = b.cover
      ? `<div class="book-cover"><img loading="lazy" decoding="async" ${coverAttrs(b.cover)} alt="${escHtml(b.title)}" referrerpolicy="no-referrer" onerror="if(window.__coverFallback(this))return; if(window.__retryProxy(this))return; this.parentElement.innerHTML='<div class=no-cover><div class=no-cover-icon>📖</div><div class=no-cover-title>${escHtml(b.title)}</div></div>'" /></div>`
      : `<div class="no-cover"><div class="no-cover-icon">📖</div><div class="no-cover-title">${escHtml(b.title)}</div></div>`;
    return `
      <div class="book-card" data-id="${b.id}">
        ${coverHTML}
        <div class="book-info">
          <div class="book-title">${escHtml(b.title)}</div>
          <div class="book-author">${escHtml(b.author || "")}</div>
          <div class="book-genre">${escHtml(genreLabel(b.genre))}</div>
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

  // 渲染完用真實卡片高度修正排數,再同步箭頭/頁碼
  requestAnimationFrame(() => { applyShelfRows(); updateShelfNav(); });
}

// ══ 書架捲動引擎:桌面=橫向書牆(拖曳+慣性+箭頭+頁碼),手機=原生直向捲動 ══
const SHELF_MOBILE = window.matchMedia("(max-width: 600px)");
function shelfHorizontal() { return !SHELF_MOBILE.matches; }

// 直欄排數:依可視高度塞得下幾排(桌面橫向用;手機排版交給 CSS)
// 微縮救排:只差一點點就能塞兩排時(縮 ≤15% 且不低於 ZMIN),自動微縮封面把第二排救回來
// (1080p 實測差距常只有幾 px,排數對瀏覽體驗的影響遠大於封面差幾 px)
function applyShelfRows(grid) {
  grid = grid || bookGrid;   // 預設主書架;公開書架傳 #exploreGrid 進來(同樣吃 --card-w-fit)
  const root = document.documentElement.style;
  const base = getCardW();
  if (!shelfHorizontal()) { root.setProperty("--card-w-fit", base + "px"); return; }
  const cs   = getComputedStyle(grid);
  const gap  = parseFloat(cs.rowGap) || 20;
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const innerH = grid.clientHeight - padY;
  // 卡高 = 封面(寬×1.5)+ 資訊區(固定高,量測)+ 邊框等雜項
  const info  = grid.querySelector(".book-info");
  const infoH = info ? info.getBoundingClientRect().height : 150;
  const card  = grid.querySelector(".book-card");
  const extra = card ? Math.max(0, card.getBoundingClientRect().height - card.getBoundingClientRect().width * 1.5 - infoH) : 2;
  const cardH = w => w * 1.5 + infoH + extra;
  let rows  = Math.max(1, Math.floor((innerH + gap) / (cardH(base) + gap)));
  let dispW = base;
  if (rows === 1) {
    const maxH = (innerH + gap) / 2 - gap;                       // 塞兩排時一張卡的高度上限
    const wFit = Math.floor((maxH - infoH - extra) / 1.5);
    if (wFit >= Math.max(ZMIN, Math.round(base * 0.85))) { rows = 2; dispW = wFit; }
  } else {
    // 撐滿救空:排數固定後,把封面放大到剛好填滿高度(上限=縮放值的 +18%,免得架空縮放控制)
    const maxH = (innerH + gap) / rows - gap;
    const wFit = Math.floor((maxH - infoH - extra) / 1.5);
    dispW = Math.max(base, Math.min(wFit, Math.round(base * 1.18), ZMAX));
  }
  root.setProperty("--shelf-rows", rows);
  root.setProperty("--card-w-fit", dispW + "px");
}

// 一欄寬 / 一頁寬(=最接近一個畫面的整欄數)
function shelfColW() {
  const card = bookGrid.querySelector(".book-card");
  const gap  = parseFloat(getComputedStyle(bookGrid).columnGap) || 20;
  return (card ? card.getBoundingClientRect().width : getCardW()) + gap;
}
function shelfPageW() {
  // 欄數取捨去:一頁只算「完整看得到的欄」,翻頁才不會跳過半欄的書
  const cw = shelfColW();
  return Math.max(1, Math.floor(bookGrid.clientWidth / cw)) * cw;
}

// 側邊箭頭 + 頁碼列:跟著捲動位置同步;頁=一個畫面寬
function updateShelfNav() {
  const pg  = document.getElementById("pagination");
  const bar = document.getElementById("shelfBottomBar");
  const prevBtn = document.getElementById("flipPrevBtn");
  const nextBtn = document.getElementById("flipNextBtn");
  const max = bookGrid.scrollWidth - bookGrid.clientWidth;
  if (!shelfHorizontal() || max <= 4) {
    bar.style.display = "none";
    prevBtn.classList.remove("show"); nextBtn.classList.remove("show");
    return;
  }
  prevBtn.classList.toggle("show", bookGrid.scrollLeft > 4);
  nextBtn.classList.toggle("show", bookGrid.scrollLeft < max - 4);
  bar.style.display = "flex";

  // 迷你指示條:寬=可視比例(下限 8% 免得細到看不見),位置=捲動進度
  const thumb = document.getElementById("scrollIndThumb");
  const frac  = Math.max(0.08, bookGrid.clientWidth / bookGrid.scrollWidth);
  thumb.style.width = (frac * 100) + "%";
  thumb.style.left  = (bookGrid.scrollLeft / max) * (1 - frac) * 100 + "%";

  const pageW = shelfPageW();
  const total = Math.max(1, Math.ceil(bookGrid.scrollWidth / pageW));
  let cur = Math.round(bookGrid.scrollLeft / pageW) + 1;
  if (bookGrid.scrollLeft >= max - 4) cur = total;   // 捲到底就算最後一頁
  cur = Math.min(cur, total);
  const key = total + ":" + cur;
  if (pg.dataset.state === key) return;   // 頁數/所在頁沒變就不重建 DOM
  pg.dataset.state = key;

  const show   = new Set([1, total, cur, cur-1, cur+1, cur-2, cur+2].filter(p => p >= 1 && p <= total));
  const sorted = [...show].sort((a, b) => a - b);
  let html = `<button class="page-btn" ${cur===1?"disabled":""} onclick="goShelfPage(${cur-1})">‹</button>`;
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) html += `<span class="page-info">…</span>`;
    html += `<button class="page-btn ${p===cur?"active":""}" onclick="goShelfPage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" ${cur===total?"disabled":""} onclick="goShelfPage(${cur+1})">›</button>`;
  html += `<span class="page-info">${cur} / ${total}</span>`;
  pg.innerHTML = html;
}
function goShelfPage(p) {
  const max = bookGrid.scrollWidth - bookGrid.clientWidth;
  bookGrid.scrollTo({ left: Math.max(0, Math.min(max, (p - 1) * shelfPageW())), behavior: "smooth" });
}
let shelfNavPending = false;
bookGrid.addEventListener("scroll", () => {
  if (shelfNavPending) return;
  shelfNavPending = true;
  requestAnimationFrame(() => { shelfNavPending = false; updateShelfNav(); });
}, { passive: true });

// 箭頭:平滑捲一個畫面,並對齊整欄(不會停在半張卡片)
function scrollShelfPage(dir) {
  const cw = shelfColW();
  const target = Math.max(0, Math.round((bookGrid.scrollLeft + dir * shelfPageW()) / cw) * cw);
  bookGrid.scrollTo({ left: target, behavior: "smooth" });
}
document.getElementById("flipNextBtn").addEventListener("click", () => scrollShelfPage(1));
document.getElementById("flipPrevBtn").addEventListener("click", () => scrollShelfPage(-1));

// 滑鼠拖曳捲動 + 放手慣性(桌面橫向、手機直向;觸控由原生處理,不攔截)
let shelfDrag = null, shelfMomentum = 0, suppressCardClick = false;
function stopShelfMomentum() { cancelAnimationFrame(shelfMomentum); }
bookGrid.addEventListener("pointerdown", e => {
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  stopShelfMomentum();
  shelfDrag = { lastX: e.clientX, lastY: e.clientY, lastT: performance.now(), moved: 0, v: 0 };
});
window.addEventListener("pointermove", e => {
  if (!shelfDrag) return;
  const horiz = shelfHorizontal();
  const now = performance.now();
  const d   = horiz ? e.clientX - shelfDrag.lastX : e.clientY - shelfDrag.lastY;
  const dt  = Math.max(1, now - shelfDrag.lastT);
  shelfDrag.v = 0.8 * shelfDrag.v + 0.2 * (d / dt * 16);   // 平滑化的每幀速度
  if (horiz) bookGrid.scrollLeft -= d; else bookGrid.scrollTop -= d;
  shelfDrag.moved += Math.abs(d);
  shelfDrag.lastX = e.clientX; shelfDrag.lastY = e.clientY; shelfDrag.lastT = now;
  if (shelfDrag.moved > 5) { bookGrid.classList.add("dragging"); suppressCardClick = true; }
});
window.addEventListener("pointerup", () => {
  if (!shelfDrag) return;
  let v = shelfDrag.v;
  shelfDrag = null;
  bookGrid.classList.remove("dragging");
  setTimeout(() => { suppressCardClick = false; }, 50);   // 點擊事件在 pointerup 後同步發出,50ms 後保險歸位
  if (Math.abs(v) > 2) {                                  // 放手夠快才有慣性
    const horiz = shelfHorizontal();
    let prevPos = -1;
    const glide = () => {
      if (horiz) bookGrid.scrollLeft -= v; else bookGrid.scrollTop -= v;
      const pos = horiz ? bookGrid.scrollLeft : bookGrid.scrollTop;
      v *= 0.95;
      if (Math.abs(v) > 0.4 && pos !== prevPos) {
        prevPos = pos;
        shelfMomentum = requestAnimationFrame(glide);
      }
    };
    shelfMomentum = requestAnimationFrame(glide);
  }
});
// 滾輪:桌面把直滾輪轉成橫向捲(書牆是橫的);觸控板橫滑原生就會動
bookGrid.addEventListener("wheel", e => {
  stopShelfMomentum();
  if (!shelfHorizontal()) return;
  const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  if (Math.abs(dy) > Math.abs(e.deltaX)) { e.preventDefault(); bookGrid.scrollLeft += dy; }
}, { passive: false });
// 拖過的那一下放手不算點書(攔在捕獲階段,卡片 listener 收不到)
bookGrid.addEventListener("click", e => {
  if (suppressCardClick) { e.stopPropagation(); e.preventDefault(); suppressCardClick = false; }
}, true);
bookGrid.addEventListener("dragstart", e => e.preventDefault());   // 擋瀏覽器原生拖圖

function calcPct(current, total) {
  if (!total || total <= 0) return null;
  if (!current || current <= 0) return 0;
  return Math.min(100, Math.round((current / total) * 100));
}
// 一本書的完成度 %:優先用獨立的 progressPct(電子書/手動 % 用,不需頁數),否則用頁數推算
function bookPct(b) {
  if (b && b.progressPct != null && b.progressPct !== "") {
    const p = Math.round(Number(b.progressPct));
    return isNaN(p) ? null : Math.max(0, Math.min(100, p));
  }
  return calcPct(b ? b.currentPage : 0, b ? b.totalPages : 0);
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
    genres.map(g => `<option value="${escHtml(g)}">${escHtml(genreLabel(g))}</option>`).join("");
  genreFilter.value = currentFilter.genre;
  genreFilter.onchange = () => setFilter("genre", genreFilter.value);
}

function setFilter(key, val) {
  currentFilter[key] = val;
  bookGrid.scrollLeft = 0; bookGrid.scrollTop = 0;   // 換條件就捲回開頭
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

const searchClear = document.getElementById("searchClear");
function syncSearchClear() { if (searchClear) searchClear.style.display = searchInput.value ? "" : "none"; }
searchInput.addEventListener("input", e => {
  currentFilter.search = e.target.value.trim();
  syncSearchClear();
  bookGrid.scrollLeft = 0; bookGrid.scrollTop = 0;   // 換條件就捲回開頭
  renderGrid();
});
// 搜尋框 ✕:清掉打的字 → 直接回原本(未搜尋)的畫面(ERI 要求)
if (searchClear) searchClear.addEventListener("click", () => {
  searchInput.value = "";
  currentFilter.search = "";
  syncSearchClear();
  bookGrid.scrollLeft = 0; bookGrid.scrollTop = 0;
  renderGrid();
  searchInput.focus();
});

// ── Filter Bar ──
document.getElementById("sortSelect").addEventListener("change", e => {
  currentSort = e.target.value;
  localStorage.setItem("sortPref", currentSort);                       // 本地即時快取
  if (myProfile) myProfile.sortPref = currentSort;
  if (currentUser) db.collection("users").doc(currentUser.uid)         // 寫進 Firebase → 跨裝置同步
    .set({ sortPref: currentSort }, { merge: true }).catch(() => {});
  bookGrid.scrollLeft = 0; bookGrid.scrollTop = 0;   // 換條件就捲回開頭
  renderGrid();
});

// 套用「記住的排序」:優先用 Firebase 個人檔案(跨裝置同步),退回本地 localStorage(登入前即時)。
// 在腳本載入時(用本地值)與 ensureProfile 取到雲端值後各呼叫一次。
function applySortPref() {
  const pref = (myProfile && myProfile.sortPref) || localStorage.getItem("sortPref");
  if (!pref) return;
  const sel = document.getElementById("sortSelect");
  if (!sel || ![...sel.options].some(o => o.value === pref)) return;   // 無效/舊值 → 略過
  localStorage.setItem("sortPref", pref);                              // 雲端值回寫本地快取
  if (currentSort === pref && sel.value === pref) return;              // 已是該排序就不重排
  currentSort = pref;
  sel.value = pref;
  if (currentView === "shelf" && allBooks.length) renderGrid();        // 已渲染過 → 立即重排
}
applySortPref();   // 載入即套用本地快取(雲端值稍後 ensureProfile 再覆蓋)

document.getElementById("formatSelect").addEventListener("change", e => {
  currentFilter.format = e.target.value;
  bookGrid.scrollLeft = 0; bookGrid.scrollTop = 0;   // 換條件就捲回開頭
  renderGrid();
  updateActiveFilters();
});

document.getElementById("clearFiltersBtn").addEventListener("click", () => {
  currentFilter = { ...currentFilter, status: "all", year: "all", genre: "all", format: "all", search: "" };
  document.getElementById("searchInput").value = "";
  syncSearchClear();
  document.getElementById("formatSelect").value = "all";
  // 排序是「記住的偏好」,清篩選不動它(由 sortSelect 自己維持)
  bookGrid.scrollLeft = 0; bookGrid.scrollTop = 0;   // 換條件就捲回開頭
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
function getCardW() {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue("--card-w"), 10) || ZDEF;
}

// 初次/縮放/resize 後:先用估計值定排數再渲染(渲染完 renderGrid 會用真卡高修正)
function refreshLayout() {
  if (currentView === "shelf") { applyShelfRows(bookGrid); renderGrid(); return; }
  // 公開書架(探索→某人書架)也用同一套 .book-grid → 縮放/resize 時也要重算欄寬,
  // 但不重渲染書卡(那是 renderPublicShelf 的事、且需要 books 資料)
  if (currentView === "explore" && viewingPublicUid) {
    applyShelfRows(document.getElementById("exploreGrid"));
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
    range.addEventListener("input",  () => {                          // 拖曳中:即時縮放(只調欄寬、不重渲染)
      applyCardW(+range.value);
      applyShelfRows((currentView === "explore" && viewingPublicUid) ? document.getElementById("exploreGrid") : bookGrid);
    });
    range.addEventListener("change", () => refreshLayout());          // 放開:重算填滿
  }
  if (out) out.addEventListener("click", () => setZoom(getCardW() - ZSTEP));
  if (inn) inn.addEventListener("click", () => setZoom(getCardW() + ZSTEP));
  let t; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(refreshLayout, 150); });
})();

function updateActiveFilters() {
  const clearBtn = document.getElementById("clearFiltersBtn");
  if (!clearBtn) return;
  const anyActive = currentFilter.format !== "all" || currentFilter.status !== "all"
    || currentFilter.year !== "all" || currentFilter.genre !== "all" || currentFilter.search;
  clearBtn.style.display = anyActive ? "" : "none";
}

const FORMAT_ORDER = ["Physical", "Ebook", "Audiobook", "Borrowed"];   // 固定順序:實體書→電子書→有聲書→借閱(ERI 要求:別隨新增的書亂跳)
function rebuildFormatFilter() {
  const present = new Set(allBooks.map(b => b.format).filter(Boolean));
  const known = FORMAT_ORDER.filter(f => present.has(f));               // 已知版本照固定順序
  const extra = [...present].filter(f => !FORMAT_ORDER.includes(f)).sort();   // 非標準值(舊資料)補在後面
  const formats = [...known, ...extra];
  const sel = document.getElementById("formatSelect");
  const cur = sel.value;
  sel.innerHTML = `<option value="all">${t("All Formats")}</option>` + formats.map(f => `<option value="${escHtml(f)}">${escHtml(t(f))}</option>`).join("");
  if (formats.includes(cur)) sel.value = cur;
}

// ── 手機抽屜選單(漢堡鈕開、遮罩關;選狀態/開彈窗後自動收回)──
document.getElementById("menuBtn").addEventListener("click", () =>
  document.body.classList.toggle("side-open"));
document.getElementById("sideBackdrop").addEventListener("click", () =>
  document.body.classList.remove("side-open"));
document.getElementById("sidebar").addEventListener("click", (e) => {
  if (e.target.closest("#statusFilter li, .add-btn, .import-btn, .filter-clear-btn"))
    document.body.classList.remove("side-open");
});

// ── 手機:把次要 header 控制項搬進抽屜,讓頂列只剩 [☰][分頁][搜尋],永不爆寬 ──
// 關鍵:搬「同一個 DOM 節點」(append 會移動而非複製)→ 載入時綁的監聽器跟著走,
// 且不會產生重複 id(app.js 大量用 getElementById,複製會壞 #bookCount/#signOutBtn 等)。
// 桌面↔手機切換(改視窗寬/轉向)即時還原,與書架引擎共用同一個 SHELF_MOBILE。
(function setupHeaderRelocate() {
  const hdrActions = document.querySelector(".hdr-actions");
  const drawerTools = document.getElementById("drawerTools");
  const drawerId = document.getElementById("drawerIdentity");
  if (!hdrActions || !drawerTools || !drawerId) return;
  const tools = [
    document.getElementById("bookCount"),
    document.querySelector(".sort-pop-wrap"),
    document.getElementById("refreshBtn"),
    document.getElementById("openPrivacyBtn"),
    document.getElementById("langToggle"),
  ].filter(Boolean);
  const identity = document.getElementById("userInfo");
  function sync() {
    if (SHELF_MOBILE.matches) {
      tools.forEach(n => drawerTools.appendChild(n));
      if (identity) drawerId.appendChild(identity);
    } else {
      // 還原回 header,維持原本順序:書數→排序→重整→設定→語言→使用者
      tools.forEach(n => hdrActions.appendChild(n));
      if (identity) hdrActions.appendChild(identity);
    }
  }
  sync();
  SHELF_MOBILE.addEventListener("change", sync);
  // 保險:少數環境(部分 in-app 瀏覽器/模擬器)matchMedia change 不觸發,resize 補位
  let _rzT;
  window.addEventListener("resize", () => { clearTimeout(_rzT); _rzT = setTimeout(sync, 150); });
})();

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

// 從搜尋結果挑書時暫存的簡介(隨儲存寫進共享書庫)
let pendingBookDesc = "";

async function fetchBookInfo() {
  const query = document.getElementById("bookSearchInput").value.trim();
  if (!query) return;
  fetchStatus.textContent = t("Searching...");

  const isISBN    = /^[\d\-X]{10,17}$/.test(query.replace(/\s/g, ""));
  const cleanISBN = query.replace(/[\s\-]/g, "");
  const results   = [];

  // 主來源 Google Books(封面/metadata 最齊)。抓多筆,讓使用者自己挑,不再盲填第一筆(=之前跳成別本書的根因)
  try {
    const apiQuery = isISBN ? `isbn:${cleanISBN}` : encodeURIComponent(query);
    const res  = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${apiQuery}&maxResults=12&key=${GBOOKS_KEY}`);
    const data = await res.json();
    (data.items || []).forEach(it => {
      const info = it.volumeInfo || {};
      results.push({
        title: info.title || "",
        author: (info.authors || []).join(", "),
        genre: (info.categories || []).join(", "),
        totalPages: info.pageCount || "",
        cover: info.imageLinks ? tidyCover(info.imageLinks.thumbnail || info.imageLinks.smallThumbnail || "") : "",
        year: (info.publishedDate || "").slice(0, 4),
        description: cleanDesc(info.description || ""),
      });
    });
  } catch {}

  // 補:Open Library(Google 沒結果時)
  if (!results.length) {
    try {
      const url = isISBN
        ? `https://openlibrary.org/search.json?isbn=${cleanISBN}&limit=8`
        : `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=8`;
      const res  = await fetch(url);
      const data = await res.json();
      (data.docs || []).forEach(doc => {
        results.push({
          title: doc.title || "",
          author: (doc.author_name || []).slice(0, 2).join(", "),
          genre: (doc.subject || []).slice(0, 2).join(", "),
          totalPages: doc.number_of_pages_median || "",
          cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
          year: doc.first_publish_year || "",
        });
      });
    } catch {}
  }

  if (!results.length) { fetchStatus.textContent = t("No results found. Fill in manually."); return; }
  fetchStatus.textContent = t("Pick the right book:");
  renderSearchResults(results);
}

// 列出搜尋結果:開浮窗網格(蓋在編輯視窗上,空間大、一眼多本),點一筆填表並關窗
function renderSearchResults(list) {
  const overlay = document.getElementById("bsrOverlay");
  const grid    = document.getElementById("bsrGrid");
  grid.innerHTML = list.map((r, i) => `
    <div class="bsr-item" data-i="${i}">
      ${r.cover ? `<img class="bsr-cover" ${coverAttrs(r.cover)} alt="" loading="lazy" referrerpolicy="no-referrer" onerror="if(window.__coverFallback(this))return; if(window.__retryProxy(this))return; this.style.display='none'">` : `<div class="bsr-cover bsr-nocover">📖</div>`}
      <div class="bsr-meta">
        <div class="bsr-title">${escHtml(r.title)}</div>
        <div class="bsr-sub">${escHtml(r.author || "?")}${r.year ? " · " + escHtml(String(r.year)) : ""}${r.totalPages ? " · " + r.totalPages + "p" : ""}</div>
      </div>
    </div>`).join("");
  grid.querySelectorAll(".bsr-item").forEach(item => item.addEventListener("click", () => {
    const r = list[parseInt(item.dataset.i)];
    fillForm({ title: r.title, author: r.author, genre: r.genre, totalPages: r.totalPages, cover: r.cover });
    pendingBookDesc = r.description || "";   // 暫存簡介,儲存時跟著進共享書庫(不進私人書 doc,避免每本書都拖一大段文字)
    closeSearchResults();
    fetchStatus.textContent = t("Selected") + `: "${r.title}"`;
  }));
  overlay.classList.add("open");
  grid.scrollTop = 0;
}
function closeSearchResults() {
  document.getElementById("bsrOverlay").classList.remove("open");
  document.getElementById("bsrGrid").innerHTML = "";
}
document.getElementById("bsrClose").addEventListener("click", closeSearchResults);
document.getElementById("bsrOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("bsrOverlay")) closeSearchResults();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && document.getElementById("bsrOverlay").classList.contains("open")) closeSearchResults();
});

function fillForm({ title="", author="", genre="", totalPages="", cover="" } = {}) {
  if (title)      document.getElementById("bookTitle").value      = title;
  if (author)     document.getElementById("bookAuthor").value     = author;
  if (genre)      document.getElementById("bookGenre").value      = genre;
  if (totalPages) document.getElementById("bookTotalPages").value = totalPages;
  if (cover)      setCover(cover);
  syncGenreSelect(document.getElementById("bookGenre").value);   // 下拉跟著選到對的項/開自訂框
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

// 封面載入容錯:外部圖載入失敗時(多半是台灣電商防盜連擋外站),
// 自動改走 images.weserv.nl 圖片代理重試一次(代理 server 端抓圖、無 referrer,可繞過防盜連)。
// 只對 http(s) 外部圖生效、每張只重試一次;data:/漸層 不碰。回傳 true=已換代理(略過原本的 No Cover 後援)。
window.__retryProxy = function (img) {
  const orig = img.dataset.orig || img.getAttribute("src") || "";
  if (img.dataset.proxied || !/^https?:\/\//i.test(orig)) return false;
  img.dataset.orig = orig;
  img.dataset.proxied = "1";
  img.src = "https://images.weserv.nl/?url=" + encodeURIComponent(orig);
  return true;
};

// 封面網址清洗:Google Books 縮圖常帶 edge=curl(圖上畫假翻角)→ 拿掉;http→https。
// 顯示端統一過這層,既有資料庫裡的舊網址不用遷移。
function tidyCover(u) {
  if (!u || !/^https?:\/\//i.test(u)) return u || "";
  u = u.replace(/^http:\/\//i, "https://");
  if (/books\.google/i.test(u)) u = u.replace(/([?&])edge=curl&?/i, "$1").replace(/[?&]$/, "");
  return u;
}
// 顯示用高解析版。⚠️ Google Books 不能升 zoom:沒有高解析版時它回 200 的
// 「image not available」佔位圖(甚至內頁掃描)而非 404 → onerror 退回機制不會觸發,
// 書架會掛滿佔位圖(2026-06-12 實爆過)。只升 OpenLibrary(-M→-L,加 default=false 讓缺圖回 404 走退回)。
function hiCover(u) {
  const t = tidyCover(u);
  if (/covers\.openlibrary\.org\/b\//i.test(t)) return t.replace(/-M\.jpg$/i, "-L.jpg?default=false");
  return t;
}
// img onerror 第一關:有 data-fb(高解析失敗的退路)就換上去,每張只退一次。
window.__coverFallback = function (img) {
  const fb = img.dataset.fb;
  if (!fb || img.dataset.fbDone || img.getAttribute("src") === fb) return false;
  img.dataset.fbDone = "1";
  img.src = fb;
  return true;
};
// 模板共用:回傳 src(高解析)+ data-fb(原版退路)屬性字串
function coverAttrs(u) {
  const hi = hiCover(u), lo = tidyCover(u);
  return `src="${escHtml(hi)}"${hi !== lo ? ` data-fb="${escHtml(lo)}"` : ""}`;
}

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
    coverPreview.innerHTML = `<img ${coverAttrs(value)} alt="cover" referrerpolicy="no-referrer" onerror="if(window.__coverFallback(this))return; if(window.__retryProxy(this))return; this.parentElement.innerHTML='<span>No Cover</span>'" />`;
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
  document.getElementById("bookFormat").value = "";
  setCover(""); closePicker();
  fetchStatus.textContent = "";
  pendingBookDesc = "";
  closeSearchResults();
  syncGenreSelect("");
}

// ── Save Book ──
document.getElementById("saveBook").addEventListener("click", async () => {
  if (!booksCol) { alert(t("Please sign in first.")); return; }
  const title = document.getElementById("bookTitle").value.trim();
  if (!title) { alert(t("Title is required.")); return; }

  const isEdit   = currentDetailId && addModal.dataset.mode === "edit";
  const existing = isEdit ? allBooks.find(b => b.id === currentDetailId) : null;

  const startDate = document.getElementById("bookStartDate").value;
  const book = {
    title,
    author:      document.getElementById("bookAuthor").value.trim(),
    genre:       document.getElementById("bookGenre").value.trim(),
    totalPages:  parseInt(document.getElementById("bookTotalPages").value) || 0,
    currentPage: parseInt(document.getElementById("bookCurrentPage").value) || 0,
    status:      document.getElementById("bookStatus").value,
    format:      document.getElementById("bookFormat").value || "",
    cover:       document.getElementById("coverUrl").value.trim(),
    startDate,
    finishDate:  document.getElementById("bookFinishDate").value,
    notes:       document.getElementById("bookNotes").value.trim(),
    // 年份只跟「開始讀日期」走;編輯時沒填日期 → 保留原年份，不要被刷成今年
    startYear:   startDate ? new Date(startDate).getFullYear()
                          : (existing?.startYear ?? new Date().getFullYear()),
    userId:      currentUser?.uid || null,
  };
  // 有打上進度(頁數)→ 自動視為「正在閱讀」:只升級「還沒開始」的狀態(Want to Read / TBR),
  // 不覆蓋使用者明確選的 Finished / DNF / Now Reading;滿頁則視為已讀完
  if (book.currentPage > 0 && (book.status === "Want to Read" || book.status === "TBR")) {
    book.status = (book.totalPages > 0 && book.currentPage >= book.totalPages) ? "Finished" : "Now Reading";
  }
  // createdAt(加入時間)只在「新增」蓋章;編輯不動它，否則加入日期會被刷成現在
  if (!isEdit) book.createdAt = firebase.firestore.FieldValue.serverTimestamp();

  try {
    const statusChanged = !existing || existing.status !== book.status;
    book.catalogKey = await upsertCatalog(book, pendingBookDesc);   // 同步進共享書庫，並記下指向 catalog 的鑰匙
    pendingBookDesc = "";
    if (isEdit) {
      await booksCol.doc(currentDetailId).update({ ...book });
    } else {
      const ref = await booksCol.add(book);
      // 新增書:背景補 popularity(+缺封面也補)→ 相容度算得準。失敗回 -1 不擋流程
      queueCoverFetch([{ id: ref.id, title: book.title, author: book.author, cover: book.cover, popularity: null }], true);
    }
    // 動態事件(依隱私旗標)
    if (statusChanged) {
      const ctx = { key: book.catalogKey, title: book.title, cover: book.cover };
      if (book.status === "Finished" && myProfile.shelfPublic)      logActivity("finished", ctx);
      else if (book.status === "Now Reading" && myProfile.showReading) logActivity("now_reading", ctx);
    }
    closeAddModal();
    // 編輯表單把書改成「完成」也邀請評分(已評過的書靠 maybePromptFinishReview 的 snap.exists 守門)
    if (isEdit && book.status === "Finished" && statusChanged) maybePromptFinishReview(currentDetailId);
  } catch (e) {
    alert("Save failed: " + e.message);
  }
});

// ══════════════════════════════════════════
//  DETAIL MODAL
// ══════════════════════════════════════════

// ── 簡介:渲染(折疊 + 顯示更多;wiki 來源附出處連結)──
function renderDescription(text, srcUrl) {
  const card = document.getElementById("detailDescCard");
  const p    = document.getElementById("detailDesc");
  const btn  = document.getElementById("descMoreBtn");
  const src  = document.getElementById("descSrc");
  const txt  = (text || "").trim();
  card.style.display = txt ? "" : "none";
  p.classList.remove("expanded");
  p.textContent = txt;
  btn.textContent = t("Read more");
  btn.style.display = "none";
  if (src) {
    src.style.display = txt && srcUrl ? "" : "none";
    src.href = srcUrl || "#";
    src.textContent = t("Source: Wikipedia (CC BY-SA)");
  }
  if (!txt) return;
  // 等版面排好才量得到高度 → 折疊後有溢出才需要「顯示更多」鈕
  requestAnimationFrame(() => {
    if (p.scrollHeight > p.clientHeight + 2) btn.style.display = "";
  });
}

document.getElementById("descMoreBtn").addEventListener("click", () => {
  const p   = document.getElementById("detailDesc");
  const btn = document.getElementById("descMoreBtn");
  const open = p.classList.toggle("expanded");
  btn.textContent = open ? t("Show less") : t("Read more");
});

// ── 簡介:Google Books 沒料時的第二資料源 → 中文維基百科(中文書常只有 wiki 有簡介)
//   一次請求同時做「搜尋 + 取首段摘要」,再用基底書名比對挑對條目:
//   排除作者頁、電影/電視/遊戲等改編作品條目,避免抓到同名不同物
async function fetchWikiDesc(title, author) {
  try {
    const auth = (author || "").split(",")[0].trim();
    const q = encodeURIComponent(title + (auth ? " " + auth : ""));
    const url = `https://zh.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrlimit=5&prop=extracts&exintro=1&explaintext=1&exlimit=max&variant=zh-tw&format=json&origin=*`;
    const data  = await (await fetch(url)).json();
    const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 99) - (b.index || 99));
    const norm  = s => (s || "").replace(/\s+/g, "").toLowerCase();
    const bookT = norm(title);
    for (const pg of pages) {
      const base   = norm(pg.title.replace(/\s*\(([^)]*)\)\s*$/, ""));
      const suffix = (pg.title.match(/\(([^)]*)\)\s*$/) || [])[1] || "";
      if (!base || norm(pg.title) === norm(auth)) continue;                       // 作者本人的條目
      if (!(bookT.includes(base) || base.includes(bookT))) continue;             // 書名對不上(含副標情況)
      if (/電影|电影|電視|电视|遊戲|游戏|動畫|动画|專輯|专辑|歌曲|樂團|乐团/.test(suffix)) continue; // 改編/同名作品
      const ex = cleanDesc(pg.extract || "");
      if (ex) return { text: ex, url: "https://zh.wikipedia.org/wiki/" + encodeURIComponent(pg.title) };
    }
  } catch {}
  return null;
}

// ── 簡介:載入。優先用手上資料 → 讀 catalog → Google Books → 中文維基,查到就寫回 catalog 快取
//   (第一個點開的人觸發補抓,之後全站直接讀;與封面/catalog 自我修復同套路)
let descReqKey = null;   // 防止快速連點兩本書時,慢的那筆回來蓋掉新的
async function loadDescription(key, title, author, preset, presetUrl) {
  descReqKey = key;
  if (preset && preset.trim()) { renderDescription(preset, presetUrl); return; }
  renderDescription("");
  let desc = "", srcUrl = "";
  try {
    const snap = await db.collection("catalog").doc(key).get();
    if (snap.exists) {
      desc   = cleanDesc(snap.data().description || "");
      srcUrl = desc ? (snap.data().descUrl || "") : "";
    }
  } catch {}
  if (!desc && title) {
    try {
      const q   = encodeURIComponent(`intitle:"${title}"` + (author ? ` inauthor:"${author.split(",")[0].trim()}"` : ""));
      const res  = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&key=${GBOOKS_KEY}`);
      const data = await res.json();
      desc = cleanDesc(data.items?.[0]?.volumeInfo?.description || "");
    } catch {}
    if (!desc) {
      const wiki = await fetchWikiDesc(title, author);
      if (wiki) { desc = wiki.text; srcUrl = wiki.url; }
    }
    if (desc && currentUser) {
      const patch = { description: desc };
      if (srcUrl) { patch.descSource = "wikipedia"; patch.descUrl = srcUrl; }
      db.collection("catalog").doc(key).set(patch, { merge: true }).catch(() => {});
    }
  }
  if (descReqKey === key) renderDescription(desc, srcUrl);
}

// ── 手機版分頁籤:評論 / 讀書會 切換(桌面雙欄並排,籤列隱藏)──
function setSocialTab(showClub) {
  document.querySelector("#detailModal .modal-detail").classList.toggle("disc-open", showClub);
  document.getElementById("tabReviews").classList.toggle("active", !showClub);
  document.getElementById("tabClub").classList.toggle("active", showClub);
}
document.getElementById("tabReviews").addEventListener("click", () => setSocialTab(false));
document.getElementById("tabClub").addEventListener("click", () => setSocialTab(true));

function openDetail(id) {
  currentDetailId = id;
  const b = allBooks.find(x => x.id === id);
  if (!b) return;

  // 書架模式:還原私人書架專屬區塊、隱藏「加入書架」鈕
  detailMode = "shelf";
  activeCatalogKey = b.catalogKey || catalogKeyFor(b.title, b.author);
  document.querySelectorAll(".detail-shelf-only").forEach(el => el.style.display = "");
  updateHideToggleUI(b.hidden);   // 反映這本書目前是否對別人隱藏
  const addShelfBtn = document.getElementById("addToShelfBtn");
  if (addShelfBtn) addShelfBtn.style.display = "none";
  document.getElementById("detailCover").style.display = "";

  document.getElementById("detailTitle").textContent  = b.title;
  document.getElementById("detailAuthor").textContent = b.author || "";
  document.getElementById("detailGenre").textContent  = genreLabel(b.genre);

  const statusEl = document.getElementById("detailStatus");
  statusEl.innerHTML = `<span class="status-badge status-${escHtml(b.status)}">${escHtml(t(b.status))}</span>`;

  const fmtEl = document.getElementById("detailFormat");
  if (fmtEl) {
    if (b.format) { fmtEl.textContent = `📚 ${t(b.format)}`; fmtEl.style.display = ""; }
    else fmtEl.style.display = "none";
  }

  const pct = bookPct(b);
  const byPct = b.progressPct != null && b.progressPct !== "";   // 這本是用 % 追蹤?
  document.getElementById("detailProgressBar").style.width  = pct !== null ? pct + "%" : "0%";
  document.getElementById("detailProgressText").textContent = pct === null ? t("No page info")
    : byPct ? `${pct}%`
    : `${b.currentPage || 0} / ${b.totalPages} pages (${pct}%)`;

  // 進度編輯:依「頁數 / %」模式切換輸入框
  const mode = byPct || !b.totalPages ? "pct" : "page";   // 沒頁數(電子書)預設用 %
  document.getElementById("progressMode").value              = mode;
  document.getElementById("detailCurrentPage").value         = b.currentPage || 0;
  document.getElementById("detailTotalPages").textContent    = `/ ${b.totalPages || "?"} pages`;
  document.getElementById("detailProgressPct").value         = byPct ? pct : (pct ?? 0);
  setProgressMode(mode);

  const coverEl = document.getElementById("detailCover");
  if (b.cover) {
    const hi = hiCover(b.cover), lo = tidyCover(b.cover);
    let triedLo = (hi === lo);
    coverEl.onerror = () => {
      if (!triedLo) { triedLo = true; coverEl.src = lo; return; }   // 高解析沒有 → 退回原版
      coverEl.src = ""; coverEl.style.display = "none";
    };
    coverEl.src = hi;
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
  setSocialTab(false);
  loadDescription(activeCatalogKey, b.title, b.author, "");
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
  const reviewPct = bookPct(b) ?? 0;
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
// 公開書架主人(看別人書時才有值)→ 三評分面板的「他的評分」來源
let publicShelfOwner = { uid: null, name: "", rating: null };

// 三評分並列:他的自評(看別人書架時)/ 我的評分 / 平均分。資料優先用 catalog reviews,缺則回退書架自評。
function renderTripleRating(reviews, avg, count) {
  const el = document.getElementById("tripleRating");
  if (!el) return;
  const star = v => (v > 0 ? `★ ${Number(v).toFixed(1)}` : "—");
  // 我的評分:我的 review,否則我書架上同一本的自評
  let myRating = 0;
  const myReview = currentUser && reviews.find(r => r.uid === currentUser.uid || r.id === currentUser.uid);
  if (myReview && myReview.rating > 0) myRating = myReview.rating;
  else { const mb = allBooks.find(b => (b.catalogKey || catalogKeyFor(b.title, b.author)) === activeCatalogKey); if (mb && mb.rating > 0) myRating = mb.rating; }
  // 他的評分:只在「正在看別人公開書架」時顯示
  let ownerRating = null, ownerName = "";
  if (detailMode === "catalog" && viewingPublicUid && publicShelfOwner.uid === viewingPublicUid) {
    ownerName = publicShelfOwner.name || t("them");
    const oRev = reviews.find(r => r.uid === viewingPublicUid);
    ownerRating = (oRev && oRev.rating > 0) ? oRev.rating : (publicShelfOwner.rating || 0);
  }
  const cell = (label, val, cls) => `<div class="tr-cell ${cls||""}"><div class="tr-label">${escHtml(label)}</div><div class="tr-val">${val}</div></div>`;
  let html = "";
  if (ownerRating !== null) html += cell(ownerName, star(ownerRating), "tr-owner");
  html += cell(t("You"), star(myRating), "tr-me");
  html += cell(t("Average"), avg > 0 ? `${star(avg)} <span class="tr-count">(${count||0})</span>` : "—", "tr-avg");
  el.innerHTML = html;
  // 完全無資料就不顯示
  el.style.display = (ownerRating || myRating || avg > 0) ? "flex" : "none";
}

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

  function eventClientX(e) {
    if (e.touches && e.touches[0]) return e.touches[0].clientX;
    if (e.changedTouches && e.changedTouches[0]) return e.changedTouches[0].clientX;
    return e.clientX;
  }
  function ratingFromEvent(e) {
    const rect      = picker.getBoundingClientRect();
    const x         = Math.max(0, eventClientX(e) - rect.left);
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
  // 觸控:手指拖過星星即時設定評分;preventDefault 擋住彈窗/頁面跟著捲動(手機「拖不動」的主因)
  const onStarTouch = e => {
    e.preventDefault();
    selectedRating = ratingFromEvent(e);
    renderStars(selectedRating);
    updateStarLabel(selectedRating, true);
  };
  picker.addEventListener("touchstart", onStarTouch, { passive: false });
  picker.addEventListener("touchmove",  onStarTouch, { passive: false });
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
  if (!rating) { el.textContent = t("Select rating"); el.style.color = "#8A8270"; return; }
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
  let isNew = false;
  await db.runTransaction(async tx => {
    const catSnap = await tx.get(catRef);
    const revSnap = await tx.get(revRef);
    isNew = !revSnap.exists;
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
  return { isNew };
}

// 刪除自己的公開評論，並用交易回扣平均分
async function removeReviewFromCatalog(catalogKey, uid) {
  const catRef = db.collection("catalog").doc(catalogKey);
  const revRef = catRef.collection("reviews").doc(uid);
  let removed = false;
  await db.runTransaction(async tx => {
    const revSnap = await tx.get(revRef);
    const catSnap = await tx.get(catRef);
    if (!revSnap.exists) return;
    removed = true;
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
  // 刪評論 → reviewCount -1(本人寫自己)
  if (removed) db.collection("users").doc(uid)
    .update({ reviewCount: firebase.firestore.FieldValue.increment(-1) }).catch(() => {});
  return { removed };
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

  // 評論區置頂規則:有自己的評論→表單隱藏(自己的卡會在列表最上面);沒寫過且已登入→表單置頂引導填寫
  const myUid = currentUser && currentUser.uid;
  const hasOwnReview = !!(myUid && reviews.some(r => r.uid === myUid || r.id === myUid));
  const writeReviewBox = document.querySelector(".write-review");
  if (writeReviewBox) writeReviewBox.style.display = hasOwnReview ? "none" : "";

  // 沒人評論時藏掉「平均分/星等/長條」彙總列,讓「✍️ 寫評論」表單成為最上面那一欄
  const reviewsAggregate = document.getElementById("reviewsAggregate");
  const showAggregate = show => {
    if (reviewsAggregate) reviewsAggregate.style.display = show ? "" : "none";
    if (ratingBars)       ratingBars.style.display       = show ? "" : "none";
  };

  if (!reviews.length) {
    showAggregate(false);
    reviewsList.innerHTML = `<div class="reviews-empty">${t("📝 No reviews yet — be the first!")}</div>`;
    renderTripleRating([], 0, 0);
    return;
  }
  showAggregate(true);

  // 自己的評論置頂(一眼看到自己評過沒);其餘維持原本 createdAt 倒序。slice 不動原陣列
  if (myUid) {
    const own = r => (r.uid === myUid || r.id === myUid) ? 1 : 0;
    reviews = reviews.slice().sort((a, b) => own(b) - own(a));
  }

  const withRating = reviews.filter(r => r.rating > 0);
  const avg = withRating.length ? withRating.reduce((s,r) => s+r.rating, 0) / withRating.length : 0;
  aggScore.textContent = avg.toFixed(1);
  aggStars.innerHTML   = starsHTML(avg);
  aggCount.textContent = t(reviews.length === 1 ? "{n} review" : "{n} reviews", { n: reviews.length });
  renderTripleRating(reviews, avg, withRating.length);

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
    return `<div class="review-card${isOwn ? " review-card-own" : ""}">
      <div class="review-top">
        <div class="reviewer-avatar">${escHtml(initials)}</div>
        <div class="reviewer-name clickable" data-uid="${escHtml(r.uid || r.id || "")}">${escHtml(nameTag(r.reviewerName || "Anonymous", r.tag))}</div>
        ${isOwn ? `<span class="review-own-tag">${t("Your review")}</span>` : ""}
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
    const { isNew } = await applyReviewToCatalog(catalogKey, currentUser.uid, {
      uid:          currentUser.uid,
      reviewerName: name,
      tag:          myTag(),
      rating:       selectedRating,
      text,
      readPercent:  Number.isFinite(pct) ? pct : null,
      photoURL:     myPhoto(),
      createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:    firebase.firestore.FieldValue.serverTimestamp(),
    });
    // 新評論 → 自己 profile 的 reviewCount +1(本人寫自己,規則本就允許;discovery 排序即時反映)
    if (isNew) db.collection("users").doc(currentUser.uid)
      .update({ reviewCount: firebase.firestore.FieldValue.increment(1) }).catch(() => {});
    // 同步把評分寫到自己書架的該本書 → 相容度②(評分一致)即時吃得到真實評分
    const myBook = allBooks.find(b => (b.catalogKey || catalogKeyFor(b.title, b.author)) === catalogKey);
    if (myBook && booksCol) booksCol.doc(myBook.id).update({ rating: selectedRating }).catch(() => {});
    logActivity("review",
      { key: catalogKey, title: document.getElementById("detailTitle").textContent, cover: document.getElementById("detailCover").src },
      { rating: selectedRating, text });
    document.getElementById("reviewText").value = "";
    selectedRating = 0; renderStars(0); updateStarLabel(0, true);
  } catch(e) { alert(t("Failed") + ": " + e.message); }
  btn.disabled = false; btn.textContent = t("Submit Review");
});

// ── 讀完一本書 → 邀請評分+評論(鼓勵發表內容)──
let finishStarRating = 0;
let finishReviewCtx  = null;

function buildFinishStars() {
  const picker = document.getElementById("finishStarInput");
  const label  = document.getElementById("finishStarLabel");
  picker.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const unit = document.createElement("span");
    unit.className    = "star-unit";
    unit.dataset.star = i;
    unit.innerHTML    = `<span class="star-bg">★</span><span class="star-fg">★</span>`;
    picker.appendChild(unit);
  }
  // 與主評論框同一套 0.25 粒度演算法(滑鼠位置→四分之一顆)
  const ratingFromEvent = e => {
    const rect      = picker.getBoundingClientRect();
    const cx        = (e.touches && e.touches[0]) ? e.touches[0].clientX
                    : (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX
                    : e.clientX;
    const x         = Math.max(0, cx - rect.left);
    const starWidth = rect.width / 5;
    const starIdx   = Math.min(4, Math.floor(x / starWidth));
    const fraction  = (x - starIdx * starWidth) / starWidth;
    const quarter   = Math.ceil(fraction / 0.25) * 0.25 || 0.25;
    return Math.min(5, +(starIdx + quarter).toFixed(2));
  };
  const paint = rating => {
    picker.querySelectorAll(".star-unit").forEach((unit, i) => {
      const fg = unit.querySelector(".star-fg");
      const diff = rating - i;
      fg.style.width = diff >= 1 ? "100%" : diff > 0 ? (diff * 100).toFixed(0) + "%" : "0%";
    });
  };
  const showLabel = rating => { label.textContent = rating ? (rating + " ★") : t("Tap to rate"); };
  picker.onmousemove  = e => { const r = ratingFromEvent(e); paint(r); showLabel(r); };
  picker.onmouseleave = () => { paint(finishStarRating); showLabel(finishStarRating); };
  picker.onclick      = e => { finishStarRating = ratingFromEvent(e); paint(finishStarRating); showLabel(finishStarRating); };
  // 觸控拖曳:手指拖過星星即時設定;preventDefault 擋彈窗捲動。
  // 去重(buildFinishStars 每次開彈窗會重跑)→ 先移除上一輪的 listener 再加,避免累積。
  if (picker._onTouch) {
    picker.removeEventListener("touchstart", picker._onTouch);
    picker.removeEventListener("touchmove",  picker._onTouch);
  }
  const onTouch = e => { e.preventDefault(); finishStarRating = ratingFromEvent(e); paint(finishStarRating); showLabel(finishStarRating); };
  picker._onTouch = onTouch;
  picker.addEventListener("touchstart", onTouch, { passive: false });
  picker.addEventListener("touchmove",  onTouch, { passive: false });
  // 畫出呼叫端先設好的 finishStarRating(新書=0;已評過=預填原星等),不要永遠歸零
  paint(finishStarRating);
  showLabel(finishStarRating);
}

// 標記讀完後呼叫:一律跳出評分窗讓使用者在原地評分(不必滑到下面)。
// 已評過的書 → 預先填入原本的星等+評語,讓他直接確認或調整(不再「已評過就不跳」)。
async function maybePromptFinishReview(bookId) {
  if (!currentUser) return;
  const b = allBooks.find(x => x.id === bookId);
  if (!b) return;
  const key = b.catalogKey || catalogKeyFor(b.title, b.author);   // 與 openDetail 同一把鑰匙
  if (!key) return;
  let existing = null;
  try {
    const snap = await db.collection("catalog").doc(key).collection("reviews").doc(currentUser.uid).get();
    if (snap.exists) existing = snap.data();
  } catch (e) { /* 查不到就當沒評過、空白邀請 */ }
  finishReviewCtx = { key, title: b.title, cover: b.cover };
  finishStarRating = (existing && existing.rating) || 0;          // 已評過 → 預填原星等
  buildFinishStars();                                            // 會依 finishStarRating 畫好星星+標籤
  document.getElementById("finishReviewText").value = (existing && existing.text) || "";
  document.getElementById("finishReviewBookTitle").textContent = t("How was {title}?", { title: b.title });
  document.getElementById("finishReviewModal").classList.add("open");
}

(function setupFinishReview() {
  const modal = document.getElementById("finishReviewModal");
  if (!modal) return;
  const close = () => modal.classList.remove("open");
  document.getElementById("finishReviewClose").addEventListener("click", close);
  document.getElementById("finishReviewSkip").addEventListener("click", close);
  modal.addEventListener("click", e => { if (e.target.id === "finishReviewModal") close(); });
  document.getElementById("finishReviewSubmit").addEventListener("click", async () => {
    if (!currentUser || !finishReviewCtx) return;
    if (!finishStarRating) {
      document.getElementById("finishStarLabel").textContent = t("Please tap a star to rate");
      return;
    }
    const btn = document.getElementById("finishReviewSubmit");
    btn.disabled = true; btn.textContent = t("Submitting...");
    try {
      await applyReviewToCatalog(finishReviewCtx.key, currentUser.uid, {
        uid:          currentUser.uid,
        reviewerName: (currentUser.displayName || (myProfile && myProfile.displayName) || "Reader"),
        tag:          myTag(),
        photoURL:     myPhoto(),
        rating:       finishStarRating,
        text:         document.getElementById("finishReviewText").value.trim(),
        readPercent:  100,
      });
      logActivity("review", finishReviewCtx, { rating: finishStarRating });
      close();
    } catch (e) {
      alert(t("Failed") + ": " + e.message);
    } finally {
      btn.disabled = false; btn.textContent = t("Post review");
    }
  });
})();

// 切換「頁數 / %」進度輸入框的顯示
function setProgressMode(mode) {
  const isPct = mode === "pct";
  document.getElementById("detailCurrentPage").style.display = isPct ? "none" : "";
  document.getElementById("detailTotalPages").style.display  = isPct ? "none" : "";
  document.getElementById("detailProgressPct").style.display = isPct ? "" : "none";
  document.getElementById("detailPctSign").style.display     = isPct ? "" : "none";
}
document.getElementById("progressMode").addEventListener("change", e => setProgressMode(e.target.value));

document.getElementById("updatePageBtn").addEventListener("click", async () => {
  if (!currentDetailId || !booksCol) return;
  const b = allBooks.find(x => x.id === currentDetailId);
  const mode = document.getElementById("progressMode").value;
  const updates = {};
  if (mode === "pct") {
    // 用 % 追蹤(電子書/無固定頁數):存獨立 progressPct
    let pct = parseInt(document.getElementById("detailProgressPct").value) || 0;
    pct = Math.max(0, Math.min(100, pct));
    updates.progressPct = pct;
    if (pct >= 100) updates.status = "Finished";
    else if (pct > 0 && b && b.status !== "Now Reading") updates.status = "Now Reading";   // 有進度=正在閱讀
  } else {
    // 用頁數:存 currentPage,並清掉 progressPct(回到頁數推算)
    const newPage = parseInt(document.getElementById("detailCurrentPage").value) || 0;
    updates.currentPage = newPage;
    updates.progressPct = null;
    if (b && b.totalPages && newPage >= b.totalPages) updates.status = "Finished";
    else if (newPage > 0 && b && b.status !== "Now Reading") updates.status = "Now Reading";   // 有進度=正在閱讀
  }
  // 用頁數/% 把書讀到完(手機最常走這條),也要邀請評分——只在「剛從未完成→完成」時觸發
  const finishedNow = updates.status === "Finished" && (!b || b.status !== "Finished");
  const fid = currentDetailId;
  await booksCol.doc(currentDetailId).update(updates);
  openDetail(currentDetailId);
  if (finishedNow) maybePromptFinishReview(fid);
});

// 進度輸入框按 Enter = 按下「更新」鈕
["detailCurrentPage", "detailProgressPct"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("updatePageBtn").click(); }
  });
});

// 一鍵「已完成」:不必填到 100%,直接標讀完(會議結論)
document.getElementById("markDoneBtn").addEventListener("click", async () => {
  if (!currentDetailId || !booksCol) return;
  const b = allBooks.find(x => x.id === currentDetailId);
  const updates = { status: "Finished" };
  if (b && b.totalPages > 0) { updates.currentPage = b.totalPages; updates.progressPct = null; }
  else { updates.progressPct = 100; }
  const finishedId = currentDetailId;
  await booksCol.doc(currentDetailId).update(updates);
  openDetail(currentDetailId);
  maybePromptFinishReview(finishedId);   // 讀完→邀請評分+評論
});

document.getElementById("editBookBtn").addEventListener("click", () => {
  const b = allBooks.find(x => x.id === currentDetailId);
  if (!b) return;
  detailModal.classList.remove("open");
  addModal.dataset.mode = "edit";
  openAddModal({ title: b.title, author: b.author, genre: b.genre, totalPages: b.totalPages, cover: b.cover });
  document.getElementById("bookCurrentPage").value = b.currentPage || 0;
  document.getElementById("bookStatus").value       = b.status || "Want to Read";
  document.getElementById("bookFormat").value       = b.format || "";
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

// 個別書籍「隱藏」:即便整個書架公開,也能單獨把某本書藏起來不給別人看
function updateHideToggleUI(hidden) {
  const btn = document.getElementById("toggleHideBtn");
  if (!btn) return;
  btn.classList.toggle("is-hidden", !!hidden);
  const lbl = btn.querySelector(".hide-label");
  if (lbl) lbl.textContent = hidden ? t("Hidden") : t("Visible");
  btn.title = hidden ? t("Hidden from others — click to show")
                     : t("Others can see this book — click to hide");
}

document.getElementById("toggleHideBtn").addEventListener("click", async () => {
  if (!currentDetailId || !booksCol) return;
  const b = allBooks.find(x => x.id === currentDetailId);
  const newHidden = !(b && b.hidden);
  updateHideToggleUI(newHidden);     // 先即時反映,體感順
  try {
    await booksCol.doc(currentDetailId).update({ hidden: newHidden });
  } catch (e) {
    updateHideToggleUI(!newHidden);  // 失敗還原
    alert(t("Failed") + ": " + e.message);
  }
});

// ══════════════════════════════════════════
//  IMPORT MODAL
// ══════════════════════════════════════════

const importModal     = document.getElementById("importModal");
const importFileInput = document.getElementById("importFileInput");
const importDropZone  = document.getElementById("importDropZone");
const startImportBtn  = document.getElementById("startImportBtn");
let parsedBooks = [];
// 匯入生命週期狀態機：idle → writing(逐本寫入) → awaitingDone(寫完待按Done) → updating(抓封面中) → idle
let importPhase    = "idle";
let importedIds    = [];      // 本次匯入寫進去的 doc id，供「中途跳出→回滾」用
let importCancelled = false;  // 通知寫入迴圈中止

document.getElementById("openImportModal").addEventListener("click", () => {
  resetImport(); importPhase = "idle"; importedIds = []; importCancelled = false;
  importModal.classList.add("open");
});
document.getElementById("closeImportModal").addEventListener("click", closeImport);
document.getElementById("cancelImport").addEventListener("click", closeImport);
importModal.addEventListener("click", e => { if (e.target === importModal) closeImport(); });

// 中途跳出守門：寫入中 / 待按Done 時，用 X、取消、點背景關閉 → 先確認，確定就回滾清掉這次匯入的書
async function closeImport() {
  if (importPhase === "writing" || importPhase === "awaitingDone") {
    if (!confirm(t("Import isn't finished — covers haven't been updated yet. Leaving now will remove the books you just imported. Exit anyway?"))) return;
    if (importPhase === "writing") importCancelled = true;   // 迴圈會自行回滾
    else await rollbackImport();                              // 已寫完，這裡直接回滾
  }
  importModal.classList.remove("open");
  resetImport();
}

// 回滾：刪掉本次匯入新增的書
async function rollbackImport() {
  const ids = importedIds.slice();
  importedIds = []; importPhase = "idle"; importCancelled = false;
  if (!ids.length || !booksCol) return;
  toast.classList.add("visible");
  toastFill.style.width = "100%";
  toastLabel.textContent = t("Cancelling import — removing {n} books...", { n: ids.length });
  for (const id of ids) { try { await booksCol.doc(id).delete(); } catch {} }
  toastLabel.textContent = t("Import cancelled. {n} books removed.", { n: ids.length });
  setTimeout(() => toast.classList.remove("visible"), 3000);
}

// 離開頁面前，若匯入流程還沒結束，觸發瀏覽器原生「確定離開?」提示
window.addEventListener("beforeunload", e => {
  if (importPhase !== "idle") { e.preventDefault(); e.returnValue = ""; }
});

function resetImport() {
  parsedBooks = [];
  importFileInput.value = "";
  document.getElementById("importPreview").style.display  = "none";
  document.getElementById("importProgress").style.display = "none";
  document.getElementById("importDropZone").style.display = "";
  importDropZone.innerHTML = `<div class="upload-icon">📂</div><div class="upload-text">${t("Drag & drop your CSV file here")}<br/><span>${t("or click to browse")}</span></div><input type="file" id="importFileInput" accept=".csv,.txt" style="display:none" />`;
  bindFileInput();
  startImportBtn.disabled  = true;
  startImportBtn.textContent = t("Import Books");
  startImportBtn.onclick = null;   // 清掉 Done 的臨時 handler，還原成預設匯入流程
  // 網頁匯入面板歸零 + 依目前分頁恢復顯示狀態
  const wu = document.getElementById("webImportUrl"), wt = document.getElementById("webImportText"), ws = document.getElementById("webImportStatus");
  if (wu) wu.value = ""; if (wt) wt.value = ""; if (ws) ws.textContent = "";
  updateImportTabUI();
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
  if (!file || !/\.(csv|txt)$/i.test(file.name)) { alert(t("Please upload a .csv or .txt file.")); return; }
  const reader = new FileReader();
  reader.onload = e => parseAnyCSV(e.target.result, file.name);
  reader.readAsText(file, "UTF-8");
}

// ── 來源嗅探:看標題列特徵自動分流(Goodreads 一定有 Book Id + Exclusive Shelf;
//    其他一律走通用解析器——Notion 匯出是它的子集,選錯分頁也能正確匯入)──
function parseAnyCSV(text, filename) {
  const head = (text.split(/\r?\n/, 1)[0] || "").toLowerCase();
  if (head.includes("exclusive shelf") && head.includes("book id")) parseGoodreadsCSV(text, filename);
  else parseFlexibleCSV(text, filename);
}

// ── 整檔逐字元解析(欄位可含換行的引號內容,逐行切會壞;delim 支援逗號/Tab)──
function parseCSVAll(text, delim = ",") {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    }
    else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = "";
      if (row.length > 1 || (row[0] && row[0].trim())) rows.push(row);
      row = [];
    }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿]/;
function parseGoodreadsCSV(text, filename) {
  const rows = parseCSVAll(text);
  if (rows.length < 2) { alert("CSV appears empty."); return; }
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const idx = n => headers.indexOf(n);
  const I = { title: idx("title"), author: idx("author"), addl: idx("additional authors"),
              rating: idx("my rating"), publisher: idx("publisher"), pages: idx("number of pages"),
              read: idx("date read"), added: idx("date added"), shelf: idx("exclusive shelf"),
              review: idx("my review") };
  if (I.title === -1 || I.shelf === -1) { alert("Could not recognize this Goodreads CSV."); return; }

  const statusMap = { "to-read": "Want to Read", "currently-reading": "Now Reading", "read": "Finished" };
  parsedBooks = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = i => (i >= 0 && cells[i] != null ? String(cells[i]).trim() : "");

    // 書名:去掉「(系列名, #N)」和「(Traditional Chinese Edition)」尾巴
    const title = get(I.title)
      .replace(/\s*\([^()]*#\d+[^()]*\)\s*$/, "")
      .replace(/\s*\((traditional|simplified) chinese edition\)\s*$/i, "")
      .trim();
    if (!title) continue;

    // 作者:中文書的 Author 欄常是羅馬拼音、中文名藏在 Additional Authors(後面接譯者)。
    // 啟用條件:Author 非中日文 + Additional 有中日文名 + 書名或出版社是中日文(確認是中文版書)。
    // 多筆=第一筆是作者中文名;單筆通常只是譯者,除非 Author 欄本身像拼音(帶變音符/連字號)。
    let author = get(I.author).replace(/\s{2,}/g, " ");
    const cjkAddl = get(I.addl).split(",").map(s => s.trim()).filter(s => CJK_RE.test(s));
    if (!CJK_RE.test(author) && cjkAddl.length &&
        (CJK_RE.test(title) || CJK_RE.test(get(I.publisher))) &&
        (cjkAddl.length >= 2 || /[^\x00-\x7F]|\p{L}+-\p{L}+/u.test(author))) {
      author = cjkAddl[0];
    }

    const status     = statusMap[get(I.shelf)] || "Finished";
    const totalPages = parseInt(get(I.pages)) || 0;
    const finishDate = parseNotionDate(get(I.read));
    const addedDate  = parseNotionDate(get(I.added));
    const stars      = parseInt(get(I.rating)) || 0;
    const notes      = [stars > 0 ? `Rating: ${"★".repeat(stars)}${"☆".repeat(5 - stars)}` : "", get(I.review)]
                         .filter(Boolean).join("\n");

    parsedBooks.push({
      title, author, genre: "",
      status,
      currentPage: status === "Finished" ? totalPages : 0,   // 已讀完=進度滿;閱讀中頁數 GR 沒給,進來再更新
      totalPages,
      finishDate, startDate: "",
      startYear: (finishDate ? new Date(finishDate).getFullYear() : null)
              || (addedDate  ? new Date(addedDate).getFullYear()  : null)
              || new Date().getFullYear(),
      cover: "", notes,
      userId: currentUser?.uid || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
  showPreview(filename);
}

// ── 通用 CSV/TXT 解析器(Notion 匯出是子集;也吃 Goodreads 範例格式、中文標頭、Tab 分隔)──
function parseFlexibleCSV(text, filename) {
  const delim = (text.split(/\r?\n/, 1)[0] || "").includes("\t") ? "\t" : ",";
  const rows  = parseCSVAll(text, delim);
  if (rows.length < 2) { alert("CSV appears empty."); return; }
  const headers = rows[0].map(h => h.trim().toLowerCase());

  const col = name => {
    const aliases = {
      title:       ["title", "書名"],
      author:      ["author", "authors", "作者"],
      genre:       ["genre", "category", "類型", "分類"],
      status:      ["status", "exclusive shelf", "shelves", "shelf", "bookshelves", "狀態"],
      currentpage: ["current page", "currentpage", "current_page", "目前頁數"],
      totalpages:  ["total pages", "totalpages", "total_pages", "number of pages", "pages", "總頁數", "頁數"],
      finishdate:  ["date finished", "finish date", "finishdate", "date_finished", "date read", "完成日期", "讀完日期"],
      startdate:   ["date started", "start date", "startdate", "date_started", "開始日期"],
      rating:      ["rate", "rating", "my rating", "評分"],
      review:      ["my review", "review", "notes", "筆記", "心得"],
    };
    for (const a of (aliases[name] || [name])) { const i = headers.indexOf(a); if (i !== -1) return i; }
    return -1;
  };

  if (col("title") === -1) { alert(t("Could not find a 'Title' column.")); return; }

  parsedBooks = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = name => { const i = col(name); return i >= 0 && cells[i] != null ? String(cells[i]).trim() : ""; };

    const title = cleanNotionCell(get("title"));
    if (!title) continue;

    const finishDate = parseNotionDate(cleanNotionCell(get("finishdate")));
    const startDate  = parseNotionDate(cleanNotionCell(get("startdate")));
    const ratingRaw  = cleanNotionCell(get("rating"));
    const stars      = Math.min(5, (ratingRaw.match(/★/g) || []).length || Math.round(parseFloat(ratingRaw)) || 0);
    const notes      = [stars > 0 ? `Rating: ${"★".repeat(stars)}${"☆".repeat(5 - stars)}` : "", get("review")]
                         .filter(Boolean).join("\n");
    const status     = normalizeShelfStatus(get("status"), !!finishDate || stars > 0);
    const totalPages = parseInt(cleanNotionCell(get("totalpages"))) || 0;
    let currentPage  = parseInt(cleanNotionCell(get("currentpage"))) || 0;
    if (status === "Finished" && !currentPage) currentPage = totalPages;

    parsedBooks.push({
      title,
      author: cleanNotionCell(get("author")),
      genre:  cleanNotionCell(get("genre")),
      status, currentPage, totalPages,
      finishDate, startDate,
      startYear: (startDate ? new Date(startDate).getFullYear() : null)
              || (finishDate ? new Date(finishDate).getFullYear() : null)
              || new Date().getFullYear(),
      cover: "", notes,
      userId:    currentUser?.uid || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
  showPreview(filename);
}

// 狀態正規化:吃各家寫法(中英、Goodreads shelf 清單);認不出來時看「有完成日/評分」推定
function normalizeShelfStatus(raw, looksFinished) {
  const v = (raw || "").toLowerCase();
  if (/currently-reading|now reading|閱讀中|在讀/.test(v)) return "Now Reading";
  if (/to-read|to read|want|wish|想讀|待讀/.test(v)) return "Want to Read";
  if (/\bread\b|finished|done|已讀|讀完|完成/.test(v)) return "Finished";
  if (/\breading\b/.test(v)) return "Now Reading";
  return looksFinished ? "Finished" : "Want to Read";
}

function cleanNotionCell(str) {
  if (!str) return "";
  return str.replace(/\s*\(https?:\/\/[^)]+\)/g, "").trim();
}
function parseNotionDate(str) {
  if (!str) return "";
  const d = new Date(str);
  if (isNaN(d)) return "";
  // 用本地日期組字串;toISOString 是 UTC,在台灣(+8)會把日期倒退一天
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// ── 來源分頁:Goodreads / Notion / 通用 CSV / 網頁 ──
let importSrc = "goodreads";
function updateImportTabUI() {
  document.querySelectorAll("#importTabs .import-tab").forEach(b =>
    b.classList.toggle("active", b.dataset.src === importSrc));
  document.querySelectorAll(".import-src").forEach(p =>
    p.style.display = p.dataset.pane === importSrc ? "" : "none");
  if (importPhase === "idle") {
    const isWeb = importSrc === "web";
    document.getElementById("importDropZone").style.display = isWeb ? "none" : "";
    document.getElementById("importWebPane").style.display  = isWeb ? "" : "none";
  }
}
document.querySelectorAll("#importTabs .import-tab").forEach(b => {
  b.addEventListener("click", () => {
    if (importPhase !== "idle") return;   // 寫入中不准切
    importSrc = b.dataset.src;
    parsedBooks = [];                     // 切來源=重來,清掉已解析的預覽
    document.getElementById("importPreview").style.display = "none";
    startImportBtn.disabled = true;
    updateImportTabUI();
  });
});

// ── 範例 CSV 模板下載(通用分頁;BOM 讓 Excel 正確顯示中文)──
document.getElementById("downloadSampleCsv").addEventListener("click", e => {
  e.preventDefault();
  const sample = [
    "Title,Author,Status,Total Pages,Current Page,Genre,Date Finished,Rating",
    "克拉拉與太陽,石黑一雄,Finished,352,352,Fiction,2026-01-15,4",
    "Project Hail Mary,Andy Weir,Now Reading,476,120,Sci-Fi,,",
    "範例:想讀的書,某作者,Want to Read,,,,,",
  ].join("\r\n");
  const blob = new Blob(["﻿" + sample], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "concento_import_sample.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

// ══ 網頁匯入:貼網址(走 CORS 代理抓頁面)或直接貼內容 → 萃取 ISBN → Google Books 解書 ══
// 比 Goodreads 強的點:登入牆內的頁面(自己的願望清單等)複製內容貼上就能解析,不要求頁面公開。
function validISBN13(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += (+s[i]) * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}
function validISBN10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : +s[i]) * (10 - i);
  return sum % 11 === 0;
}
function isbn10to13(s) {
  const core = "978" + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - sum % 10) % 10);
}
function extractISBNs(text) {
  const out = new Set();
  const re = /97[89][-\s]?(?:\d[-\s]?){9}\d|\b\d{9}[\dXx]\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const clean = m[0].replace(/[^0-9Xx]/g, "").toUpperCase();
    if (clean.length === 13) { if (validISBN13(clean)) out.add(clean); }
    else if (clean.length === 10 && validISBN10(clean)) {
      // ISBN-10 誤判率高(任意 10 位數約 9% 會過檢查碼):附近要有 isbn 字樣或像書店商品網址才收
      const ctx = text.slice(Math.max(0, m.index - 80), m.index + 90).toLowerCase();
      if (/isbn|\/dp\/|\/gp\/product|book/.test(ctx)) out.add(isbn10to13(clean));
    }
  }
  return [...out];
}
async function fetchPageForISBNs(url) {
  const proxies = [   // 純前端抓跨站頁面必經代理;一個掛了換下一個
    u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    u => "https://r.jina.ai/" + u,
  ];
  for (const p of proxies) {
    try {
      const r = await fetch(p(url));
      if (r.ok) { const t = await r.text(); if (t && t.length > 50) return t; }
    } catch {}
  }
  return "";
}
async function runWebImport(rawText) {
  const status = document.getElementById("webImportStatus");
  const isbns  = extractISBNs(rawText).slice(0, 120);   // 安全上限
  if (!isbns.length) { status.textContent = t("No valid ISBNs found on that page."); return; }
  const books = [];
  for (let i = 0; i < isbns.length; i++) {
    status.textContent = t("Looking up {i} / {n}...", { i: i + 1, n: isbns.length });
    try {
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbns[i]}&maxResults=1&key=${GBOOKS_KEY}`);
      const v = (await res.json()).items?.[0]?.volumeInfo;
      if (v && v.title) books.push({
        title: v.title,
        author: (v.authors || []).join(", "),
        genre:  v.categories?.[0] || "",
        status: "Want to Read", currentPage: 0,
        totalPages: v.pageCount || 0,
        finishDate: "", startDate: "",
        startYear: new Date().getFullYear(),
        cover: tidyCover(v.imageLinks?.thumbnail || ""),
        notes: "",
        userId:    currentUser?.uid || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  status.textContent = t("Found {n} ISBNs → resolved {m} books. Review below.", { n: isbns.length, m: books.length });
  if (!books.length) return;
  parsedBooks = books;
  showPreview(t("Web page import"));
}
document.getElementById("webImportFetchBtn").addEventListener("click", async () => {
  const url    = document.getElementById("webImportUrl").value.trim();
  const status = document.getElementById("webImportStatus");
  if (!/^https?:\/\//.test(url)) { status.textContent = t("Please enter a valid http(s) URL."); return; }
  status.textContent = t("Fetching page...");
  const text = await fetchPageForISBNs(url);
  if (!text) { status.textContent = t("Could not fetch that page — paste its content below instead."); return; }
  runWebImport(text);
});
document.getElementById("webImportParseBtn").addEventListener("click", () => {
  const txt = document.getElementById("webImportText").value;
  if (txt.trim()) runWebImport(txt);
});

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
    ${parsedBooks.length > 5 ? `<tr><td colspan="5" style="color:#8A8270;text-align:center">... and ${parsedBooks.length - 5} more</td></tr>` : ""}
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

// withPop=true 時,除了缺封面,也把「缺 popularity」的書排進來(只在新增/匯入呼叫,load 不帶以免每次狂抓)
function queueCoverFetch(books, withPop = false) {
  const items = books
    .filter(b => b.title && (!b.cover || (withPop && b.popularity == null)))
    .map(b => ({ id: b.id, title: b.title, author: b.author || "",
                 needCover: !b.cover, needPop: withPop && b.popularity == null }));
  if (!items.length) return;
  coverFetchQueue.push(...items);
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
    const live = allBooks.find(b => b.id === item.id);
    const updates = {};
    if (item.needCover && !live?.cover) {
      const cover = await fetchCoverUrl(item.title, item.author);
      if (cover) updates.cover = cover;
    }
    if (item.needPop && (live ? live.popularity == null : true)) {
      updates.popularity = await fetchPopularity(item.title, item.author);   // 失敗回 -1(未知),仍寫入避免重抓
    }
    if (Object.keys(updates).length) await booksCol.doc(item.id).update(updates);

    done++;
    const pct = Math.round((done / total) * 100);
    toastFill.style.width  = pct + "%";
    toastLabel.textContent = t("Updating covers (keep this page open)") + ` — ${done}/${total} ${item.title}`;
    await new Promise(r => setTimeout(r, 350));
  }

  toastLabel.textContent = t("✓ Finished updating covers!");
  toastFill.style.width  = "100%";
  setTimeout(() => toast.classList.remove("visible"), 3500);
  coverFetchRunning = false;
  if (importPhase === "updating") importPhase = "idle";   // 更新完成 → 解除離開頁面警告
}

// 全球流行度:OL readinglog 系統性低估暢銷書 → edition_count 知名度地板補。失敗回 -1(rarityWeight 當未知 1.2)。
// 取數:含作者查詢當主力(已被作者約束,常見字書名如 Pond 也能命中真書);
//   ⚠️只有主查詢「退化」(ed≤2 且 rl 低 = 作者文字害匹配失敗,如三體 CJK 作者名)才用純書名救援,
//   避免常見字書名的純書名查詢誤匹配到同名熱門書。
async function olSignals(query) {                                   // 取前5筆 max
  const url = "https://openlibrary.org/search.json?" +
    new URLSearchParams({ q: query, limit: "5", fields: "readinglog_count,edition_count" });
  const docs = (await fetch(url).then(r => r.json())).docs || [];
  return { rl: Math.max(0, ...docs.map(x => x.readinglog_count || 0), 0),
           ed: Math.max(0, ...docs.map(x => x.edition_count   || 0), 0) };
}
const _TITLE_STOP = new Set(["the","a","an","of","and","or","to","in","on","for"]);
function distinctiveTitle(title) {   // 去掉冠詞/介系詞後 ≥2 個實詞(≥3字)= 獨特多字書名
  const toks = (title || "").toLowerCase().normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/)
    .filter(w => w.length >= 3 && !_TITLE_STOP.has(w));
  return toks.length >= 2;
}
async function fetchPopularity(title, author) {
  try {
    let { rl, ed } = await olSignals(`${title} ${author}`.trim());
    // 純書名救援只給「獨特多字書名」(如三體):它的純書名查詢都指向同一本,安全;
    // 單字/常見書名(如 Pond)的純書名查詢會誤匹配同名熱門書 → 不救援,只信含作者查詢。
    if (ed <= 2 && rl < 50 && distinctiveTitle(title)) {
      const alt = await olSignals(title);
      rl = Math.max(rl, alt.rl); ed = Math.max(ed, alt.ed);
    }
    const floor = ed >= 40 ? 9000 : ed >= 20 ? 3000 : ed >= 12 ? 1000 : 0;   // 版本數知名度地板,只墊高
    return Math.max(rl, floor);
  } catch { return -1; }
}

async function fetchCoverUrl(title, author) {
  try {
    const q    = encodeURIComponent(`${title} ${author}`.trim());
    const res  = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&key=${GBOOKS_KEY}`);
    const data = await res.json();
    if (data.items?.[0]?.volumeInfo?.imageLinks) {
      const imgs = data.items[0].volumeInfo.imageLinks;
      return tidyCover(imgs.extraLarge || imgs.large || imgs.thumbnail || "");
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
  if (importPhase !== "idle") return;   // 防重入：寫入中/待Done/抓封面中不再觸發匯入
  if (!parsedBooks.length || !booksCol) return;
  importPhase = "writing"; importedIds = []; importCancelled = false;
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
    if (importCancelled) break;   // 使用者中途確認跳出
    const pct  = Math.round(((i + 1) / parsedBooks.length) * 100);
    fillEl.style.width  = pct + "%";
    labelEl.textContent = t("Importing {i} / {total}...", { i: i + 1, total: parsedBooks.length });
    const book = parsedBooks[i];

    if (existingTitles.has(book.title.trim().toLowerCase())) {
      skipped++;
      const line = document.createElement("div");
      line.style.color  = "#8A8270";
      line.textContent  = `— skipped (duplicate): ${book.title}`;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
      continue;
    }

    try {
      book.catalogKey = await upsertCatalog(book);   // 匯入的書也進共享書庫
      const ref = await booksCol.add(book);
      importedIds.push(ref.id);                       // 記下來，跳出時可回滾
      existingTitles.add(book.title.trim().toLowerCase());
      success++;
      const line = document.createElement("div");
      line.style.color = "#53704D";
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

  if (importCancelled) { await rollbackImport(); return; }   // 寫到一半被取消 → 清掉已寫的

  importPhase = "awaitingDone";
  labelEl.textContent = t("Done! ✓ {ok} imported", { ok: success })
    + (skipped ? t(", {n} skipped", { n: skipped }) : "")
    + (failed ? t(", ✗ {n} failed", { n: failed }) : "") + ".";
  labelEl.style.color = "#53704D";
  startImportBtn.textContent = t("Done");
  startImportBtn.disabled    = false;
  // 按下 Done = 正式完成:保留資料、關閉視窗、開始背景抓封面(此後不再回滾)
  startImportBtn.onclick = () => {
    importPhase = "updating"; importedIds = []; startImportBtn.onclick = null;
    importModal.classList.remove("open");
    resetImport();
    queueCoverFetch(allBooks, true);   // 匯入完:補封面 + 補 popularity(順手回填整庫缺 pop 的書)
  };
});

// ══════════════════════════════════════════
//  PHASE B-3 — 探索頁 / 隱私設定 / 公開書架
// ══════════════════════════════════════════

// ── 頁面切換:我的書架 / 探索 ──
function switchView(view) {
  currentView = view;
  setViewClass(view);
  document.querySelectorAll(".nav-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".shelf-only").forEach(el =>
    el.style.display = view === "shelf" ? "" : "none");
  document.getElementById("sidebar").style.display = view === "shelf" ? "" : "none";
  document.getElementById("shelfView").style.display   = view === "shelf"   ? "" : "none";
  document.getElementById("exploreView").style.display = view === "explore" ? "" : "none";
  document.getElementById("feedView").style.display    = view === "feed"    ? "" : "none";
  if (view === "shelf") refreshLayout();   // 回自己書架:重算欄寬,蓋掉剛才在公開書架縮放留下的 --card-w-fit
  if (view === "explore") {
    viewingPublicUid = null;
    lastPublicShelf = null;
    switchExploreSubtab(exploreSubtab || "people");
  }
  if (view === "feed") loadFeed();
  if (window.__backReconcile) window.__backReconcile();   // 同步「探索/動態層」→ 上一頁回書架
}

// ── 探索子頁:書評人(找人) / 書籍(共享書庫) ──
let exploreSubtab = "people";
let peopleList = [];
let peopleCursor = null, peopleHasMore = false, peopleLoading = false;
const PEOPLE_PAGE = 24;
function setExploreMode(mode) {   // 'people' | 'books' | 'shelf'
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? "" : "none"; };
  show("exploreSubtabBar", mode !== "shelf");
  show("exPeople",  mode === "people");
  show("exBooksBar", mode === "books");
  show("exploreGrid", mode !== "people");
  if (mode !== "shelf") {
    document.getElementById("publicBanner").style.display = "none";   // 整合 header(含相似度)一起藏
  }
}
function switchExploreSubtab(which) {
  exploreSubtab = which;
  document.querySelectorAll("#exploreSubtabBar .feed-subtab").forEach(b =>
    b.classList.toggle("active", b.dataset.esub === which));
  setExploreMode(which);
  if (which === "people") loadPeople();
  else if (exploreBooks && exploreBooks.length) renderExplore();
  else loadExplore();
}
// 載入公開使用者:server 端 where(公開)+orderBy(粉絲數)+limit 分頁,只讀一頁(免撈全庫)。
// 顯示時頁內再以完整人氣分(追蹤+評論*5)次排序,保留「獎勵發言」語意;搜尋只搜已載入頁(規模大需搜尋服務)。
// 探索頁不顯示的帳號(測試/種子);要再藏就往這 Set 加 uid
const DISCOVERY_HIDE = new Set([
  "g4fu6FZzRMNlqSSJk5E2IF7BNaE2",   // DVE(test@test.com)純測試帳號
]);
async function loadPeople(reset = true) {
  const grid = document.getElementById("peopleGrid");
  const se = document.getElementById("peopleSearch"); if (se) se.placeholder = t("Search curators...");
  if (peopleLoading) return;
  peopleLoading = true;
  if (reset) { peopleList = []; peopleCursor = null; peopleHasMore = false;
    grid.innerHTML = `<div class="loading">${t("Loading...")}</div>`; }
  try {
    let q = db.collection("users").where("shelfPublic", "==", true)
              .orderBy("followerCount", "desc").limit(PEOPLE_PAGE);
    if (peopleCursor) q = q.startAfter(peopleCursor);
    const snap = await q.get();
    const me = currentUser ? currentUser.uid : null;
    snap.docs.forEach(d => {
      if (d.id === me || DISCOVERY_HIDE.has(d.id) || peopleList.some(u => u.uid === d.id)) return;
      const u = { uid: d.id, ...d.data() };
      u._score = (u.followerCount || 0) + (u.reviewCount || 0) * 5;
      peopleList.push(u);
    });
    if (snap.docs.length) peopleCursor = snap.docs[snap.docs.length - 1];
    peopleHasMore = snap.docs.length === PEOPLE_PAGE;
    renderPeople();
  } catch (e) {
    grid.innerHTML = `<div class="loading">${t("Failed to load")}: ${escHtml(e.message)}</div>`;
  } finally { peopleLoading = false; }
}
function fmtCount(n) { return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : "" + n; }
function renderPeople() {
  const grid = document.getElementById("peopleGrid");
  const q = (document.getElementById("peopleSearch").value || "").trim().toLowerCase();
  const sorted = [...peopleList].sort((a, b) => b._score - a._score);   // 頁內依完整人氣分排
  let list = q ? sorted.filter(u => (u.displayName || "").toLowerCase().includes(q)) : sorted;
  if (!list.length) {
    grid.innerHTML = `<div class="loading">${t("No curators found")}</div>`;
  } else {
    grid.innerHTML = list.map(u => {
      const initial = (u.displayName || "?").trim().charAt(0).toUpperCase();
      const avatar = u.photoURL
        ? `<img class="pcard-av" src="${escHtml(u.photoURL)}" alt="" loading="lazy" />`
        : `<div class="pcard-av pcard-av-ph">${escHtml(initial)}</div>`;
      const stats = [u.followerCount ? `👥 ${fmtCount(u.followerCount)}` : "",
                     u.reviewCount   ? `💬 ${u.reviewCount}` : ""].filter(Boolean).join("　·　");
      return `<div class="pcard" data-uid="${escHtml(u.uid)}">
        ${avatar}
        <div class="pcard-body">
          <div class="pcard-name">${escHtml(fmtName(u))}</div>
          <div class="pcard-stats">${stats || t("New reader")}</div>
        </div>
        <span class="pcard-go">›</span>
      </div>`;
    }).join("");
    grid.querySelectorAll(".pcard").forEach(c =>
      c.addEventListener("click", () => loadPublicShelf(c.dataset.uid)));
    // 點頭像 → 直接開唯讀個人檔案(不進書架)
    grid.querySelectorAll(".pcard-av").forEach(av =>
      av.addEventListener("click", e => {
        e.stopPropagation();
        const card = av.closest(".pcard");
        const u = card && peopleList.find(x => x.uid === card.dataset.uid);
        if (u) openPublicProfile(u);
      }));
  }
  // 「載入更多」鈕(搜尋中隱藏,因為搜尋只涵蓋已載入頁)
  let more = document.getElementById("peopleMore");
  if (!more) {
    more = document.createElement("button");
    more.id = "peopleMore"; more.className = "people-more";
    more.addEventListener("click", () => loadPeople(false));
    grid.parentNode.appendChild(more);
  }
  more.textContent = peopleLoading ? t("Loading...") : t("Load more");
  more.style.display = (peopleHasMore && !q) ? "" : "none";
}
document.querySelectorAll("#exploreSubtabBar .feed-subtab").forEach(b =>
  b.addEventListener("click", () => switchExploreSubtab(b.dataset.esub)));
(() => { const se = document.getElementById("peopleSearch"); if (se) se.addEventListener("input", renderPeople); })();
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
      ? `<div class="book-cover"><img ${coverAttrs(c.cover)} alt="" loading="lazy" referrerpolicy="no-referrer" onerror="if(window.__coverFallback(this))return; if(window.__retryProxy(this))return; this.parentElement.innerHTML='<div class=no-cover><div class=no-cover-icon>📖</div></div>'" /></div>`
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
  document.getElementById("detailGenre").textContent  = genreLabel(c.genre);
  document.getElementById("detailStatus").innerHTML   = "";
  const coverImg = document.getElementById("detailCover");
  if (c.cover) {
    const hi = hiCover(c.cover), lo = tidyCover(c.cover);
    let triedLo = (hi === lo);
    coverImg.onerror = () => {
      if (!triedLo) { triedLo = true; coverImg.src = lo; return; }   // 高解析沒有 → 退回原版
      coverImg.src = ""; coverImg.style.display = "none";
    };
    coverImg.src = hi;
    coverImg.style.display = "";
  } else {
    coverImg.src = "";
    coverImg.style.display = "none";
  }

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
  setSocialTab(false);
  loadDescription(c.key, c.title || "", c.author || "", c.description || "", c.descUrl || "");
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

// 首本書「書架已公開」一次性提示 modal 的按鈕
(function setupShelfPublicNotice() {
  const m = document.getElementById("shelfPublicNoticeModal");
  if (!m) return;
  const close = () => m.classList.remove("open");
  document.getElementById("shelfNoticeClose").addEventListener("click", close);
  document.getElementById("shelfNoticeOkBtn").addEventListener("click", close);
  document.getElementById("shelfNoticeSettingsBtn").addEventListener("click", () => {
    close();
    document.getElementById("openPrivacyBtn").click();   // 帶他去隱私設定面板
  });
  m.addEventListener("click", e => { if (e.target.id === "shelfPublicNoticeModal") close(); });
})();
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

// ── 個人檔案設定(版本A:右上角點名字進入) ──
(function setupProfileModal() {
  const modal = document.getElementById("profileModal");
  if (!modal) return;
  const $ = id => document.getElementById(id);
  let pickedFav = null;   // 暫存選定的年度最愛 {key,title,cover}

  function open() {
    if (!currentUser) { alert(t("Please sign in first.")); return; }
    const p = myProfile || {};
    renderAvatar(p);
    $("pfDisplayName").value = p.displayName || "";
    $("pfTag").textContent   = p.tag ? "#" + p.tag : "";
    $("pfBio").value     = p.bio || "";
    $("pfDiscord").value = p.discord || "";
    $("pfDiscordPublic").checked = p.discordPublic !== false;   // 預設開(填了就是想被找到)
    pickedFav = p.favBook || null;
    renderFav();
    $("pfFavSearch").value = "";
    $("pfFavResults").innerHTML = "";
    renderLinks();
    hideErr();
    modal.classList.add("open");
  }
  function close() { modal.classList.remove("open"); }

  function renderAvatar(p) {
    const av  = $("pfAvatar");
    const url = (p && p.photoURL) || (currentUser && currentUser.photoURL) || "";
    const nm  = (p && p.displayName) || "R";
    if (url) av.innerHTML = `<img src="${escHtml(url)}" alt="${escHtml(nm)}" />`;
    else { av.innerHTML = ""; av.textContent = nm.slice(0, 2).toUpperCase(); }
  }

  function renderFav() {
    const wrap = $("pfFavPicked");
    if (pickedFav && pickedFav.title) {
      wrap.style.display = "";
      const cov = $("pfFavCover");
      cov.src = pickedFav.cover || "";
      cov.style.display = pickedFav.cover ? "" : "none";
      $("pfFavTitle").textContent = pickedFav.title;
    } else { wrap.style.display = "none"; }
  }

  function renderLinks() {
    const providers = (currentUser && currentUser.providerData) || [];
    const hasGoogle = providers.some(x => x.providerId === "google.com");
    const hasEmail  = providers.some(x => x.providerId === "password");
    const dc = ($("pfDiscord").value || "").trim();
    const row = (label, value, on) =>
      `<div class="pf-link-row"><span class="pf-link-name">${label}</span>`
      + `<span class="pf-link-val ${on ? "is-on" : ""}">${escHtml(value)}</span></div>`;
    $("pfLinks").innerHTML =
        row("Google",  hasGoogle ? (currentUser.email || t("Linked")) : t("Not linked"), hasGoogle)
      + row("Email",   hasEmail  ? (currentUser.email || "")           : t("Not linked"), hasEmail)
      + row("Discord", dc || t("Not linked"), !!dc);
  }

  function showErr(msg) { const e = $("pfError"); e.textContent = msg; e.style.display = ""; }
  function hideErr() { $("pfError").style.display = "none"; }

  // 年度最愛:從自己書架 allBooks 即時搜尋
  $("pfFavSearch").addEventListener("input", () => {
    const q = $("pfFavSearch").value.trim().toLowerCase();
    const box = $("pfFavResults");
    if (!q) { box.innerHTML = ""; return; }
    const hits = allBooks.filter(b =>
      (b.title || "").toLowerCase().includes(q) ||
      (b.author || "").toLowerCase().includes(q)
    ).slice(0, 6);
    box.innerHTML = hits.length ? hits.map(b => {
      const key = b.catalogKey || catalogKeyFor(b.title, b.author);
      return `<button class="pf-fav-hit" data-key="${escHtml(key)}" data-title="${escHtml(b.title || "")}" data-cover="${escHtml(b.cover || "")}">`
        + (b.cover ? `<img src="${escHtml(b.cover)}" alt="" />` : `<span class="pf-fav-noimg">📕</span>`)
        + `<span class="pf-fav-hit-t">${escHtml(b.title || "Untitled")}</span></button>`;
    }).join("") : `<div class="pf-fav-empty">${t("No matches in your shelf.")}</div>`;
  });
  $("pfFavResults").addEventListener("click", e => {
    const btn = e.target.closest(".pf-fav-hit");
    if (!btn) return;
    pickedFav = { key: btn.dataset.key, title: btn.dataset.title, cover: btn.dataset.cover || "" };
    renderFav();
    $("pfFavSearch").value = "";
    $("pfFavResults").innerHTML = "";
  });
  $("pfFavClear").addEventListener("click", () => { pickedFav = null; renderFav(); });

  // Discord 欄位即時反映到「已連結帳號」摘要
  $("pfDiscord").addEventListener("input", renderLinks);

  // 頭像:瀏覽器端壓成 ~128px 小圖,base64 存進 profile(免 Storage / 免 Blaze;Google 使用者也能換)
  $("pfChangeAvatarBtn").addEventListener("click", () => $("pfAvatarFile").click());
  $("pfAvatarFile").addEventListener("change", async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) { showErr(t("Please choose an image file.")); e.target.value = ""; return; }
    if (file.size > 8 * 1024 * 1024) { showErr(t("Image too large (max 8 MB).")); e.target.value = ""; return; }
    hideErr();
    const btn = $("pfChangeAvatarBtn");
    btn.disabled = true; btn.textContent = t("Uploading...");
    try {
      const dataUrl = await resizeImageToDataURL(file, 128, 0.82);
      await db.collection("users").doc(currentUser.uid).set({ photoURL: dataUrl }, { merge: true });
      myProfile.photoURL = dataUrl;        // 全站頭像統一讀 profile photoURL → 立即生效
      renderAvatar(myProfile);
      refreshIdentityUI();
    } catch (err) { showErr(t("Couldn't process that image. Try another.")); }
    btn.disabled = false; btn.textContent = t("Change photo");
    e.target.value = "";
  });

  // 儲存
  $("pfSaveBtn").addEventListener("click", async () => {
    if (!currentUser) return;
    hideErr();
    const newName = $("pfDisplayName").value.trim();
    const bio     = $("pfBio").value.trim();
    const discord = $("pfDiscord").value.trim();
    const discordPublic = $("pfDiscordPublic").checked;
    if (!newName) { showErr(t("Name can't be empty.")); return; }

    const patch = { bio, discord, discordPublic, favBook: pickedFav || null };
    const curName = (myProfile && myProfile.displayName) || "";
    let nameChanged = false;
    if (newName !== curName) {
      const last = myProfile && myProfile.nameChangedAt;
      let lastMs = 0;
      if (last && typeof last.toMillis === "function") lastMs = last.toMillis();
      else if (last && last.seconds) lastMs = last.seconds * 1000;
      if (lastMs && Date.now() - lastMs < 24 * 3600 * 1000) {
        const hrs = Math.ceil((24 * 3600 * 1000 - (Date.now() - lastMs)) / 3600000);
        showErr(t("You can only change your name once a day. Try again in {h}h.", { h: hrs }));
        return;
      }
      patch.displayName  = newName;
      patch.nameChangedAt = firebase.firestore.FieldValue.serverTimestamp();
      nameChanged = true;
    }

    const btn = $("pfSaveBtn");
    btn.disabled = true; btn.textContent = t("Saving...");
    try {
      await db.collection("users").doc(currentUser.uid).set(patch, { merge: true });
      if (nameChanged) await currentUser.updateProfile({ displayName: newName });
      myProfile.bio = bio; myProfile.discord = discord; myProfile.discordPublic = discordPublic; myProfile.favBook = patch.favBook;
      if (nameChanged) {
        myProfile.displayName  = newName;
        myProfile.nameChangedAt = { toMillis: () => Date.now() };  // 本地近似,下次重載取真值
      }
      refreshIdentityUI();
      close();
    } catch (e) { showErr(t("Failed to save") + ": " + e.message); }
    btn.disabled = false; btn.textContent = t("Save");
  });

  // 開窗入口:右上角名字 + 頭像(真節點搬進手機抽屜後監聽仍在)
  const nameEl = document.getElementById("userDisplayName");
  const avEl   = document.getElementById("userAvatarSm");
  if (nameEl) { nameEl.style.cursor = "pointer"; nameEl.title = "Profile settings"; nameEl.addEventListener("click", open); }
  if (avEl)   { avEl.style.cursor = "pointer"; avEl.addEventListener("click", open); }

  // 關窗
  $("closeProfileModal").addEventListener("click", close);
  $("pfCancelBtn").addEventListener("click", close);
  modal.addEventListener("click", e => { if (e.target.id === "profileModal") close(); });
})();

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
  if (window.__backReconcile) window.__backReconcile();   // 進公開書架也算「探索層」→ 上一頁回書架
  setViewClass("explore");
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.toggle("active", t.dataset.view === "explore"));
  document.querySelectorAll(".shelf-only").forEach(el => el.style.display = "none");
  document.getElementById("sidebar").style.display = "none";
  document.getElementById("shelfView").style.display   = "none";
  document.getElementById("feedView").style.display    = "none";   // 從動態點人名進來時要藏動態,否則兩層疊一起
  document.getElementById("exploreView").style.display = "";
  exploreLoaded = true;
  viewingPublicUid = uid;
  setExploreMode("shelf");
  const grid   = document.getElementById("exploreGrid");
  grid.innerHTML = `<div class="loading">${t("Loading...")}</div>`;
  try {
    const prof  = await db.collection("users").doc(uid).get();
    const pdata = prof.exists ? prof.data() : {};
    const name  = fmtName(pdata);   // 身分顯示一律帶 #tag(全站一致)
    const profile = { uid, ...pdata };   // 完整檔案 → banner 頭像 + 唯讀個人檔案視窗
    publicShelfOwner = { uid, name, rating: null, profile };   // 供三評分面板的「他的評分」
    setupFollowButton(uid);
    if (!pdata.shelfPublic) {
      lastPublicShelf = { state: "private", name, profile };
    } else {
      const snap  = await db.collection("users").doc(uid).collection("books").orderBy("createdAt","desc").get();
      const books = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => !b.hidden);   // 別人看不到被隱藏的書
      lastPublicShelf = { state: "ok", books, name, profile };
    }
  } catch (e) {
    lastPublicShelf = { state: "error" };
  }
  renderPublicShelfView();
}

// 從 lastPublicShelf 快取重畫 banner+書架+相容度面板(初次載入 & 語言切換共用 → 切語言面板不再凍結)
function renderPublicShelfView() {
  const c = lastPublicShelf;
  if (!c) return;
  const grid    = document.getElementById("exploreGrid");
  const banner  = document.getElementById("publicBanner");
  const nameEl  = document.getElementById("phName");
  const subEl   = document.getElementById("phSub");
  const gaugeEl = document.getElementById("phGauge");
  const factsEl = document.getElementById("phFacts");
  banner.style.display = "flex";   // .public-header 用 flex-direction:column 疊「身分列 + 共同書列」
  // 頭像:點開對方唯讀個人檔案
  paintBannerAvatar(c.profile);
  // 名字(#tag 灰字)
  const p = c.profile || {};
  if (nameEl) nameEl.innerHTML = escHtml(p.displayName || "Reader")
    + (p.tag ? ` <span class="ph-tag">#${escHtml(p.tag)}</span>` : "");
  // 預設先藏儀表/共同書(各狀態再決定)
  if (gaugeEl) gaugeEl.style.display = "none";
  if (factsEl) factsEl.style.display = "none";
  if (c.state === "private") {
    subEl.textContent = t("🔒 Library is private");
    grid.innerHTML = `<div class="loading">${t("This user has no public library")}</div>`;
  } else if (c.state === "error") {
    subEl.textContent = t("🔒 Cannot load this shelf");
    grid.innerHTML = `<div class="loading">${t("Could not load — they may have made it private")}</div>`;
  } else {
    subEl.textContent = t("Library · {n} books", { n: c.books.length });
    renderPublicShelf(c.books);
    renderCompatHeader(c.books, c.name);
  }
}

// 公開書架 banner 上的小頭像(點開對方唯讀個人檔案)
function paintBannerAvatar(profile) {
  const btn = document.getElementById("publicAvatarBtn");
  if (!btn) return;
  if (!profile) { btn.style.display = "none"; return; }
  const url = profile.photoURL || "";
  const nm  = profile.displayName || "R";
  btn.innerHTML = url ? `<img src="${escHtml(url)}" alt="" />` : "";
  if (!url) btn.textContent = nm.slice(0, 2).toUpperCase();
  btn.title = t("View profile");
  btn.style.display = "";
  btn.onclick = () => openPublicProfile(profile);
}

// 唯讀個人檔案視窗:把別人填的頭像/自介/年度最愛/Discord 秀出來
function openPublicProfile(p) {
  if (!p) return;
  const $ = id => document.getElementById(id);
  const url = p.photoURL || "";
  const nm  = p.displayName || "Reader";
  if (url) $("ppAvatar").innerHTML = `<img src="${escHtml(url)}" alt="" />`;
  else { $("ppAvatar").innerHTML = ""; $("ppAvatar").textContent = nm.slice(0, 2).toUpperCase(); }
  $("ppName").textContent = fmtName(p);
  const stats = [p.followerCount ? `👥 ${fmtCount(p.followerCount)}` : "",
                 p.reviewCount   ? `💬 ${p.reviewCount}` : ""].filter(Boolean).join("　·　");
  $("ppStats").textContent = stats; $("ppStats").style.display = stats ? "" : "none";
  const bio = (p.bio || "").trim();
  $("ppBio").textContent = bio; $("ppBio").style.display = bio ? "" : "none";
  if (p.favBook && p.favBook.title) {
    $("ppFav").style.display = "";
    const cov = $("ppFavCover");
    cov.src = p.favBook.cover || ""; cov.style.display = p.favBook.cover ? "" : "none";
    $("ppFavTitle").textContent = p.favBook.title;
  } else $("ppFav").style.display = "none";
  // Discord 只在對方設為公開時才顯示(discordPublic !== false = 顯示;舊資料無此欄預設顯示)
  const dc = (p.discord || "").trim();
  if (dc && p.discordPublic !== false) { $("ppDiscord").style.display = ""; $("ppDiscordVal").textContent = dc; }
  else $("ppDiscord").style.display = "none";
  // 「查看書架」:從探索卡點進來時帶你去他書架;已在他書架就只關閉
  $("ppShelfBtn").onclick = () => { closePublicProfile(); if (p.uid && p.uid !== viewingPublicUid) loadPublicShelf(p.uid); };
  document.getElementById("publicProfileModal").classList.add("open");
}
function closePublicProfile() { document.getElementById("publicProfileModal").classList.remove("open"); }
(function setupPublicProfileModal() {
  const m = document.getElementById("publicProfileModal");
  if (!m) return;
  document.getElementById("closePublicProfile").addEventListener("click", closePublicProfile);
  m.addEventListener("click", e => { if (e.target.id === "publicProfileModal") closePublicProfile(); });
})();

// ══════════════════════════════════════════
//  閱讀相容度引擎(口味比對)
// ══════════════════════════════════════════
// 流行度(Open Library 閱讀記錄人數,存在 book.popularity;-1/未知=當中段)→ 稀有度權重(6級)。
// 冷門書權重高、國民書幾乎不算 → 共鳴在冷門書上才是真品味。
function rarityWeight(pop) {
  if (pop == null || pop < 0) return 1.2;   // 未知 → 中段,不爆掉
  if (pop > 20000) return 0.1;              // 國民書(原子習慣/哈利波特級)
  if (pop > 8000)  return 0.3;              // 很熱門(1984 級)
  if (pop > 3000)  return 0.6;              // 熱門(沙丘/大亨小傳級)
  if (pop > 800)   return 1.2;              // 中段
  if (pop > 150)   return 1.8;              // 較少人讀
  return 2.5;                               // 冷門
}
function compatKeyOf(b) { return b.catalogKey || catalogKeyFor(b.title, b.author); }
function genreVector(books) {
  const v = {};
  books.forEach(b => { const g = (b.genre || "").trim(); if (g) v[g] = (v[g] || 0) + 1; });
  return v;
}
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach(k => { dot += (a[k]||0) * (b[k]||0); });
  Object.values(a).forEach(x => na += x*x);
  Object.values(b).forEach(y => nb += y*y);
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
// 核心:我的書庫 vs 對方書庫 → 相容度 + 信心 + 拆解
function computeCompatibility(mine, theirs) {
  const myMap = new Map(), thMap = new Map();
  mine.forEach(b => { const k = compatKeyOf(b); if (k && !myMap.has(k)) myMap.set(k, b); });
  theirs.forEach(b => { const k = compatKeyOf(b); if (k && !thMap.has(k)) thMap.set(k, b); });

  // ① 書名重疊(流行度加權)。分母 = 較專精(權重較小)那邊的書庫
  //    → 答「他讀的東西跟我多合」(=該不該信他的推薦),不被廣讀者的大書庫稀釋。
  let myWeight = 0; myMap.forEach(b => myWeight += rarityWeight(b.popularity));
  let theirWeight = 0; thMap.forEach(b => theirWeight += rarityWeight(b.popularity));
  const shared = [];
  myMap.forEach((b, k) => { if (thMap.has(k)) shared.push({ book: b, them: thMap.get(k), w: rarityWeight(b.popularity) }); });
  const sharedWeight = shared.reduce((s, x) => s + x.w, 0);
  const denom = Math.min(myWeight, theirWeight) || 1;
  const titleOverlap = Math.min(1, sharedWeight / denom);

  // ③ 類型輪廓相似(補書名稀疏)
  const genreSim = cosineSim(genreVector([...myMap.values()]), genreVector([...thMap.values()]));

  // ② 評分一致(兩人都評過分的共同書;星差越小越合,冷門書加權;含負向=他愛你恨拖低)
  const rated = shared.filter(x => x.book.rating > 0 && x.them.rating > 0);
  let agreeW = 0, agreeNum = 0;
  rated.forEach(x => { agreeW += x.w; agreeNum += x.w * (1 - Math.abs(x.book.rating - x.them.rating) / 4); });
  const ratingAgreement = agreeW > 0 ? agreeNum / agreeW : 0;
  const coRated = rated.length;

  // 合成:①③ 是「拉得開」的核心鑑別訊號;② 評分一致只當「以基線(0.8)為中心的微調」。
  //   理由:人只評讀過又偏愛的書,一致度天生高基線(~0.85),當正項混入會把大家一起拉高、壓掉高低差。
  //   所以只有「高於基線(在分歧書上也合)」才加分,「真分歧(他愛你恨)」才扣分;幅度隨評分資料量縮放。
  const base = 0.55 * titleOverlap + 0.45 * genreSim;
  const ratingAdj = coRated ? (ratingAgreement - 0.8) * Math.min(coRated / 6, 1) * 0.35 : 0;
  const score = Math.max(0, Math.min(1, base + ratingAdj));

  // 信心 ≠ 分數:共同書 + 共同評分書越多越有把握(分開、不相乘)
  const confidence = Math.min(1, (shared.length + coRated) / 15);

  shared.sort((a, b) => b.w - a.w);   // 權重高(越冷門)排前 → 最強共鳴
  const bothLoved = rated.filter(x => x.book.rating >= 4 && x.them.rating >= 4)
                         .sort((a, b) => b.w - a.w).map(x => x.book.title);
  let topClash = null, maxDiff = 0;
  rated.forEach(x => { const d = Math.abs(x.book.rating - x.them.rating);
    if (d > maxDiff) { maxDiff = d; topClash = { title: x.book.title, mine: x.book.rating, theirs: x.them.rating }; } });
  return {
    score, confidence, sharedCount: shared.length,
    myCount: myMap.size, theirCount: thMap.size,
    coRated, ratingAgreement,
    nicheShared: shared.filter(x => x.w >= 1.5).slice(0, 3).map(x => x.book.title),
    topShared:   shared.slice(0, 4).map(x => x.book.title),
    bothLoved:   bothLoved.slice(0, 2),
    topClash:    maxDiff >= 2 ? topClash : null,   // 差 ≥2 星才算「分歧」
    // #6 共同書比對:bookKey + 兩人私人評分(免額外讀;評論文字點開時才 lazy 抓)
    sharedKeys:  shared.map(x => ({
      key: compatKeyOf(x.book), title: x.book.title,
      cover: x.book.cover || x.them.cover || "",
      myRating: x.book.rating || 0, theirRating: x.them.rating || 0,
    })),
  };
}
// 相似度分級配色:>=55 苔綠 / 30~54 金 / <30 陶土
function tierColor(pct) { return pct >= 55 ? "#5A7052" : pct >= 30 ? "#C28E2D" : "#B5654A"; }
// 270° 開口拱形儀表(底部缺口),依 pct 畫填充弧 → 比滿環矮、較有文學感
function arcGaugeSVG(pct, color) {
  const r = 19, C = 2 * Math.PI * r;                 // 119.4
  const arc = C * 0.75;                              // 270° 軌道
  const fill = arc * Math.max(0, Math.min(100, pct)) / 100;
  const cx = 23, cy = 23, rot = `rotate(135 ${cx} ${cy})`;   // 轉 135° → 缺口落在正下方
  return `<svg class="ph-arc" width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#EDE6D4" stroke-width="5" stroke-linecap="round" stroke-dasharray="${arc.toFixed(1)} ${C.toFixed(1)}" transform="${rot}"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${fill.toFixed(1)} ${C.toFixed(1)}" transform="${rot}"/>`
    + `</svg>`;
}
// 最近一次算出的相容度明細(供「並排比對」視窗頂部顯示評分一致度/冷門共讀/品味衝突)
let lastCompat = null;
// 整合 header 的相似度區:儀表 + 大字% + 共同書列(填進 #phGauge / #phFacts)
function renderCompatHeader(theirBooks, name) {
  const gaugeEl = document.getElementById("phGauge");
  const factsEl = document.getElementById("phFacts");
  if (!gaugeEl || !factsEl) return;
  const mine = (typeof allBooks !== "undefined") ? allBooks : [];
  // 沒登入 / 看自己 / 自己書太少 / 對方沒書 → 只留身分列,不算相似度
  if (!currentUser || viewingPublicUid === currentUser.uid || mine.length < 5 || !theirBooks.length) {
    gaugeEl.style.display = "none";
    factsEl.style.display = "none";
    lastCompat = null;
    return;
  }
  const r = computeCompatibility(mine, theirBooks);
  lastCompat = r;
  const pct = Math.round(r.score * 100);
  const color = tierColor(pct);
  gaugeEl.style.display = "flex";
  gaugeEl.innerHTML = arcGaugeSVG(pct, color)
    + `<div class="ph-gnum"><span class="ph-gpct" style="color:${color}">${pct}<span class="ph-gpctsign">%</span></span>`
    + `<span class="ph-glabel">${t("Reading similarity")}</span></div>`;
  factsEl.style.display = "flex";
  if (r.sharedCount) {
    factsEl.classList.add("ph-facts-link");
    factsEl.classList.remove("ph-facts-dim");
    factsEl.innerHTML = `<span class="ph-facts-ico">📚</span>`
      + `<span class="ph-facts-txt">${t("{n} books in common", { n: r.sharedCount })}${r.topShared.length ? ` — ${r.topShared.map(escHtml).join("、")}${r.sharedCount > 4 ? "…" : ""}` : ""}</span>`
      + `<span class="ph-facts-go">›</span>`;
    factsEl.onclick = () => { if (r.sharedKeys && r.sharedKeys.length) openSharedReviews(r.sharedKeys, viewingPublicUid, name); };
  } else {
    factsEl.classList.remove("ph-facts-link");
    factsEl.classList.add("ph-facts-dim");
    factsEl.innerHTML = `<span class="ph-facts-txt">${t("No overlap yet — taste match is based on genres only")}</span>`;
    factsEl.onclick = null;
  }
}

// 手機:捲動瀏覽書架時自動把相容度面板縮成一條(回頂端再展開);只綁一次。
// 防禦性同時聽 #mainContent 與 #exploreGrid(不確定哪個是實際捲動容器,聽不到也只是不自動縮、手動鈕照常)。
let _cpScrollBound = false;
function setupCompatScrollCollapse() {
  if (_cpScrollBound) return;
  _cpScrollBound = true;
  let lastY = 0;
  const onScroll = (e) => {
    const p = document.getElementById("compatPanel");
    if (!p || p.style.display === "none" || !window.matchMedia("(max-width: 600px)").matches) return;
    const y = e.target.scrollTop || 0;
    if (y <= 4) p.classList.remove("cp-collapsed");
    else if (y > lastY + 6) p.classList.add("cp-collapsed");
    lastY = y;
  };
  ["mainContent", "exploreGrid"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("scroll", onScroll, { passive: true });
  });
}

// ── #6 共同書比對:點「共同讀過 N 本」→ 並排看兩人對每本的評分+評論 ──
// 讀 catalog/{key}/reviews/{uid}(同 loadReviews 的路徑,規則允許);評分用私人書架值當後備。
async function openSharedReviews(sharedKeys, theirUid, theirName) {
  const modal = document.getElementById("sharedReviewsModal");
  const body  = document.getElementById("sharedReviewsBody");
  if (!modal || !body || !currentUser || !theirUid) return;
  document.getElementById("sharedReviewsTitle").textContent = t("Shared books with {name}", { name: theirName });
  body.innerHTML = `<div class="loading">${t("Loading...")}</div>`;
  modal.classList.add("open");   // 返回鍵層由全域 overlay 觀察器自動登記
  const myUid = currentUser.uid;
  const rows = await Promise.all((sharedKeys || []).map(async sk => {
    let mine = null, theirs = null;
    try {
      const [a, b] = await Promise.all([
        db.collection("catalog").doc(sk.key).collection("reviews").doc(myUid).get(),
        db.collection("catalog").doc(sk.key).collection("reviews").doc(theirUid).get(),
      ]);
      mine   = a.exists ? a.data() : null;
      theirs = b.exists ? b.data() : null;
    } catch (e) {}
    return { sk, mine, theirs };
  }));
  const col = (rev, fallbackRating, who) => {
    const rating = (rev && rev.rating) ? rev.rating : fallbackRating;
    const stars  = rating
      ? `<div class="sr-stars">${starsHTML(rating)}<span class="sr-score">${rating}</span></div>`
      : `<div class="sr-stars sr-norate">${t("Not rated")}</div>`;
    const text = (rev && rev.text)
      ? `<div class="sr-text">${escHtml(rev.text)}</div>`
      : rating
        ? `<div class="sr-text sr-empty">${t("Rated only — no written review")}</div>`
        : `<div class="sr-text sr-empty">${t("Hasn't reviewed this book")}</div>`;
    return `<div class="sr-col"><div class="sr-who">${escHtml(who)}</div>${stars}${text}</div>`;
  };
  const cards = rows.map(({ sk, mine, theirs }) => {
    const coverHtml = sk.cover
      ? `<img class="sr-cover" ${coverAttrs(sk.cover)} alt="" referrerpolicy="no-referrer" onerror="if(window.__coverFallback(this))return;if(window.__retryProxy(this))return;this.style.display='none'">`
      : `<div class="sr-cover sr-nocover">📖</div>`;
    const diff = (sk.myRating && sk.theirRating) ? Math.abs(sk.myRating - sk.theirRating) : 0;
    const tag = diff >= 2 ? `<span class="sr-tag sr-clash">${t("Differ")}</span>`
              : (sk.myRating && sk.theirRating && diff === 0) ? `<span class="sr-tag sr-agree">${t("Agree")}</span>` : "";
    return `<div class="sr-card">
      <div class="sr-bookhead">${coverHtml}<div class="sr-booktitle">${escHtml(sk.title)}${tag}</div></div>
      <div class="sr-cols">${col(mine, sk.myRating, t("You"))}${col(theirs, sk.theirRating, theirName)}</div>
    </div>`;
  }).join("") || `<div class="loading">${t("No shared books")}</div>`;
  // 頂部:相似度明細(評分一致度/冷門共讀/都評高分/品味衝突)——從 header 搬進來
  body.innerHTML = compatFactsHTML(lastCompat) + cards;
}

// 相似度明細摘要(顯示在「並排比對」視窗頂部)
function compatFactsHTML(r) {
  if (!r) return "";
  const pct = Math.round(r.score * 100);
  const color = tierColor(pct);
  const rows = [];
  if (r.coRated) rows.push(`<div class="sr-fact">🎯 ${t("Rating agreement")}: <b>${Math.round(r.ratingAgreement * 100)}%</b> ${t("over {n} co-rated", { n: r.coRated })}</div>`);
  if (r.nicheShared && r.nicheShared.length) rows.push(`<div class="sr-fact">🔥 ${t("You both read niche")}: <b>${r.nicheShared.map(escHtml).join("、")}</b></div>`);
  if (r.bothLoved && r.bothLoved.length) rows.push(`<div class="sr-fact">💜 ${t("You both rated highly")}: <b>${r.bothLoved.map(escHtml).join("、")}</b></div>`);
  if (r.topClash) rows.push(`<div class="sr-fact sr-fact-clash">⚡ ${t("Taste clash")}: ${escHtml(r.topClash.title)} — ${t("them")} ${"★".repeat(r.topClash.theirs)} / ${t("you")} ${"★".repeat(r.topClash.mine)}</div>`);
  return `<div class="sr-facts"><div class="sr-facts-score" style="color:${color}">${pct}% · ${t("Reading similarity")}</div>${rows.join("")}</div>`;
}
function closeSharedReviews() {
  document.getElementById("sharedReviewsModal").classList.remove("open");
}
document.getElementById("closeSharedReviews").addEventListener("click", closeSharedReviews);
document.getElementById("sharedReviewsModal").addEventListener("click", (e) => {
  if (e.target.id === "sharedReviewsModal") closeSharedReviews();   // 點遮罩關
});

function renderPublicShelf(books) {
  const grid = document.getElementById("exploreGrid");
  document.getElementById("exploreCount").textContent = "";
  if (!books.length) { grid.innerHTML = `<div class="loading">${t("This shelf is empty")}</div>`; return; }
  grid.innerHTML = books.map(b => {
    const cover = b.cover
      ? `<div class="book-cover"><img ${coverAttrs(b.cover)} alt="" loading="lazy" referrerpolicy="no-referrer" onerror="if(window.__coverFallback(this))return; if(window.__retryProxy(this))return; this.parentElement.innerHTML='<div class=no-cover><div class=no-cover-icon>📖</div></div>'" /></div>`
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
  // 公開書架也吃 --card-w-fit → 進場/縮放都要依「這個 grid」重算欄寬,否則沿用主書架舊值、縮放沒反應
  requestAnimationFrame(() => applyShelfRows(grid));
  grid.querySelectorAll(".book-card").forEach(card =>
    card.addEventListener("click", async () => {
      try {
        const key = card.dataset.key;
        // 記下這本書在「主人書架上的自評」→ 三評分面板顯示「他的評分」
        const ob = books.find(x => (x.catalogKey || catalogKeyFor(x.title, x.author)) === key);
        publicShelfOwner.rating = ob ? (ob.rating || 0) : 0;
        const snap = await db.collection("catalog").doc(key).get();
        if (snap.exists) {
          openCatalogDetail({ key, ...snap.data() });
        } else if (ob) {
          // catalog 文件還沒建(早期用腳本灌的種子帳號,書沒 upsert 進共享書庫)→
          // 改用書本身資料開詳情,並順手補建 catalog(自我修復;catalog 寫入規則允許任何登入者)。
          openCatalogDetail({ key, title: ob.title || "", author: ob.author || "",
            genre: ob.genre || "", cover: ob.cover || "", totalPages: ob.totalPages || 0 });
          upsertCatalog(ob).catch(() => {});
        }
      } catch (e) { console.warn("open public book failed:", e); }
    }));
}

document.getElementById("publicBackBtn").addEventListener("click", () => {
  viewingPublicUid = null;
  lastPublicShelf = null;
  switchExploreSubtab(exploreSubtab || "people");
});

// ══════════════════════════════════════════
//  i18n — 多語系(英文基準 + 繁中,自動偵測 + 可切換)
// ══════════════════════════════════════════
const LANGS = ["en", "zh-TW"];
let currentLang = "en";

const DICT = {
  // 個人檔案設定(版本A)
  "Profile settings": { "zh-TW": "個人檔案設定" },
  "Display name": { "zh-TW": "顯示名稱" },
  "About me": { "zh-TW": "自我介紹" },
  "My favorite book this year": { "zh-TW": "我的年度最愛" },
  "Linked accounts": { "zh-TW": "已連結帳號" },
  "Change photo": { "zh-TW": "更換頭像" },
  "Show my Discord on my public profile": { "zh-TW": "在公開檔案顯示我的 Discord" },
  "When off, only you can see it — book friends won't.": { "zh-TW": "關閉時只有你看得到,書友看不到。" },
  "View shelf": { "zh-TW": "查看書架" },
  "View profile": { "zh-TW": "查看個人檔案" },
  "Reading similarity": { "zh-TW": "閱讀相似度" },
  "Library · {n} books": { "zh-TW": "書庫 {n} 本" },
  "🔒 Library is private": { "zh-TW": "🔒 此書庫不公開" },
  "Linked": { "zh-TW": "已連結" },
  "Not linked": { "zh-TW": "未連結" },
  "Uploading...": { "zh-TW": "上傳中..." },
  "Upload failed": { "zh-TW": "上傳失敗" },
  "You can change your name once a day. The #number stays the same.": { "zh-TW": "名稱一天只能改一次,#數字不會變。" },
  "Shown on your profile so book friends can find you on Discord.": { "zh-TW": "顯示在你的檔案上,書友可以在 Discord 找到你。" },
  "JPG or PNG — we'll resize it for you.": { "zh-TW": "JPG 或 PNG,我們會自動幫你縮圖。" },
  "You can change this anytime in settings.": { "zh-TW": "日後可在設定隨時更改。" },
  "Name can't be empty.": { "zh-TW": "名稱不能空白。" },
  "No matches in your shelf.": { "zh-TW": "你的書架沒有相符的書。" },
  "Please choose an image file.": { "zh-TW": "請選擇圖片檔。" },
  "Image too large (max 8 MB).": { "zh-TW": "圖片太大(上限 8 MB)。" },
  "Couldn't process that image. Try another.": { "zh-TW": "這張圖處理失敗,換一張試試。" },
  "You can only change your name once a day. Try again in {h}h.": { "zh-TW": "名稱一天只能改一次,請 {h} 小時後再試。" },
  // placeholder
  "Your name": { "zh-TW": "你的名字" },
  "A line or two about what you read…": { "zh-TW": "簡單寫幾句你都讀些什麼…" },
  "Search your shelf…": { "zh-TW": "搜尋你的書架…" },
  "e.g. yourname or yourname#0000": { "zh-TW": "例如 yourname 或 yourname#0000" },
  // 信箱驗證關卡
  "Verify your email": { "zh-TW": "驗證你的信箱" },
  "We sent a verification link to your email.": { "zh-TW": "我們已寄出驗證連結至你的信箱。" },
  "We sent a verification link to:": { "zh-TW": "我們已寄出驗證連結至:" },
  "I've verified — continue": { "zh-TW": "我已驗證,繼續" },
  "Resend verification email": { "zh-TW": "重寄驗證信" },
  "Use a different account": { "zh-TW": "改用其他帳號" },
  "Not verified yet. Please click the link in your email.": { "zh-TW": "尚未驗證,請點擊信中的連結。" },
  "✓ Verification email resent. Check your inbox.": { "zh-TW": "✓ 驗證信已重寄,請查收信箱。" },
  "Checking...": { "zh-TW": "檢查中..." },
  // 導覽 / 側欄
  "My Shelf": { "zh-TW": "我的書架" }, "Explore": { "zh-TW": "探索" }, "Feed": { "zh-TW": "動態" },
  "104 books": { "zh-TW": "104 本書" },   // landing demo 頂欄
  "Status": { "zh-TW": "狀態" }, "⬜ All": { "zh-TW": "⬜ 全部" },
  "⏳ Now Reading": { "zh-TW": "⏳ 正在閱讀" }, "⏭ TBR": { "zh-TW": "⏭ 待讀" },
  "📋 Want to Read": { "zh-TW": "📋 想讀" }, "✅ Finished": { "zh-TW": "✅ 已讀完" }, "🚫 DNF": { "zh-TW": "🚫 棄讀" },
  "Year": { "zh-TW": "年份" }, "All Years": { "zh-TW": "所有年份" },
  "Genre": { "zh-TW": "類型" }, "All Genres": { "zh-TW": "所有類型" },
  "+ New Book": { "zh-TW": "+ 新增書籍" },
  // 匯入中心
  "🌐 Web Page": { "zh-TW": "🌐 網頁匯入" },
  "⬇ Download sample CSV template": { "zh-TW": "⬇ 下載範例 CSV 模板" },
  "Fetch": { "zh-TW": "抓取" },
  "Find books in pasted text": { "zh-TW": "從貼上的內容找書" },
  "Fetching page...": { "zh-TW": "抓取頁面中..." },
  "Looking up {i} / {n}...": { "zh-TW": "查書中 {i} / {n}..." },
  "No valid ISBNs found on that page.": { "zh-TW": "找不到有效的 ISBN。" },
  "Found {n} ISBNs → resolved {m} books. Review below.": { "zh-TW": "找到 {n} 組 ISBN → 解析出 {m} 本書,請在下方確認。" },
  "Please enter a valid http(s) URL.": { "zh-TW": "請輸入有效的 http(s) 網址。" },
  "Could not fetch that page — paste its content below instead.": { "zh-TW": "抓不到這個頁面——改把頁面內容複製貼到下方吧。" },
  "Web page import": { "zh-TW": "網頁匯入" },
  "Could not find a 'Title' column.": { "zh-TW": "找不到「Title / 書名」欄位。" },
  "Please upload a .csv or .txt file.": { "zh-TW": "請上傳 .csv 或 .txt 檔。" },
  "https:// page URL with ISBNs": { "zh-TW": "https:// 含 ISBN 的頁面網址" },
  "Paste page content / any text containing ISBNs": { "zh-TW": "貼上頁面內容/任何含 ISBN 的文字" },
  "⚙ Privacy": { "zh-TW": "⚙ 隱私設定" }, "Sign out": { "zh-TW": "登出" },
  // 篩選列
  "Sort by": { "zh-TW": "排序" },
  "Date Added ↓": { "zh-TW": "加入日期 ↓" }, "Date Added ↑": { "zh-TW": "加入日期 ↑" },
  "Status (reading → done)": { "zh-TW": "依閱讀狀態(正在讀 → 完成)" },
  "Title A → Z": { "zh-TW": "書名 A → Z" }, "Title Z → A": { "zh-TW": "書名 Z → A" },
  "Author A → Z": { "zh-TW": "作者 A → Z" }, "Date Finished ↓": { "zh-TW": "讀完日期 ↓" },
  "Progress ↓": { "zh-TW": "進度 ↓" }, "Pages ↓": { "zh-TW": "頁數 ↓" },
  "Progress ↓ (currently reading)": { "zh-TW": "進度 ↓(正在讀)" },
  "Format": { "zh-TW": "版本" }, "All Formats": { "zh-TW": "所有版本" },
  "Unspecified": { "zh-TW": "未指定" }, "Physical": { "zh-TW": "實體書" },
  "Ebook": { "zh-TW": "電子書" }, "Audiobook": { "zh-TW": "有聲書" }, "Borrowed": { "zh-TW": "借閱" },
  "✕ Clear filters": { "zh-TW": "✕ 清除篩選" },
  "Rating ↓": { "zh-TW": "評分 ↓" }, "Popularity ↓": { "zh-TW": "熱度 ↓" }, "Recently Added": { "zh-TW": "最新加入" },
  "Search books...": { "zh-TW": "搜尋書籍..." }, "No books found.": { "zh-TW": "找不到書。" },
  // 截圖 / Toast
  "Drag to select the area you want as the cover": { "zh-TW": "拖曳選取要當封面的區域" },
  "✕ Cancel": { "zh-TW": "✕ 取消" }, "✓ Use this area": { "zh-TW": "✓ 使用此區域" }, "↺ Re-select": { "zh-TW": "↺ 重選" },
  // 新增書籍 Modal
  "Add Book": { "zh-TW": "新增書籍" }, "Edit Book": { "zh-TW": "編輯書籍" },
  "Enter ISBN or book title...": { "zh-TW": "輸入 ISBN 或書名..." }, "Search": { "zh-TW": "搜尋" },
  "Searching...": { "zh-TW": "搜尋中..." }, "No results found. Fill in manually.": { "zh-TW": "找不到結果,請手動填寫。" },
  "Pick the right book:": { "zh-TW": "點選正確的那一本:" }, "Selected": { "zh-TW": "已選" },
  "Cover": { "zh-TW": "封面" }, "No Cover": { "zh-TW": "無封面" },
  "🖼 Change Cover": { "zh-TW": "🖼 更換封面" }, "🔄 Re-fetch": { "zh-TW": "🔄 重新抓取" },
  "🎨 Gallery": { "zh-TW": "🎨 圖庫" }, "📁 Upload": { "zh-TW": "📁 上傳" }, "🔗 Link": { "zh-TW": "🔗 連結" }, "✂️ Screenshot": { "zh-TW": "✂️ 截圖" },
  "click to browse": { "zh-TW": "點擊瀏覽" }, "or Ctrl+V to paste an image": { "zh-TW": "或按 Ctrl+V 貼上圖片" },
  "Paste an image URL...": { "zh-TW": "貼上圖片網址..." }, "Submit": { "zh-TW": "送出" },
  "Paste the image's URL (not the product page). Right-click a book's cover image, choose Copy image address, then paste it above.": { "zh-TW": "請貼「圖片本身」的網址,不是商品頁網址。在博客來、誠品等網站的書封圖片上按右鍵 →「複製圖片位址」,再貼到上方欄位即可。" },
  "Capture any area of your screen as a book cover.": { "zh-TW": "擷取螢幕任一區域當作書封。" },
  "📸 Start Screen Capture": { "zh-TW": "📸 開始截取螢幕" },
  "🗑 Remove cover": { "zh-TW": "🗑 移除封面" }, "Close": { "zh-TW": "關閉" },
  "Title *": { "zh-TW": "書名 *" }, "Book title": { "zh-TW": "書名" }, "Author *": { "zh-TW": "作者 *" }, "Author name": { "zh-TW": "作者名" },
  "e.g. Fantasy, Mystery": { "zh-TW": "例:奇幻、推理" }, "Total Pages": { "zh-TW": "總頁數" }, "e.g. 400": { "zh-TW": "例:400" },
  "Pages": { "zh-TW": "頁數" },
  "Want to Read": { "zh-TW": "想讀" }, "TBR": { "zh-TW": "待讀" }, "Now Reading": { "zh-TW": "正在閱讀" }, "Finished": { "zh-TW": "已讀完" }, "DNF": { "zh-TW": "棄讀" },
  "Current Page": { "zh-TW": "目前頁數" }, "e.g. 120": { "zh-TW": "例:120" },
  "Start Date": { "zh-TW": "開始日期" }, "Finish Date": { "zh-TW": "讀完日期" },
  "Notes": { "zh-TW": "筆記" }, "Your thoughts...": { "zh-TW": "你的想法..." },
  "Cancel": { "zh-TW": "取消" }, "Save Book": { "zh-TW": "儲存書籍" }, "Save": { "zh-TW": "儲存" },
  // Landing(未登入首頁)
  "✦ Social reading, built on trust": { "zh-TW": "✦ 從你的書架開始的社群閱讀" },
  "Track your books, share reviews, and see how compatible another reader's taste is with yours — before you take their recommendations.": { "zh-TW": "建立自己的書架,用自己的標準評分;再讓書架與評分,帶你連結品味相近的讀者。" },
  "See how it works": { "zh-TW": "看看怎麼運作" },
  "How it works": { "zh-TW": "怎麼運作" },
  "The trust score": { "zh-TW": "閱讀相似度" },
  "One minute to set up. Free for readers.": { "zh-TW": "一分鐘完成設定,讀者免費使用。" },
  "Get started — free": { "zh-TW": "免費開始使用" },
  "Create a free account": { "zh-TW": "免費註冊帳號" },
  "Why Concento?": { "zh-TW": "為什麼選 Concento?" },
  "Reading compatibility": { "zh-TW": "閱讀相似度" },
  "A trust score between you and any reviewer — see how well their taste matches yours before following their picks.": { "zh-TW": "你和任何書評人之間都有一個相似度分數——先看品味合不合,再決定要不要參考他的書單。" },
  "Your shelf": { "zh-TW": "你的書架" },
  "Track what you've read, are reading, and want to read — with progress, ratings, and yearly stats.": { "zh-TW": "記錄讀過、正在讀、想讀的每一本書,附進度、評分與年度統計。" },
  "Discover reviewers": { "zh-TW": "探索書評人" },
  "Browse public shelves and follow curators whose taste you actually trust.": { "zh-TW": "瀏覽公開書架,追蹤品味跟你對頻的選書人。" },
  "Book clubs": { "zh-TW": "讀書會" },
  "Chapter-by-chapter discussions with spoiler protection, on every book.": { "zh-TW": "每本書都有分章節討論區,防爆雷設計,讀到哪聊到哪。" },
  "Know who to trust": { "zh-TW": "品味合不合,數字告訴你" },
  "Concento compares shared books, genres, and ratings to show a compatibility score with any reader — recommendations finally come with context.": { "zh-TW": "Concento 比對你們的共同書目、類型與評分,算出你跟任何讀者的閱讀相似度——推薦終於有了脈絡。" },
  "Start building your shelf today": { "zh-TW": "今天就開始建立你的書架" },
  // 頁尾 / 法律頁
  "Privacy Policy": { "zh-TW": "隱私權政策" }, "Terms of Service": { "zh-TW": "服務條款" },
  "Privacy": { "zh-TW": "隱私權" }, "Terms": { "zh-TW": "條款" }, "Contact": { "zh-TW": "聯絡我們" },
  // 詳情 / 評論
  "About this book": { "zh-TW": "簡介" },
  "Read more": { "zh-TW": "顯示更多" }, "Show less": { "zh-TW": "收合" },
  "Source: Wikipedia (CC BY-SA)": { "zh-TW": "資料來源:維基百科(CC BY-SA)" },
  "Reviews": { "zh-TW": "評論" }, "Book Club": { "zh-TW": "讀書會" },
  "Book Detail": { "zh-TW": "書籍詳情" }, "Progress": { "zh-TW": "進度" },
  "Update current page:": { "zh-TW": "更新目前頁數:" }, "Update": { "zh-TW": "更新" },
  "Update progress:": { "zh-TW": "更新進度:" }, "By page": { "zh-TW": "用頁數" }, "By %": { "zh-TW": "用 %" },
  "✓ Done": { "zh-TW": "✓ 已讀完" },
  "No page info": { "zh-TW": "尚無進度資料" },
  "Edit": { "zh-TW": "編輯" }, "Delete": { "zh-TW": "刪除" }, "➕ Add to My Shelf": { "zh-TW": "➕ 加入我的書架" },
  "✍️ Write a Review": { "zh-TW": "✍️ 寫評論" }, "Your name or nickname": { "zh-TW": "你的名字或暱稱" },
  "Select rating": { "zh-TW": "選擇評分" }, "Share your thoughts... (optional)": { "zh-TW": "分享你的想法...(選填)" }, "Submit Review": { "zh-TW": "送出評論" },
  "You finished a book! 🎉": { "zh-TW": "讀完一本書了!🎉" },
  "How was {title}?": { "zh-TW": "《{title}》讀起來如何?" },
  "Tap to rate": { "zh-TW": "點星星評分" }, "Please tap a star to rate": { "zh-TW": "請先點星星給個評分" },
  "Post review": { "zh-TW": "送出評分" }, "Maybe later": { "zh-TW": "稍後再說" },
  // 隱私
  "Your shelf is public by default, so readers with similar taste can find you. Switch it off below to make it private.": { "zh-TW": "你的書架預設為公開,這樣口味相近的讀者才找得到你。隨時可在下方關閉、改為私密。" },
  "Make my library public": { "zh-TW": "公開我的書庫" },
  "Your shelf is public": { "zh-TW": "你的書架目前是公開的" },
  "Heads up — your shelf is public by default, so readers with similar taste can discover you and you can find each other's books. You can make it private anytime in Settings.": { "zh-TW": "提醒你——你的書架預設為公開,這樣口味相近的讀者才能發現你、彼此找到好書。隨時可到設定改為私密。" },
  "Got it": { "zh-TW": "知道了" },
  "Make it private in Settings": { "zh-TW": "想改私密?到設定關閉公開" },
  "Visible": { "zh-TW": "公開可見" }, "Hidden": { "zh-TW": "已隱藏" },
  "Others can see this book — click to hide": { "zh-TW": "別人看得到這本書,點一下隱藏" },
  "Hidden from others — click to show": { "zh-TW": "別人看不到這本書,點一下公開" },
  "When on, others can browse the books you've read / are reading / want to read, with status and progress.": { "zh-TW": "開啟後,別人可以瀏覽你讀過/在讀/想讀的書,以及狀態與進度。" },
  "Show \"Now Reading\"": { "zh-TW": "顯示「正在閱讀」" },
  "Highlight what you're currently reading on your public library (requires public library).": { "zh-TW": "在你的公開書庫醒目顯示目前正在讀的書(需先公開書庫)。" },
  "📌 Your public ratings/reviews are always public regardless of this setting — they only disappear if you delete them.": { "zh-TW": "📌 你的公開評分/評論一律公開,不受此設定影響——刪除才會消失。" },
  // 匯入
  "⬆ Import Books": { "zh-TW": "⬆ 匯入書籍" },
  "Importing...": { "zh-TW": "匯入中..." }, "Import Books": { "zh-TW": "匯入書籍" },
  "Found {n} books ready to import.": { "zh-TW": "找到 {n} 本書可匯入。" },
  "Found {n} duplicate books. Remove them?": { "zh-TW": "找到 {n} 本重複的書,要移除嗎?" },
  "Found {n} duplicate book. Remove them?": { "zh-TW": "找到 {n} 本重複的書,要移除嗎?" },
  "Drag & drop your CSV file here": { "zh-TW": "拖曳你的 CSV 檔到這裡" },
  "or click to browse": { "zh-TW": "或點擊瀏覽" },
  "Click to change file": { "zh-TW": "點擊更換檔案" }, "Importing {i} / {total}...": { "zh-TW": "匯入中 {i} / {total}..." },
  "Done! ✓ {ok} imported": { "zh-TW": "完成!✓ 已匯入 {ok} 本" }, ", {n} skipped": { "zh-TW": ",跳過 {n} 本" }, ", ✗ {n} failed": { "zh-TW": ",✗ 失敗 {n} 本" },
  "Done": { "zh-TW": "完成" }, "✓ Finished": { "zh-TW": "✓ 已完成" },
  "Import isn't finished — covers haven't been updated yet. Leaving now will remove the books you just imported. Exit anyway?": { "zh-TW": "匯入還沒完成——封面尚未更新。現在離開會清除你剛匯入的書。確定要跳出嗎?" },
  "Cancelling import — removing {n} books...": { "zh-TW": "取消匯入中——正在移除 {n} 本書..." },
  "Import cancelled. {n} books removed.": { "zh-TW": "已取消匯入,移除了 {n} 本書。" },
  "Updating covers (keep this page open)": { "zh-TW": "更新封面中(請勿關閉此頁面)" },
  "✓ Finished updating covers!": { "zh-TW": "✓ 封面更新完成!" },
  // 閱讀相容度
  "Reading compatibility with {name}": { "zh-TW": "與 {name} 的閱讀相似度" },
  "Confidence": { "zh-TW": "信心" }, "High": { "zh-TW": "高" }, "Medium": { "zh-TW": "中" },
  "Low — for reference only": { "zh-TW": "低 — 僅供參考" },
  "You both read niche": { "zh-TW": "你們都讀過冷門的" },
  "{n} books in common": { "zh-TW": "共同讀過 {n} 本" },
  "No overlap yet — taste match is based on genres only": { "zh-TW": "尚無共同書 — 相似度僅依類型推估" },
  "Rating agreement": { "zh-TW": "評分一致度" }, "over {n} co-rated": { "zh-TW": "(共 {n} 本都評過)" },
  "You both rated highly": { "zh-TW": "你們都給高分" }, "Taste clash": { "zh-TW": "品味分歧" },
  "them": { "zh-TW": "他" }, "you": { "zh-TW": "你" },
  "You": { "zh-TW": "我的評分" }, "Average": { "zh-TW": "平均" },
  // 書評人探索
  "Curators": { "zh-TW": "書評人" }, "Books": { "zh-TW": "書籍" },
  "Search curators...": { "zh-TW": "搜尋書評人…" },
  "No curators found": { "zh-TW": "找不到符合的書評人" }, "New reader": { "zh-TW": "新讀者" },
  "Load more": { "zh-TW": "載入更多" },
  // 登入
  "Find readers who read like you": { "zh-TW": "找到跟你閱讀同頻的人" },
  "Continue with Google": { "zh-TW": "使用 Google 繼續" }, "or continue with email": { "zh-TW": "或使用 Email 繼續" },
  "Sign In": { "zh-TW": "登入" }, "Create Account": { "zh-TW": "建立帳號" },
  "Username (e.g. Lena the lit omnivore)": { "zh-TW": "使用者名稱(例:文學雜食者 Lena)" }, "Email address": { "zh-TW": "Email 地址" },
  "Password": { "zh-TW": "密碼" }, "Confirm password": { "zh-TW": "確認密碼" }, "Forgot password?": { "zh-TW": "忘記密碼?" },
  // 動態字串(JS 用 t() 取)
  "Loading...": { "zh-TW": "載入中..." }, "{n} books": { "zh-TW": "{n} 本書" }, "{n} book": { "zh-TW": "{n} 本書" },
  "No reviews yet": { "zh-TW": "尚無評論" }, "📝 No reviews yet — be the first!": { "zh-TW": "📝 還沒有評論——當第一個!" },
  "{n} reviews": { "zh-TW": "{n} 則評論" }, "{n} review": { "zh-TW": "{n} 則評論" },
  "Your review": { "zh-TW": "你的評論" },
  "Compare your reviews": { "zh-TW": "比對你們的評論" },
  "Shared books with {name}": { "zh-TW": "和 {name} 的共同書" },
  "You": { "zh-TW": "你" }, "Not rated": { "zh-TW": "未評分" },
  "Rated only — no written review": { "zh-TW": "只給了分,沒寫評論" },
  "Hasn't reviewed this book": { "zh-TW": "還沒評論這本書" },
  "No shared books": { "zh-TW": "沒有共同書" },
  "Differ": { "zh-TW": "分歧" }, "Agree": { "zh-TW": "一致" },
  "Press back again to leave": { "zh-TW": "再按一次返回鍵即離開" },
  "Feedback": { "zh-TW": "意見回饋" },
  "What's New": { "zh-TW": "更新日誌" },
  "Recent updates to Concento.": { "zh-TW": "Concento 最近的更新。" },
  "Spotted a bug or have an idea? Tell us — we read every message.": { "zh-TW": "發現 bug 或有點子?跟我們說——每則我們都會看。" },
  "Send": { "zh-TW": "送出" },
  "Type your feedback…": { "zh-TW": "寫下你的意見…" },
  "Email (optional, if you want a reply)": { "zh-TW": "信箱(選填,想收到回覆再填)" },
  "Please write a bit more.": { "zh-TW": "再多寫一點吧。" },
  "Sending…": { "zh-TW": "送出中…" },
  "Thanks! Got it. 🙏": { "zh-TW": "收到了,謝謝!🙏" },
  "Failed to send — please try again.": { "zh-TW": "送出失敗,請再試一次。" },
  "Please wait {s}s before sending again.": { "zh-TW": "請等 {s} 秒再送出。" },
  "Thanks for all the feedback! Please come back later.": { "zh-TW": "感謝你的多則回饋!想再送請晚點再來。" },
  "No ratings yet": { "zh-TW": "尚無評分" }, "No books in the shared library yet": { "zh-TW": "共享書庫還沒有書" },
  "Failed to load": { "zh-TW": "載入失敗" }, "✓ Already on your shelf": { "zh-TW": "✓ 已在你的書架" },
  "Failed": { "zh-TW": "失敗" }, "Failed to save": { "zh-TW": "儲存失敗" },
  "Follow": { "zh-TW": "追蹤" }, "Following": { "zh-TW": "已追蹤" },
  "Back to Explore": { "zh-TW": "回探索" },
  "📰 Feed": { "zh-TW": "📰 動態" }, "All": { "zh-TW": "全部" },
  "No activity yet": { "zh-TW": "還沒有動態" }, "No activity from people you follow yet": { "zh-TW": "你追蹤的人還沒有動態" },
  "{name} reviewed {book}": { "zh-TW": "{name} 評論了《{book}》" },
  "{name} is now reading {book}": { "zh-TW": "{name} 正在讀《{book}》" },
  "{name} finished {book}": { "zh-TW": "{name} 讀完了《{book}》" },
  "Reply": { "zh-TW": "回覆" }, "Write a reply...": { "zh-TW": "寫回覆..." }, "Send": { "zh-TW": "送出" },
  "No replies yet": { "zh-TW": "還沒有回覆" },
  "💬 Book Club Discussion": { "zh-TW": "💬 讀書會討論" }, "Join the discussion...": { "zh-TW": "加入討論..." },
  "Be the first to start the discussion!": { "zh-TW": "搶第一個開始討論吧!" },
  "Chapter (e.g. 1-3 or 4-8)": { "zh-TW": "請填寫章節(範例:1-3或4-8)" }, "I've read up to:": { "zh-TW": "我讀到:" },
  "{n} comments": { "zh-TW": "{n}則討論" },
  "Please agree to the Terms of Use and Privacy Policy to continue.": { "zh-TW": "請先勾選同意使用者規範與隱私權政策。" },
  "— not started —": { "zh-TW": "— 還沒開始 —" }, "Whole book": { "zh-TW": "全書" },
  "Whole book (general)": { "zh-TW": "全書討論(未分章)" },
  "may contain spoilers — click to open": { "zh-TW": "可能含爆雷,點開查看" },
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
  "agree-terms": {
    "zh-TW": `我已閱讀並同意本站的 <a href="terms.html" target="_blank">使用者規範</a> 與 <a href="privacy.html" target="_blank">隱私權政策</a>。`
  },
  "ld-headline": {
    "zh-TW": `找到跟你<em>閱讀同頻</em>的人`
  },
  "ld-compat-demo": {
    "zh-TW": `<div class="cp-head"><span class="cp-title">與 阿哲 的閱讀相似度</span></div><div class="cp-facts"><div class="cp-row">📚 共同讀過 12 本 — Circe、Project Hail Mary、Klara and the Sun…</div><div class="cp-row">🎯 評分一致度:<b>86%</b>(共 9 本都評過)</div><div class="cp-row">🔥 你們都讀過冷門的:<b>Piranesi</b></div></div>`
  },
  "cover-upload-browse": {
    "zh-TW": `拖放圖片到此,或 <label for="coverFileInput" style="color:#5A7052;cursor:pointer;text-decoration:underline">點擊瀏覽</label>`
  },
  "cover-screenshot-note": {
    "zh-TW": `瀏覽器會詢問要分享哪個視窗/畫面。<br/>截取後,拖曳框選你要當封面的區域。`
  },
  "import-steps-gr": {
    "zh-TW": `<li>Goodreads → <strong>My Books</strong> → <strong>Import and export</strong></li><li>點 <strong>Export Library</strong>,下載 CSV 檔</li><li>在下方上傳 <code>.csv</code> 檔</li>`
  },
  "import-steps-notion": {
    "zh-TW": `<li>在 Notion 打開書籍資料庫 → <strong>⋯</strong> → <strong>Export</strong> → 格式選 <strong>CSV</strong></li><li>在下方上傳 <code>.csv</code> 檔</li>`
  },
  "import-steps-generic": {
    "zh-TW": `<li>任何逗號或 Tab 分隔的 CSV / TXT,至少要有 <code>Title / 書名</code> 欄位</li><li>選填欄位:作者、狀態、總頁數、類型、讀完日期、評分、Shelves…(中英欄名都認得)</li><li>用 Excel 整理的話,先另存成 <strong>CSV</strong>(不直接支援 .xls)</li>`
  },
  "import-steps-web": {
    "zh-TW": `<li>貼上任何<strong>公開</strong>書單頁面的網址(書店清單、願望清單…),頁面要含 <strong>ISBN</strong></li><li>頁面要登入才看得到?<strong>直接複製頁面內容</strong>(Ctrl+A、Ctrl+C)貼到下方文字框即可</li><li>每組 ISBN 都會驗證,並自動查書名/作者/封面——匯入前可先確認</li>`
  },
  "import-cols": {
    "zh-TW": `⚠️ 你的資料庫必須包含這些欄位:<br/><code>Title</code>、<code>Author</code>、<code>Status</code>、<code>Total Pages</code>、<code>Current Page</code>、<code>Genre</code>、<code>Date Finished</code>`
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

// 常見類型英文→中文「顯示」對照(資料底層仍存英文;不在表內的冷門/自創類型原樣顯示)
const GENRE_DICT = {
  "Fantasy": "奇幻", "Mystery": "推理", "Thriller": "驚悚", "Romance": "愛情",
  "Literary Fiction": "文學小說", "Historical Fiction": "歷史小說", "Historic": "歷史",
  "History": "歷史", "Sci-Fi": "科幻", "Science Fiction": "科幻", "Horror": "恐怖",
  "Myth": "神話", "Mythology": "神話", "Memoir": "回憶錄", "Biography": "傳記",
  "Self Growth": "自我成長", "Self-Help": "自我成長", "Anthropology": "人類學",
  "Philosophy": "哲學", "Poetry": "詩集", "Non-Fiction": "非虛構", "Nonfiction": "非虛構",
  "Fiction": "小說", "Classics": "經典", "Young Adult": "青少年", "Contemporary": "當代",
  "Graphic Novel": "圖像小說", "Dystopian": "反烏托邦", "Crime": "犯罪",
  "Business": "商業", "Psychology": "心理學",
};
function genreLabel(g) {
  if (!g) return "";
  if (currentLang === "en") return g;
  const k = g.trim();
  return GENRE_DICT[k] || g;
}

// ── 類型下拉(常用選項可用選的 + 保留自訂輸入)──
// value 一律存英文 key,genreLabel 負責顯示成當前語言,側欄 #genreFilter 也靠 key 維持一致
const COMMON_GENRES = ["Fiction","Literary Fiction","Fantasy","Sci-Fi","Mystery","Thriller",
  "Romance","Horror","Historical Fiction","History","Non-Fiction","Memoir","Biography",
  "Self-Help","Philosophy","Psychology","Poetry","Classics","Young Adult","Graphic Novel",
  "Crime","Dystopian","Business"];
function buildGenreSelect() {
  const sel = document.getElementById("bookGenreSelect");
  if (!sel) return;
  const keep = sel.value;
  const ph     = currentLang === "en" ? "Select genre…" : "選擇類型…";
  const custom = currentLang === "en" ? "✎ Custom…"     : "✎ 自訂…";
  sel.innerHTML = `<option value="">${ph}</option>`
    + COMMON_GENRES.map(g => `<option value="${escHtml(g)}">${escHtml(genreLabel(g))}</option>`).join("")
    + `<option value="__custom">${custom}</option>`;
  sel.value = keep;
}
// 依 #bookGenre 的實際值,把下拉與自訂框調到對的狀態(fillForm / 編輯 / 重置都用)
function syncGenreSelect(genre) {
  const sel = document.getElementById("bookGenreSelect");
  const inp = document.getElementById("bookGenre");
  if (!sel || !inp) return;
  const g = (genre || "").trim();
  if (g && COMMON_GENRES.includes(g)) { sel.value = g;          inp.style.display = "none"; }
  else if (g)                         { sel.value = "__custom"; inp.style.display = "";     }
  else                                { sel.value = "";         inp.style.display = "none"; }
}
(function wireGenreSelect() {
  const sel = document.getElementById("bookGenreSelect");
  const inp = document.getElementById("bookGenre");
  if (!sel || !inp) return;
  buildGenreSelect();
  sel.addEventListener("change", () => {
    if (sel.value === "__custom") { inp.style.display = ""; inp.value = ""; inp.focus(); }
    else { inp.value = sel.value; inp.style.display = "none"; }   // #bookGenre 永遠是存檔來源
  });
})();

// 翻譯靜態 DOM(葉節點文字 + placeholder),跳過動態書格與使用者資料
function translateStatic(lang) {
  // 含 HTML 標籤的整塊內容
  document.querySelectorAll("[data-i18n-html]").forEach(el => {
    const key = el.dataset.i18nHtml;
    if (!el.dataset.i18nOrig) el.dataset.i18nOrig = el.innerHTML;
    el.innerHTML = (lang !== "en" && HTML_DICT[key] && HTML_DICT[key][lang]) ? HTML_DICT[key][lang] : el.dataset.i18nOrig;
  });
  document.querySelectorAll("button, label, span, option, li, h1, h2, h3, p, div, a").forEach(el => {
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
  const ldBtn = document.getElementById("ldLangBtn");
  if (ldBtn) ldBtn.textContent = lang === "en" ? "中" : "EN";
  // 重新渲染含動態文字的可見區塊
  try {
    if (window.__fbSetPlaceholders) window.__fbSetPlaceholders();   // 回饋框 placeholder 跟著語言
    buildGenreSelect();   // 類型下拉選項跟著語言重標(保留當前選擇)
    if (allBooks.length) { rebuildSidebarFilters(); rebuildFormatFilter(); }
    if (currentView === "explore" && viewingPublicUid && lastPublicShelf) renderPublicShelfView();
    else if (currentView === "explore" && !viewingPublicUid) renderExplore();
    else renderGrid();
  } catch (e) {}
}

document.getElementById("langToggle").addEventListener("click", () =>
  setLang(currentLang === "en" ? "zh-TW" : "en"));
document.getElementById("ldLangBtn").addEventListener("click", () =>
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
  const profRef = db.collection("users").doc(targetUid);
  const inc = d => profRef.update({ followerCount: firebase.firestore.FieldValue.increment(d) }).catch(() => {});
  const snap = await meRef.get();
  if (snap.exists) {
    await meRef.delete();
    await themRef.delete().catch(() => {});
    inc(-1);   // 取消追蹤 → 對方 followerCount −1(窄規則允許;種子底數之上即時遞減)
    return false;
  }
  const ts = firebase.firestore.FieldValue.serverTimestamp();
  await meRef.set({ createdAt: ts });
  await themRef.set({ createdAt: ts, displayName: currentUser.displayName || "", tag: myTag(), photoURL: myPhoto() }).catch(() => {});
  inc(1);      // 追蹤 → 對方 followerCount +1
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
let feedCoverCache = {};   // bookKey -> 封面網址(""=查過但沒有,避免重複讀)

// 寫一筆公開動態事件
async function logActivity(type, book, extra) {
  if (!currentUser) return;
  try {
    await db.collection("activity").add({
      uid:         currentUser.uid,
      displayName: currentUser.displayName || (currentUser.email ? currentUser.email.split("@")[0] : "Reader"),
      tag:         myTag(),
      photoURL:    myPhoto(),
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
  // 舊事件沒存 bookCover → 從 catalog 補查封面(只讀不寫、結果快取、一輪最多 30 本)
  const missingKeys = [...new Set(
    items.filter(a => !a.bookCover && a.bookKey && feedCoverCache[a.bookKey] === undefined)
         .map(a => a.bookKey)
  )].slice(0, 30);
  if (missingKeys.length) {
    await Promise.all(missingKeys.map(async k => {
      try {
        const s = await db.collection("catalog").doc(k).get();
        feedCoverCache[k] = (s.exists && s.data().cover) || "";
      } catch (e) { feedCoverCache[k] = ""; }
    }));
  }
  list.innerHTML = items.map(a => {
    const initials = (a.displayName || "?").slice(0, 2).toUpperCase();
    const avatar = a.photoURL
      ? `<div class="feed-avatar" data-uid="${escHtml(a.uid)}"><img src="${escHtml(a.photoURL)}" alt=""></div>`
      : `<div class="feed-avatar" data-uid="${escHtml(a.uid)}">${escHtml(initials)}</div>`;
    const nameHtml = `<span class="feed-name" data-uid="${escHtml(a.uid)}">${escHtml(nameTag(a.displayName, a.tag))}</span>`;
    const bookHtml = `<span class="feed-book" data-key="${escHtml(a.bookKey)}">${escHtml(a.bookTitle || "")}</span>`;
    let line;
    if (a.type === "review")        line = t("{name} reviewed {book}", { name: nameHtml, book: bookHtml }) + (a.rating ? ` <span style="color:var(--gold)">${starsHTML(a.rating)}</span>` : "");
    else if (a.type === "now_reading") line = t("{name} is now reading {book}", { name: nameHtml, book: bookHtml });
    else if (a.type === "finished")    line = t("{name} finished {book}", { name: nameHtml, book: bookHtml });
    else line = `${nameHtml} · ${bookHtml}`;
    const date  = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().toLocaleDateString() : "";
    const coverUrl = a.bookCover || feedCoverCache[a.bookKey] || "";
    const cover = coverUrl ? `<img class="feed-cover" data-key="${escHtml(a.bookKey)}" ${coverAttrs(coverUrl)} alt="" referrerpolicy="no-referrer" onerror="if(window.__coverFallback(this))return; if(window.__retryProxy(this))return; this.style.display='none'">` : "";
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
        uid: currentUser.uid, displayName: myDisplayName(), tag: myTag(), photoURL: myPhoto(),
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
      <span class="reply-name clickable" data-uid="${escHtml(r.uid)}">${escHtml(nameTag(r.displayName, r.tag))}</span>
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
// 章節排序鍵:從標籤抓第一個數字 → 有數字依數字(第1-5章→1);空標籤=全書放最前;
// 沒數字的(結局/後記)沉到最後 = 最會爆雷的尾段。讓「自由標籤」也能排出前→後。
function discSectionOrder(label) {
  if (!label) return -Infinity;
  const m = String(label).match(/\d+/);
  return m ? parseInt(m[0]) : Infinity;
}

let discSections    = [];      // [{label, posts, order}] 已排序
let discReadUpToIdx = 0;       // 讀者目前讀到第幾段(含)展開,之後摺疊
let discCurrentKey  = null;

async function loadDiscussion(catalogKey) {
  const list = document.getElementById("discussionList");
  const progRow = document.getElementById("discProgressRow");
  if (!list) return;
  if (!catalogKey) { list.innerHTML = ""; if (progRow) progRow.style.display = "none"; return; }
  if (catalogKey !== discCurrentKey) { discReadUpToIdx = 0; discCurrentKey = catalogKey; }  // 換書重置進度
  list.innerHTML = `<div class="discussion-empty">${t("Loading...")}</div>`;
  let docs;
  try { docs = (await db.collection("catalog").doc(catalogKey).collection("discussion").orderBy("createdAt", "asc").get()).docs; }
  catch (e) { list.innerHTML = `<div class="discussion-empty">${t("Failed to load")}</div>`; if (progRow) progRow.style.display = "none"; return; }

  // 既有標籤 → datalist 建議(降低填法不一)
  const labelsUsed = [...new Set(docs.map(d => (d.data().section || "").trim()).filter(Boolean))]
                       .sort((a, b) => discSectionOrder(a) - discSectionOrder(b));
  const dl = document.getElementById("discSectionOptions");
  if (dl) dl.innerHTML = labelsUsed.map(l => `<option value="${escHtml(l)}">`).join("");

  if (!docs.length) {
    list.innerHTML = `<div class="discussion-empty">${t("Be the first to start the discussion!")}</div>`;
    if (progRow) progRow.style.display = "none";
    return;
  }

  // 依章節標籤分組
  const groups = new Map();
  docs.forEach(d => {
    const m = d.data();
    const label = (m.section || "").trim();
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ id: d.id, ...m });
  });
  discSections = [...groups.entries()]
    .map(([label, posts]) => ({ label, posts, order: discSectionOrder(label) }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

  // 進度下拉(只有多於一段才需要)
  if (progRow) {
    if (discSections.length > 1) {
      progRow.style.display = "";
      const sel = document.getElementById("discussionProgress");
      sel.innerHTML = `<option value="-1">${t("— not started —")}</option>` +
        discSections.map((s, i) => `<option value="${i}">${escHtml(s.label || t("Whole book"))}</option>`).join("");
      if (discReadUpToIdx >= discSections.length) discReadUpToIdx = 0;
      sel.value = String(discReadUpToIdx);
      sel.onchange = () => { discReadUpToIdx = parseInt(sel.value); renderDiscussionGroups(catalogKey); };
    } else {
      progRow.style.display = "none";
      discReadUpToIdx = 0;
    }
  }
  renderDiscussionGroups(catalogKey);
}

function discItemHtml(m) {
  const initials = (m.displayName || "?").slice(0, 2).toUpperCase();
  const date = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate().toLocaleDateString() : "";
  const mine = currentUser && m.uid === currentUser.uid;
  const avatar = m.photoURL
    ? `<div class="disc-avatar" data-uid="${escHtml(m.uid)}"><img src="${escHtml(m.photoURL)}" alt=""></div>`
    : `<div class="disc-avatar" data-uid="${escHtml(m.uid)}">${escHtml(initials)}</div>`;
  return `<div class="disc-item">
    ${avatar}
    <div class="disc-body">
      <div class="disc-head"><span class="disc-name clickable" data-uid="${escHtml(m.uid)}">${escHtml(nameTag(m.displayName, m.tag))}</span><span class="disc-date">${date}</span>${mine ? `<button class="disc-del" data-id="${m.id}" title="Delete">🗑</button>` : ""}</div>
      <div class="disc-text">${escHtml(m.text)}</div>
    </div>
  </div>`;
}

function renderDiscussionGroups(catalogKey) {
  const list = document.getElementById("discussionList");
  if (!list) return;
  list.innerHTML = discSections.map((s, i) => {
    const open   = i <= discReadUpToIdx;     // 後段預設摺疊
    const header = `${s.label || t("Whole book (general)")} · ${t("{n} comments", { n: s.posts.length })}`;
    const warn   = open ? "" : `<span class="disc-spoiler-warn">⚠️ ${t("may contain spoilers — click to open")}</span>`;
    const body   = s.posts.map(discItemHtml).join("");
    return `<div class="disc-group ${open ? "open" : ""}" data-idx="${i}">
      <div class="disc-group-head"><span class="disc-group-toggle">${open ? "▾" : "▸"}</span><span class="disc-group-label">📖 ${escHtml(header)}</span>${warn}</div>
      <div class="disc-group-body">${body}</div>
    </div>`;
  }).join("");
  // 點標頭摺疊/展開(覆寫預設)
  list.querySelectorAll(".disc-group-head").forEach(h => h.addEventListener("click", () => {
    const g = h.closest(".disc-group");
    g.classList.toggle("open");
    const tog = h.querySelector(".disc-group-toggle");
    if (tog) tog.textContent = g.classList.contains("open") ? "▾" : "▸";
    const w = h.querySelector(".disc-spoiler-warn");
    if (w && g.classList.contains("open")) w.remove();
  }));
  list.querySelectorAll(".disc-del").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    try { await db.collection("catalog").doc(catalogKey).collection("discussion").doc(b.dataset.id).delete(); loadDiscussion(catalogKey); } catch (e) {}
  }));
  list.querySelectorAll(".disc-name.clickable, .disc-avatar").forEach(n => n.addEventListener("click", (e) => {
    e.stopPropagation();
    if (n.dataset.uid) { detailModal.classList.remove("open"); loadPublicShelf(n.dataset.uid); }
  }));
}

async function sendDiscussion() {
  if (!currentUser) { alert(t("Please sign in first.")); return; }
  const input   = document.getElementById("discussionInput");
  const secInput = document.getElementById("discussionSection");
  const text    = input.value.trim();
  const section = (secInput?.value || "").trim();
  const key     = currentCatalogKey();
  if (!text || !key) return;
  const btn = document.getElementById("discussionSend");
  btn.disabled = true;
  try {
    await db.collection("catalog").doc(key).collection("discussion").add({
      uid: currentUser.uid, displayName: myDisplayName(), tag: myTag(), photoURL: myPhoto(),
      text, section, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    input.value = "";   // 保留 section,方便連續發同章節
    await loadDiscussion(key);
  } catch (e) { alert(t("Failed") + ": " + e.message); }
  btn.disabled = false;
}
document.getElementById("discussionSend").addEventListener("click", sendDiscussion);
document.getElementById("discussionInput").addEventListener("keydown", e => { if (e.key === "Enter") sendDiscussion(); });

// ══════════════════════════════════════════
//  #7 返回鍵管理:上一頁/手機左滑 = 關掉最上層彈窗(而非離站)
//  作法:把開著的彈窗(.modal-overlay/.bsr-overlay/抽屜)數量「鏡射」成 history 深度。
//  - 開一個 → pushState 一筆;按上一頁 → popstate 關掉最上層;程式關掉 → 自動撤掉對應筆。
//  - 用「對賬(reconcile)」而非逐一掛鉤 → 換頁(詳情→編輯,一關一開)淨深度不變,不會亂跳。
//  - 根部什麼都沒開時按上一頁 → 顯示「再按一次離開」提示(不綁秒數),再按才放行離站。
//  排除:verifyModal(信箱驗證 gate)、內嵌封面裁切器。
// ══════════════════════════════════════════
(function setupBackButton() {
  const body = document.body;
  // 受監看的「層」:每個有 isOpen()/close() 的彈窗或抽屜
  const watched = [];
  document.querySelectorAll(".modal-overlay, .bsr-overlay").forEach(el => {
    if (el.id === "verifyModal") return;
    watched.push({ el, isOpen: () => el.classList.contains("open"), close: () => el.classList.remove("open") });
  });
  // 手機抽屜(body.side-open)
  watched.push({ el: body, drawer: true, isOpen: () => body.classList.contains("side-open"), close: () => body.classList.remove("side-open") });
  // 「不在書架」(探索/動態)也當一層 → 按上一頁先回我的書架,不直接離站
  watched.push({ view: true, el: body, isOpen: () => typeof currentView !== "undefined" && !!currentView && currentView !== "shelf",
                 close: () => { if (typeof switchView === "function") switchView("shelf"); } });

  let stack = [];          // 目前開著的層(LIFO)
  let histDepth = 0;       // 已 push 的 history 筆數(=層數)
  let ignorePop = 0;       // 接下來要忽略幾次 popstate(來自我們自己的 history.go)
  let exitArmed = false;
  let queued = false;

  function openLayers() { return watched.filter(w => w.isOpen()); }

  function reconcile() {
    queued = false;
    const open = openLayers();
    // 保留仍開著的(維持原順序),補上新開的
    const still = stack.filter(s => open.includes(s));
    open.forEach(w => { if (!still.includes(w)) still.push(w); });
    stack = still;
    const target = stack.length;
    if (target > histDepth) {
      while (histDepth < target) { histDepth++; try { history.pushState({ cdDepth: histDepth }, ""); } catch (e) {} }
      exitArmed = false; hideExitHint();
    } else if (target < histDepth) {
      const delta = histDepth - target;
      histDepth = target;
      ignorePop += delta;
      try { history.go(-delta); } catch (e) { ignorePop -= delta; }
    }
  }
  function schedule() { if (!queued) { queued = true; Promise.resolve().then(reconcile); } }

  watched.forEach(w => {
    new MutationObserver(schedule).observe(w.el, { attributes: true, attributeFilter: ["class"] });
  });

  window.addEventListener("popstate", () => {
    if (ignorePop > 0) { ignorePop--; return; }
    if (histDepth > 0) {            // 有彈窗開著 → 關最上層,人留在站內
      histDepth--;
      const top = stack.pop();
      if (top) { try { top.close(); } catch (e) {} }   // 移除 .open → 觀察器 reconcile(target 已等於 histDepth,無動作)
      return;
    }
    // 根部:第一次按 → 武裝+提示+留下;第二次按 → 放行離站
    if (!exitArmed) {
      exitArmed = true;
      showExitHint();
      try { history.pushState({ cdRoot: true }, ""); } catch (e) {}
    } else {
      exitArmed = false; hideExitHint();
      try { history.back(); } catch (e) {}
    }
  });

  // 載入時壓一筆 sentinel,讓第一次「上一頁」有東西可退、不直接離站
  try { history.pushState({ cdRoot: true }, ""); } catch (e) {}
  window.__backReconcile = schedule;   // 換頁(switchView/loadPublicShelf)時呼叫,同步「探索層」
})();

function showExitHint() {
  let el = document.getElementById("exitHint");
  if (!el) { el = document.createElement("div"); el.id = "exitHint"; el.className = "exit-hint"; document.body.appendChild(el); }
  el.textContent = t("Press back again to leave");
  el.classList.add("show");
}
function hideExitHint() {
  const el = document.getElementById("exitHint");
  if (el) el.classList.remove("show");
}

// ── 意見回饋小工具:寫進 Firestore feedback/(Telegram 推播由本機 watcher 接;見 PROJECT_CONTEXT)──
(function setupFeedback() {
  const fab = document.getElementById("feedbackFab");
  const modal = document.getElementById("feedbackModal");
  const closeBtn = document.getElementById("feedbackClose");
  const textEl = document.getElementById("feedbackText");
  const emailEl = document.getElementById("feedbackEmail");
  const sendBtn = document.getElementById("feedbackSend");
  const statusEl = document.getElementById("feedbackStatus");
  if (!fab || !modal) return;

  function setPlaceholders() {
    textEl.placeholder = t("Type your feedback…");
    emailEl.placeholder = t("Email (optional, if you want a reply)");
  }
  setPlaceholders();
  window.__fbSetPlaceholders = setPlaceholders;   // 供 setLang 切語言時重設 placeholder

  // 觸發鈕在左側欄;開啟時順手收起手機抽屜,modal z-index 已壓過抽屜
  const open  = () => { document.body.classList.remove("side-open"); modal.classList.add("open"); textEl.focus(); };
  const close = () => modal.classList.remove("open");
  fab.addEventListener("click", () => modal.classList.contains("open") ? close() : open());
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && modal.classList.contains("open")) close(); });
  modal.addEventListener("click", e => { if (e.target.id === "feedbackModal") close(); });   // 點背景遮罩關閉

  // 前端冷卻:擋手滑連送與隨手洗版(真正的防灌爆在 watcher 端節流)
  let lastSent = 0, sentCount = 0;
  const FB_COOLDOWN_MS = 15000, FB_MAX_PER_SESSION = 12;

  sendBtn.addEventListener("click", async () => {
    const text = textEl.value.trim();
    statusEl.className = "fb-status";
    if (text.length < 3) { statusEl.textContent = t("Please write a bit more."); statusEl.classList.add("err"); return; }
    if (sentCount >= FB_MAX_PER_SESSION) {
      statusEl.textContent = t("Thanks for all the feedback! Please come back later."); statusEl.classList.add("err"); return;
    }
    const since = Date.now() - lastSent;
    if (lastSent && since < FB_COOLDOWN_MS) {
      statusEl.textContent = t("Please wait {s}s before sending again.").replace("{s}", Math.ceil((FB_COOLDOWN_MS - since) / 1000));
      statusEl.classList.add("err"); return;
    }
    sendBtn.disabled = true; statusEl.textContent = t("Sending…");
    try {
      await db.collection("feedback").add({
        text: text.slice(0, 3000),
        email: (emailEl.value || "").trim().slice(0, 200) || null,
        uid: (currentUser && currentUser.uid) || null,
        displayName: (currentUser && (currentUser.displayName || currentUser.email)) || null,
        page: (typeof currentView !== "undefined" && currentView) || "landing",
        lang: currentLang,
        userAgent: navigator.userAgent.slice(0, 300),
        url: location.href.slice(0, 300),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      lastSent = Date.now(); sentCount++;
      statusEl.textContent = t("Thanks! Got it. 🙏"); statusEl.classList.add("ok");
      textEl.value = "";
      setTimeout(() => { close(); statusEl.textContent = ""; statusEl.className = "fb-status"; }, 1600);
    } catch (e) {
      statusEl.textContent = t("Failed to send — please try again."); statusEl.classList.add("err");
    }
    sendBtn.disabled = false;
  });
})();

// ── 更新日誌:資料驅動。新增更新 → 在最上面加一個 { date, zh:[...], en:[...] } 即可 ──
const CHANGELOG = [
  { date: "2026-06-26", zh: [
      "書本可標記「版本」:實體書 / 電子書 / 有聲書 / 借閱,並能依版本篩選",
      "書架新增「依閱讀狀態」排序,設定會跨裝置記住",
      "標上閱讀進度(頁數或 %)會自動把書轉成「正在閱讀」",
      "可把網站加到手機主畫面,像 App 一樣開啟",
      "介面細修:搜尋框可一鍵清除、版本篩選改成固定順序",
    ], en: [
      "Tag each book's format — physical, ebook, audiobook, or borrowed — and filter by it",
      "New “by reading status” shelf sort, remembered across your devices",
      "Logging progress (pages or %) now auto-moves a book to “Now Reading”",
      "Add the site to your phone home screen and open it like an app",
      "Polish: one-tap clear in the search box, and a fixed order for the format filter",
    ] },
  { date: "2026-06-16", zh: [
      "公開書架改版:把「閱讀相似度」和個人資料整合成一條精簡的頂部資訊",
      "修正公開書架的封面縮放",
    ], en: [
      "Public shelves: reading-similarity and profile merged into one compact header",
      "Fixed cover zoom on public shelves",
    ] },
  { date: "2026-06-15", zh: [
      "個人檔案:自訂頭像、自介、#識別碼、年度最愛書、Discord",
      "從別人的書架點頭像,就能看對方的唯讀個人檔案(含 Discord 隱私開關)",
    ], en: [
      "Profiles: custom avatar, bio, #handle, favorite book of the year, Discord",
      "Tap an avatar on someone's shelf to view their read-only profile (with a Discord privacy switch)",
    ] },
  { date: "2026-06-14", zh: [
      "讀完一本書會跳出評分與評論邀請",
      "評論區重排:自己的評論置頂",
      "Google 登入改用自有網域 auth.concento.io",
    ], en: [
      "Finishing a book now invites you to rate and review it",
      "Reviews reordered so your own review sits on top",
      "Google sign-in now uses our own domain, auth.concento.io",
    ] },
  { date: "2026-06-13", zh: [
      "手機版大改版:側欄收進漢堡選單,各種手機都不再爆出畫面",
    ], en: [
      "Big mobile revamp: sidebar tucked into a hamburger menu, no more overflow on any phone",
    ] },
  { date: "2026-06-12", zh: [
      "探索頁:瀏覽書評人、依類型篩選",
      "匯入中心改版:支援 Goodreads、通用 CSV、網頁 ISBN 多來源匯入",
    ], en: [
      "Explore page: browse reviewers and filter by genre",
      "Revamped import center: Goodreads, generic CSV, and web-page ISBN sources",
    ] },
  { date: "2026-06-11", zh: [
      "桌面書架改成橫向書牆,可拖曳與滾輪翻頁",
    ], en: [
      "Desktop shelf became a horizontal book wall with drag and scroll paging",
    ] },
];
(function setupChangelog() {
  const fab = document.getElementById("changelogFab");
  const modal = document.getElementById("changelogModal");
  const closeBtn = document.getElementById("changelogClose");
  const list = document.getElementById("changelogList");
  if (!fab || !modal || !list) return;

  function render() {
    const lang = currentLang === "zh-TW" ? "zh" : "en";
    list.innerHTML = CHANGELOG.map(e => {
      const items = (e[lang] || e.en).map(s => `<li>${escHtml(s)}</li>`).join("");
      return `<div class="cl-entry"><div class="cl-date">${escHtml(e.date)}</div><ul class="cl-items">${items}</ul></div>`;
    }).join("");
  }
  const open  = () => { document.body.classList.remove("side-open"); render(); modal.classList.add("open"); };
  const close = () => modal.classList.remove("open");
  fab.addEventListener("click", () => modal.classList.contains("open") ? close() : open());
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && modal.classList.contains("open")) close(); });
  modal.addEventListener("click", e => { if (e.target.id === "changelogModal") close(); });   // 點背景遮罩關閉
})();

// ── PWA「加到主畫面」提示(Android 一鍵安裝 / iOS Safari 給手動步驟)──
(function setupInstallHint() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone) return;                                         // 已在 App 模式 → 不提示
  if (localStorage.getItem("installHintDismissed") === "1") return;
  if (!window.matchMedia("(max-width: 600px)").matches) return;   // 只在手機提示

  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isiOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|GSA/.test(ua);
  let deferred = null, banner = null;

  function build(mode) {
    if (banner) return;
    const zh = (typeof currentLang !== "undefined" && currentLang !== "en");
    const title = zh ? "把 Concento 加到主畫面" : "Add Concento to your home screen";
    const sub = mode === "ios"
      ? (zh ? "點下方 分享 ⬆ → 加入主畫面" : "Tap Share ⬆ → Add to Home Screen")
      : (zh ? "像 App 一樣一鍵打開" : "Open it like an app");
    banner = document.createElement("div");
    banner.className = "install-hint";
    banner.innerHTML =
      `<img src="icon-192.png" alt="" class="ih-icon"/>` +
      `<div class="ih-txt"><b>${title}</b><span>${sub}</span></div>` +
      (mode === "android" ? `<button class="ih-go" type="button">${zh ? "安裝" : "Install"}</button>` : "") +
      `<button class="ih-x" type="button" aria-label="close">✕</button>`;
    document.body.appendChild(banner);
    banner.querySelector(".ih-x").addEventListener("click", dismiss);
    const go = banner.querySelector(".ih-go");
    if (go) go.addEventListener("click", async () => {
      if (!deferred) return dismiss();
      deferred.prompt();
      try { await deferred.userChoice; } catch (_) {}
      deferred = null; dismiss();
    });
    requestAnimationFrame(() => banner.classList.add("show"));
  }
  function dismiss() {
    localStorage.setItem("installHintDismissed", "1");
    if (banner) { banner.classList.remove("show"); setTimeout(() => banner && banner.remove(), 320); }
  }

  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; build("android"); });
  if (isiOSSafari) setTimeout(() => build("ios"), 2500);   // iOS 沒有 beforeinstallprompt
})();

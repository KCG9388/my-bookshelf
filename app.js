// ── Firebase Init ──
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const booksCol = db.collection("books");

// ── State ──
let allBooks = [];
let currentFilter = { status: "all", year: "all", genre: "all", search: "" };
let currentDetailId = null;

// ── DOM ──
const bookGrid       = document.getElementById("bookGrid");
const bookCountEl    = document.getElementById("bookCount");
const searchInput    = document.getElementById("searchInput");
const addModal       = document.getElementById("addModal");
const detailModal    = document.getElementById("detailModal");
const fetchStatus    = document.getElementById("fetchStatus");
const coverPreview   = document.getElementById("coverPreview");

// ── Realtime listener ──
booksCol.orderBy("createdAt", "desc").onSnapshot(snapshot => {
  allBooks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  rebuildSidebarFilters();
  renderGrid();
});

// ── Render ──
function renderGrid() {
  const { status, year, genre, search } = currentFilter;
  let books = allBooks.filter(b => {
    if (status !== "all" && b.status !== status) return false;
    if (year !== "all" && String(b.startYear) !== year) return false;
    if (genre !== "all" && (b.genre || "").toLowerCase() !== genre.toLowerCase()) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(b.title || "").toLowerCase().includes(q) && !(b.author || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  bookCountEl.textContent = `${books.length} book${books.length !== 1 ? "s" : ""}`;

  if (books.length === 0) {
    bookGrid.innerHTML = `<div class="empty-state">No books found.</div>`;
    return;
  }

  bookGrid.innerHTML = books.map(b => {
    const pct = calcPct(b.currentPage, b.totalPages);
    const coverHTML = b.cover
      ? `<img src="${escHtml(b.cover)}" alt="${escHtml(b.title)}" onerror="this.parentElement.innerHTML='<div class=no-cover>📖</div>'" />`
      : `<div class="no-cover">📖</div>`;
    return `
      <div class="book-card" data-id="${b.id}">
        <div class="book-cover">${coverHTML}</div>
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
  const years = [...new Set(allBooks.map(b => b.startYear).filter(Boolean))].sort((a,b) => b-a);
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
  renderGrid();
});

// ── Add Modal ──
document.getElementById("openAddModal").addEventListener("click", () => openAddModal());
document.getElementById("closeAddModal").addEventListener("click", closeAddModal);
document.getElementById("cancelAdd").addEventListener("click", closeAddModal);

function openAddModal(prefill) {
  resetAddForm();
  if (prefill) fillForm(prefill);
  addModal.classList.add("open");
}
function closeAddModal() { addModal.classList.remove("open"); }

addModal.addEventListener("click", e => { if (e.target === addModal) closeAddModal(); });

// ── Fetch book info ──
document.getElementById("fetchBookBtn").addEventListener("click", fetchBookInfo);
document.getElementById("bookSearchInput").addEventListener("keydown", e => { if (e.key === "Enter") fetchBookInfo(); });

async function fetchBookInfo() {
  const query = document.getElementById("bookSearchInput").value.trim();
  if (!query) return;
  fetchStatus.textContent = "Searching...";

  const isISBN = /^[\d\-X]{10,17}$/.test(query.replace(/\s/g, ""));
  const cleanISBN = query.replace(/[\s\-]/g, "");

  // 1. Open Library by ISBN
  if (isISBN) {
    try {
      const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${cleanISBN}&format=json&jscmd=data`);
      const data = await res.json();
      const key = `ISBN:${cleanISBN}`;
      if (data[key]) {
        const info = data[key];
        const cover = info.cover ? (info.cover.large || info.cover.medium || info.cover.small || "") : "";
        const authors = (info.authors || []).map(a => a.name).join(", ");
        const subjects = (info.subjects || []).map(s => s.name || s).slice(0, 2).join(", ");
        fillForm({ title: info.title || "", author: authors, genre: subjects, totalPages: info.number_of_pages || "", cover });
        fetchStatus.textContent = `Found: "${info.title}"`;
        return;
      }
    } catch {}
  }

  // 2. Open Library by title/author search
  try {
    const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=1`);
    const data = await res.json();
    if (data.docs && data.docs.length > 0) {
      const doc = data.docs[0];
      const coverId = doc.cover_i;
      const cover = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "";
      const authors = (doc.author_name || []).slice(0, 2).join(", ");
      const subjects = (doc.subject || []).slice(0, 2).join(", ");
      fillForm({ title: doc.title || "", author: authors, genre: subjects, totalPages: doc.number_of_pages_median || "", cover });
      fetchStatus.textContent = `Found: "${doc.title}"`;
      return;
    }
  } catch {}

  fetchStatus.textContent = "No results found. Fill in manually.";
}

function fillForm({ title="", author="", genre="", totalPages="", cover="" } = {}) {
  if (title)      document.getElementById("bookTitle").value = title;
  if (author)     document.getElementById("bookAuthor").value = author;
  if (genre)      document.getElementById("bookGenre").value = genre;
  if (totalPages) document.getElementById("bookTotalPages").value = totalPages;
  if (cover) {
    document.getElementById("coverUrl").value = cover;
    coverPreview.innerHTML = `<img src="${escHtml(cover)}" alt="cover" onerror="this.parentElement.innerHTML='<span>No Cover</span>'" />`;
  }
}

document.getElementById("coverUrl").addEventListener("input", e => {
  const url = e.target.value.trim();
  coverPreview.innerHTML = url
    ? `<img src="${escHtml(url)}" alt="cover" onerror="this.parentElement.innerHTML='<span>No Cover</span>'" />`
    : `<span>No Cover</span>`;
});

function resetAddForm() {
  ["bookSearchInput","bookTitle","bookAuthor","bookGenre","bookCurrentPage","bookStartDate","bookFinishDate","bookNotes","coverUrl"]
    .forEach(id => document.getElementById(id).value = "");
  document.getElementById("bookTotalPages").value = "";
  document.getElementById("bookStatus").value = "Want to Read";
  coverPreview.innerHTML = `<span>No Cover</span>`;
  fetchStatus.textContent = "";
}

// ── Save book ──
document.getElementById("saveBook").addEventListener("click", async () => {
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
    createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
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

// ── Detail Modal ──
function openDetail(id) {
  currentDetailId = id;
  const b = allBooks.find(x => x.id === id);
  if (!b) return;

  document.getElementById("detailTitle").textContent = b.title;
  document.getElementById("detailAuthor").textContent = b.author || "";
  document.getElementById("detailGenre").textContent = b.genre || "";

  const statusEl = document.getElementById("detailStatus");
  statusEl.innerHTML = `<span class="status-badge status-${escHtml(b.status)}">${escHtml(b.status)}</span>`;

  const pct = calcPct(b.currentPage, b.totalPages);
  document.getElementById("detailProgressBar").style.width = pct !== null ? pct + "%" : "0%";
  document.getElementById("detailProgressText").textContent = pct !== null
    ? `${b.currentPage || 0} / ${b.totalPages} pages (${pct}%)`
    : "No page info";

  document.getElementById("detailCurrentPage").value = b.currentPage || 0;
  document.getElementById("detailTotalPages").textContent = `/ ${b.totalPages || "?"} pages`;

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
}

document.getElementById("closeDetailModal").addEventListener("click", () => detailModal.classList.remove("open"));
detailModal.addEventListener("click", e => { if (e.target === detailModal) detailModal.classList.remove("open"); });

document.getElementById("updatePageBtn").addEventListener("click", async () => {
  if (!currentDetailId) return;
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
  openAddModal({
    title: b.title, author: b.author, genre: b.genre,
    totalPages: b.totalPages, cover: b.cover,
  });
  document.getElementById("bookCurrentPage").value  = b.currentPage || 0;
  document.getElementById("bookStatus").value        = b.status || "Want to Read";
  document.getElementById("bookStartDate").value     = b.startDate || "";
  document.getElementById("bookFinishDate").value    = b.finishDate || "";
  document.getElementById("bookNotes").value         = b.notes || "";
  document.querySelector("#addModal .modal-header h2").textContent = "Edit Book";
});

document.getElementById("deleteBookBtn").addEventListener("click", async () => {
  if (!currentDetailId) return;
  if (!confirm("Delete this book?")) return;
  await booksCol.doc(currentDetailId).delete();
  detailModal.classList.remove("open");
});

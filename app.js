// ── Firebase Init ──
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const booksCol = db.collection("books");

// ── State ──
let allBooks = [];
let currentFilter = { status: "all", year: "all", genre: "all", search: "" };
let currentDetailId = null;
const PAGE_SIZE = 24;
let currentPage = 1;

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
function filterBooks() {
  const { status, year, genre, search } = currentFilter;
  return allBooks.filter(b => {
    if (status !== "all" && b.status !== status) return false;
    if (year !== "all" && String(b.startYear) !== year) return false;
    if (genre !== "all" && (b.genre || "").toLowerCase() !== genre.toLowerCase()) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(b.title || "").toLowerCase().includes(q) && !(b.author || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });
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

  const pages = [];
  // always show first, last, current ±2
  const show = new Set([1, totalPages, currentPage, currentPage-1, currentPage+1, currentPage-2, currentPage+2].filter(p => p >= 1 && p <= totalPages));
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

// ── Refresh Button ──
document.getElementById("refreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spinning");
  // Queue all books missing covers
  const missing = allBooks.filter(b => !b.cover);
  if (missing.length) {
    queueCoverFetch(missing);
  } else {
    // just re-render
    renderGrid();
    rebuildSidebarFilters();
  }
  setTimeout(() => btn.classList.remove("spinning"), 800);
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

  // 2. Google Books (with API key, good Chinese support)
  try {
    const apiQuery = isISBN ? `isbn:${cleanISBN}` : encodeURIComponent(query);
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${apiQuery}&maxResults=1&key=${GBOOKS_KEY}`);
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      const info = data.items[0].volumeInfo;
      const cover = info.imageLinks
        ? (info.imageLinks.extraLarge || info.imageLinks.large || info.imageLinks.thumbnail || "").replace("http://", "https://")
        : "";
      fillForm({ title: info.title || "", author: (info.authors || []).join(", "), genre: (info.categories || []).join(", "), totalPages: info.pageCount || "", cover });
      fetchStatus.textContent = `Found: "${info.title}"`;
      return;
    }
  } catch {}

  // 3. Open Library by title/author search
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

// Re-fetch cover button
document.getElementById("refetchCoverBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refetchCoverBtn");
  const title  = document.getElementById("bookTitle").value.trim();
  const author = document.getElementById("bookAuthor").value.trim();
  if (!title) { alert("Please enter a title first."); return; }
  btn.classList.add("loading");
  btn.disabled = true;
  const cover = await fetchCoverUrl(title, author);
  btn.classList.remove("loading");
  btn.disabled = false;
  if (cover) {
    document.getElementById("coverUrl").value = cover;
    coverPreview.innerHTML = `<img src="${escHtml(cover)}" alt="cover" onerror="this.parentElement.innerHTML='<span>No Cover</span>'" />`;
  } else {
    alert("No cover found. Try editing the title/author and search again, or paste a URL manually.");
  }
});

// Upload cover image
document.getElementById("coverFileInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const dataUrl = ev.target.result;
    document.getElementById("coverUrl").value = dataUrl;
    coverPreview.innerHTML = `<img src="${escHtml(dataUrl)}" alt="cover" />`;
  };
  reader.readAsDataURL(file);
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

// ── Import Modal ──
const importModal   = document.getElementById("importModal");
const importFileInput = document.getElementById("importFileInput");
const importDropZone  = document.getElementById("importDropZone");
const startImportBtn  = document.getElementById("startImportBtn");
let parsedBooks = [];

document.getElementById("openImportModal").addEventListener("click", () => {
  resetImport();
  importModal.classList.add("open");
});
document.getElementById("closeImportModal").addEventListener("click", closeImport);
document.getElementById("cancelImport").addEventListener("click", closeImport);
importModal.addEventListener("click", e => { if (e.target === importModal) closeImport(); });

function closeImport() { importModal.classList.remove("open"); resetImport(); }

function resetImport() {
  parsedBooks = [];
  importFileInput.value = "";
  document.getElementById("importPreview").style.display = "none";
  document.getElementById("importProgress").style.display = "none";
  document.getElementById("importDropZone").style.display = "";
  importDropZone.innerHTML = `<div class="upload-icon">📂</div><div class="upload-text">Drag &amp; drop your CSV file here<br/><span>or click to browse</span></div><input type="file" id="importFileInput" accept=".csv" style="display:none" />`;
  bindFileInput();
  startImportBtn.disabled = true;
  startImportBtn.textContent = "Import Books";
}

function bindFileInput() {
  const fi = document.getElementById("importFileInput");
  importDropZone.addEventListener("click", () => fi.click());
  fi.addEventListener("change", e => handleFile(e.target.files[0]));
  importDropZone.addEventListener("dragover", e => { e.preventDefault(); importDropZone.classList.add("drag-over"); });
  importDropZone.addEventListener("dragleave", () => importDropZone.classList.remove("drag-over"));
  importDropZone.addEventListener("drop", e => {
    e.preventDefault();
    importDropZone.classList.remove("drag-over");
    handleFile(e.dataTransfer.files[0]);
  });
}
bindFileInput();

function handleFile(file) {
  if (!file || !file.name.endsWith(".csv")) {
    alert("Please upload a .csv file exported from Notion.");
    return;
  }
  const reader = new FileReader();
  reader.onload = e => parseNotionCSV(e.target.result, file.name);
  reader.readAsText(file, "UTF-8");
}

function parseNotionCSV(text, filename) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) { alert("CSV appears empty."); return; }

  const headers = parseCSVRow(lines[0]).map(h => h.trim().toLowerCase());

  // flexible column mapping
  const col = name => {
    const aliases = {
      title:       ["title"],
      author:      ["author", " author"],
      genre:       ["genre"],
      status:      ["status"],
      currentpage: ["current page", "currentpage", "current_page"],
      totalpages:  ["total pages", "totalpages", "total_pages"],
      finishdate:  ["date finished", "finish date", "finishdate", "date_finished"],
      startdate:   ["date started", "start date", "startdate", "date_started"],
      rating:      ["rate", "rating"],
    };
    const list = aliases[name] || [name];
    for (const a of list) {
      const i = headers.indexOf(a);
      if (i !== -1) return i;
    }
    return -1;
  };

  if (col("title") === -1) {
    alert("Could not find a 'Title' column. Make sure you exported the correct Notion database.");
    return;
  }

  parsedBooks = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVRow(lines[i]);
    const get = name => (cells[col(name)] || "").trim();

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
      finishDate,
      startDate,
      startYear:   startYear || finishYear || new Date().getFullYear(),
      cover:       "",
      notes,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  showPreview(filename);
}

function cleanNotionCell(str) {
  if (!str) return "";
  // Remove Notion internal links: "Text (https://app.notion.com/...)"
  return str.replace(/\s*\(https?:\/\/[^)]+\)/g, "").trim();
}

function parseNotionDate(str) {
  if (!str) return "";
  const d = new Date(str);
  if (isNaN(d)) return "";
  return d.toISOString().split("T")[0];
}

function parseCSVRow(line) {
  const result = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur); cur = "";
    } else {
      cur += ch;
    }
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
  const table = document.getElementById("previewTable");
  table.innerHTML = `
    <thead><tr><th>Title</th><th>Author</th><th>Genre</th><th>Status</th><th>Pages</th></tr></thead>
    <tbody>${sample.map(b => `<tr>
      <td title="${b.title}">${b.title}</td>
      <td title="${b.author}">${b.author}</td>
      <td>${b.genre}</td>
      <td>${b.status}</td>
      <td>${b.totalPages || "—"}</td>
    </tr>`).join("")}
    ${parsedBooks.length > 5 ? `<tr><td colspan="5" style="color:#9b9a97;text-align:center">... and ${parsedBooks.length - 5} more</td></tr>` : ""}
    </tbody>`;

  preview.style.display = "";
  startImportBtn.disabled = false;
}

// ── Background Cover Fetcher ──
const GBOOKS_KEY = "AIzaSyBBMm9HLyzazJ3HzWIA7hCc3ehNYV_qxUQ";
let coverFetchQueue = [];
let coverFetchRunning = false;

const toast     = document.getElementById("coverFetchToast");
const toastFill = document.getElementById("toastFill");
const toastLabel= document.getElementById("toastLabel");
document.getElementById("toastClose").addEventListener("click", () => toast.classList.remove("visible"));

function queueCoverFetch(books) {
  const noCover = books.filter(b => !b.cover && b.title);
  if (!noCover.length) return;
  coverFetchQueue.push(...noCover.map(b => ({ id: b.id, title: b.title, author: b.author || "" })));
  if (!coverFetchRunning) runCoverFetch();
}

async function runCoverFetch() {
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
    toastFill.style.width = pct + "%";
    toastLabel.textContent = `${done} / ${total} — ${item.title}`;
    await new Promise(r => setTimeout(r, 350));
  }

  toastLabel.textContent = `✓ Finished updating covers!`;
  toastFill.style.width = "100%";
  setTimeout(() => toast.classList.remove("visible"), 3500);
  coverFetchRunning = false;
}

async function fetchCoverUrl(title, author) {
  try {
    const q = encodeURIComponent(`${title} ${author}`.trim());
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1&key=${GBOOKS_KEY}`);
    const data = await res.json();
    if (data.items?.[0]?.volumeInfo?.imageLinks) {
      const imgs = data.items[0].volumeInfo.imageLinks;
      return (imgs.extraLarge || imgs.large || imgs.thumbnail || "").replace("http://", "https://");
    }
  } catch {}
  try {
    const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(title)}&limit=1`);
    const data = await res.json();
    const coverId = data.docs?.[0]?.cover_i;
    if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
  } catch {}
  return "";
}

startImportBtn.addEventListener("click", async () => {
  if (!parsedBooks.length) return;
  startImportBtn.disabled = true;
  document.getElementById("importPreview").style.display = "none";
  document.getElementById("importDropZone").style.display = "none";

  const progressEl = document.getElementById("importProgress");
  const fillEl     = document.getElementById("importProgressFill");
  const labelEl    = document.getElementById("importProgressLabel");
  const logEl      = document.getElementById("importLog");
  progressEl.style.display = "";

  // Build existing title set for deduplication
  const existingTitles = new Set(allBooks.map(b => b.title.trim().toLowerCase()));

  let success = 0, skipped = 0, failed = 0;
  for (let i = 0; i < parsedBooks.length; i++) {
    const pct = Math.round(((i + 1) / parsedBooks.length) * 100);
    fillEl.style.width = pct + "%";
    labelEl.textContent = `Importing ${i + 1} / ${parsedBooks.length}...`;
    const book = parsedBooks[i];

    // Duplicate check
    if (existingTitles.has(book.title.trim().toLowerCase())) {
      skipped++;
      const line = document.createElement("div");
      line.style.color = "#9b9a97";
      line.textContent = `— skipped (duplicate): ${book.title}`;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
      continue;
    }

    try {
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
  startImportBtn.disabled = false;
  startImportBtn.onclick = () => { closeImport(); queueCoverFetch(allBooks); };
});

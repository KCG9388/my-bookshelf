/* 純邏輯單元測試(不需瀏覽器、不碰 Firebase):
 * 從 app.js 用正則抽出頂層函式,丟進 vm 沙箱跑。跑法:node tests/unit_isbn.js
 * 涵蓋:normIsbn13 / sameTitle / normTitleKey / rarityWeight / Goodreads+通用 CSV 的 ISBN 欄 / 匯入去重規則
 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// 抽頂層 function 宣告:從 "function name(" 到下一個位於行首的 "}"
function grab(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error("找不到函式 " + name);
  const start = src.lastIndexOf("\n", i) + 1;
  const end = src.indexOf("\n}\n", i);
  return src.slice(start, end + 2);
}
function grabConst(name) {
  const m = src.match(new RegExp(`^const ${name} = .*?;$`, "m"));
  if (!m) throw new Error("找不到常數 " + name);
  return m[0];
}

const fns = ["catalogKeyFor", "normIsbn13", "normTitleKey", "sameTitle", "validISBN13", "validISBN10",
  "isbn10to13", "rarityWeight", "parseCSVAll", "parseGoodreadsCSV", "parseFlexibleCSV",
  "normalizeShelfStatus", "cleanNotionCell", "parseNotionDate", "cleanDesc"];
const code = [grabConst("CJK_RE"), ...fns.map(grab)].join("\n");

const ctx = {
  parsedBooks: [], currentUser: null, showPreview: () => {}, alert: (m) => { throw new Error("alert: " + m); },
  t: (s) => s, console,
  firebase: { firestore: { FieldValue: { serverTimestamp: () => "ts" } } },
};
vm.createContext(ctx);
vm.runInContext("let parsedBooks = [];\n" + code + "\nthis.__get = () => parsedBooks;", ctx);
const F = (n) => ctx[n];

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

// ── normIsbn13 ──
eq("Goodreads =\"…\" 包裝剝殼", F("normIsbn13")('="9780316769488"'), "9780316769488");
eq("解析器吃掉引號後只剩 =", F("normIsbn13")("=9780316769488"), "9780316769488");
eq("ISBN-10 轉 13", F("normIsbn13")("0316769487"), "9780316769488");
eq("帶連字號", F("normIsbn13")("978-0-316-76948-8"), "9780316769488");
eq("檢查碼錯 → 空", F("normIsbn13")("9780316769489"), "");
eq("垃圾 → 空", F("normIsbn13")("abc"), "");
eq("空值 → 空", F("normIsbn13")(undefined), "");

// ── sameTitle(副標判定)──
eq("Dune ≠ Dune Messiah(空格接字不算副標)", F("sameTitle")("Dune", "Dune Messiah"), false);
eq("Dune = Dune (Dune, #1)", F("sameTitle")("Dune", "Dune (Dune, #1)"), true);
eq("原子習慣 = 原子習慣:副標", F("sameTitle")("原子習慣", "原子習慣:細微改變帶來巨大成就的實證法則"), true);
eq("Atomic Habits = 冒號副標", F("sameTitle")("Atomic Habits", "Atomic Habits: An Easy & Proven Way"), true);
eq("Harry Potter ≠ 第二集", F("sameTitle")("Harry Potter", "Harry Potter and the Chamber of Secrets"), false);
eq("大小寫/標點差異 = 同", F("sameTitle")("Project Hail Mary!", "project hail mary"), true);
eq("空書名 → false", F("sameTitle")("", "x"), false);

// ── normTitleKey ──
eq("英文正規化", F("normTitleKey")("Project Hail Mary!"), "projecthailmary");
eq("中文保留", F("normTitleKey")("克拉拉與太陽"), "克拉拉與太陽");

// ── rarityWeight:0 與 -1 都要是「未知」1.2 ──
eq("pop=0 → 未知 1.2", F("rarityWeight")(0), 1.2);
eq("pop=-1 → 未知 1.2", F("rarityWeight")(-1), 1.2);
eq("pop=null → 1.2", F("rarityWeight")(null), 1.2);
eq("pop=100 → 冷門 2.5", F("rarityWeight")(100), 2.5);
eq("pop=25000 → 國民書 0.1", F("rarityWeight")(25000), 0.1);

// ── Goodreads CSV:ISBN13 欄優先、退回 ISBN-10 轉 13、空的給空字串 ──
const gr = [
  "Book Id,Title,Author,Additional Authors,ISBN,ISBN13,My Rating,Publisher,Number of Pages,Date Read,Date Added,Exclusive Shelf,My Review",
  '1,The Catcher in the Rye,J.D. Salinger,,="0316769487",="9780316769488",4,Little Brown,277,2024/01/05,2023/12/01,read,',
  '2,Only Ten,Someone,,="0316769487",="",0,,100,,2023/12/01,to-read,',
  '3,No ISBN,Nobody,,="",="",0,,100,,2023/12/01,to-read,',
].join("\n");
F("parseGoodreadsCSV")(gr, "x.csv");
let books = ctx.__get();
eq("Goodreads 3 本", books.length, 3);
eq("Goodreads ISBN13 欄", books[0].isbn13, "9780316769488");
eq("Goodreads 只有 ISBN-10 → 轉 13", books[1].isbn13, "9780316769488");
eq("Goodreads 無 ISBN → 空", books[2].isbn13, "");
eq("Goodreads 狀態沒被改壞", books[0].status, "Finished");

// ── 通用 CSV:isbn / isbn13 別名 ──
F("parseFlexibleCSV")("Title,Author,ISBN\nCatcher,Salinger,978-0-316-76948-8\n", "y.csv");
eq("通用 CSV 的 ISBN 欄", ctx.__get()[0].isbn13, "9780316769488");
F("parseFlexibleCSV")("書名,作者,ISBN13\n克拉拉與太陽,石黑一雄,9780316769488\n", "z.csv");
eq("中文標頭 + ISBN13 欄", ctx.__get()[0].isbn13, "9780316769488");
eq("中文標頭書名沒壞", ctx.__get()[0].title, "克拉拉與太陽");

// ── 匯入去重規則(照 app.js 匯入迴圈裡的三行實作)──
{
  const normTitleKey = F("normTitleKey");
  const allBooks = [{ title: "Project Hail Mary", isbn13: "9780316769488" }, { title: "克拉拉與太陽", isbn13: "" }];
  const existingIsbns  = new Set(allBooks.map(b => b.isbn13).filter(Boolean));
  const existingTitles = new Set(allBooks.map(b => normTitleKey(b.title)));
  const isDup = b => (b.isbn13 && existingIsbns.has(b.isbn13)) || existingTitles.has(normTitleKey(b.title));
  eq("同 ISBN 不同書名 → 重複", isDup({ title: "PHM (譯本)", isbn13: "9780316769488" }), true);
  eq("同書名差標點大小寫 → 重複", isDup({ title: "project hail mary!", isbn13: "" }), true);
  eq("中文同書名 → 重複", isDup({ title: "克拉拉與太陽", isbn13: "" }), true);
  eq("不同書 → 不重複", isDup({ title: "Dune", isbn13: "9780441013593" }), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

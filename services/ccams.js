const cache = {};
const studentProfileCache = {};
const studentAttendanceCache = {};
const CACHE_TIME = 3 * 60 * 1000;
const text = html => String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const rows = html => [...String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => ({ html: cell[1], text: text(cell[1]) })));
const url = (path, params) => `${path}?${new URLSearchParams(params)}`;

async function load(path, params) {
  const response = await fetch(url(path, params), { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`CCAMS error: ${response.status}`);
  return response.text();
}

async function getCCAMS(phone) {
  const now = Date.now();
  if (cache[phone] && now - cache[phone].timestamp < CACHE_TIME) return cache[phone].data;
  try {
    let html = "";
    for (let page = 1; ; page++) {
      const part = await load("https://ccams.thongtinxuanloc.com/", { phone, page });
      if (!part || part.length < 100) break;
      html += part;
      if (!part.includes(`page=${page + 1}`)) break;
    }
    return (cache[phone] = { timestamp: now, data: { html } }).data;
  } catch (error) { console.error("CCAMS Error:", error.message); return { html: "" }; }
}

function clearCCAMSCache() { Object.keys(cache).forEach(key => delete cache[key]); }

async function getCCAMSStudentProfile(studentId) {
  const id = String(studentId || "").trim();
  const now = Date.now();
  if (!id) return {};
  if (studentProfileCache[id] && now - studentProfileCache[id].timestamp < CACHE_TIME) return studentProfileCache[id].data;
  try {
    const html = await load("https://ccams.thongtinxuanloc.com/search", { phone: "0857675733", search: id });
    let profile = {};
    for (const cells of rows(html)) if (cells[1]?.text === id) {
      const phones = (cells[8]?.text.replace(/\D/g, "").match(/0\d{9}/g) || []).filter((phone, index, list) => list.indexOf(phone) === index);
      profile = { dateOfBirth: cells[3]?.text || "", fatherName: cells[9]?.text || "", motherName: cells[10]?.text || "", phones };
    }
    studentProfileCache[id] = { timestamp: now, data: profile }; return profile;
  } catch (error) { console.error("CCAMS student profile error:", error.message); return {}; }
}

function isPresent(value) {
  return /check|✓|✔|✅/i.test(String(value || ""));
}

function parseStudentProfile(html, studentId) {
  const profile = { studentId: String(studentId || ""), name: "", className: "", dateOfBirth: "", fatherName: "", motherName: "" };
  for (const cells of rows(html)) {
    const label = String(cells[0]?.text || "").trim().toLowerCase();
    const value = String(cells[1]?.text || "").trim();
    if (!label || !value) continue;
    if (label === "mã học viên") profile.studentId = value;
    if (label === "họ tên") profile.name = value;
    if (label === "lớp học") profile.className = value.replace(/\s+/g, " ");
    if (label === "ngày sinh") profile.dateOfBirth = value;
    if (label === "tên cha") profile.fatherName = value;
    if (label === "tên mẹ") profile.motherName = value;
  }
  return profile;
}

function parseAttendanceRows(html) {
  const history = [];
  for (const cells of rows(html)) {
    // Cột: #, ngày, lễ, giáo lý, chầu, xưng tội, khác, niên học, lớp, người điểm danh, ghi chú
    if (cells.length < 11 || !/^\d{2}\/\d{2}\/\d{4}/.test(cells[1]?.text || "")) continue;
    history.push({
      date: cells[1].text.replace(/\s*\([^)]*\)/g, "").trim(),
      mass: isPresent(`${cells[2].html} ${cells[2].text}`),
      catechism: isPresent(`${cells[3].html} ${cells[3].text}`),
      adoration: isPresent(`${cells[4].html} ${cells[4].text}`),
      confession: isPresent(`${cells[5].html} ${cells[5].text}`),
      other: isPresent(`${cells[6].html} ${cells[6].text}`),
      schoolYear: cells[7].text,
      className: cells[8].text.replace(/\s+/g, " ").trim(),
      marker: cells[9].text.replace(/\s+/g, " ").trim(),
      note: cells[10].text.replace(/\s+/g, " ").trim()
    });
  }
  return history;
}

function getPageNumbers(html) {
  const pages = new Set([1]);
  for (const match of String(html || "").matchAll(/[?&](?:amp;)?page=(\d+)/gi)) {
    const page = Number(match[1]);
    if (Number.isSafeInteger(page) && page > 0 && page <= 100) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

// Đọc trực tiếp trang phụ huynh CCAMS. Lịch sử có thể phân trang, vì vậy
// tải đủ các trang được website công bố và khử bản ghi trùng do giao diện đáp ứng.
async function getCCAMSStudentAttendance(studentId) {
  const id = String(studentId || "").trim();
  const now = Date.now();
  if (!id) return null;
  if (studentAttendanceCache[id] && now - studentAttendanceCache[id].timestamp < CACHE_TIME) {
    return studentAttendanceCache[id].data;
  }

  const base = "https://ccams.thongtinxuanloc.com/gxbienhoa/" + encodeURIComponent(id);
  const params = { mahocvien: id, nienhoc: "all", loai: "all" };
  const firstPage = await load(base, params);
  const profile = parseStudentProfile(firstPage, id);
  if (!profile.name) return null;

  const pages = getPageNumbers(firstPage);
  const htmlPages = [firstPage];
  for (const page of pages) {
    if (page === 1) continue;
    htmlPages.push(await load(base, { ...params, page }));
  }

  const seen = new Set();
  const attendance = [];
  htmlPages.flatMap(parseAttendanceRows).forEach(item => {
    // CCAMS đôi khi xuất cùng một lần điểm danh hai lần (bản mobile/desktop),
    // khác nhau duy nhất ở tên người điểm danh. Không lấy marker làm khóa.
    const key = [item.date, item.mass, item.catechism, item.adoration, item.confession, item.other, item.schoolYear, item.className, item.note].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      attendance.push(item);
    }
  });
  attendance.sort((a, b) => {
    const date = value => {
      const [day, month, year] = String(value).split("/").map(Number);
      return Date.UTC(year || 0, (month || 1) - 1, day || 1);
    };
    return date(b.date) - date(a.date);
  });

  const data = {
    ...profile,
    attendance,
    totalMass: attendance.filter(item => item.mass).length,
    catechism: attendance.filter(item => item.catechism).length,
    adoration: attendance.filter(item => item.adoration).length,
    confession: attendance.filter(item => item.confession).length
  };
  studentAttendanceCache[id] = { timestamp: now, data };
  return data;
}

async function getAttendanceByClass(classId, date) {
  const html = await load("https://ccams.thongtinxuanloc.com/", { phone: "0857675733", nienhoc: 4, khoi_lop: classId, loai: "all", search: "", date, to: date });
  return rows(html).filter(cells => cells.length >= 9 && cells[1].text).map(cells => ({
    studentId: cells[1].text,
    mark: [5, 6, 7, 8].map((index, mark) => /check|✓|✔|✅/i.test(`${cells[index].html} ${cells[index].text}`) ? "CGTX"[mark] : "").join("")
  }));
}

async function getCCAMSClasses() {
  const html = await load("https://ccams.thongtinxuanloc.com/", { phone: "0857675733", nienhoc: 4 });
  return [...html.matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi)].map(match => ({ id: match[1], name: text(match[2]).replace(/^---\s*/, "") })).filter(item => item.id && item.id !== "all" && !item.id.startsWith("k_"));
}

module.exports = { getCCAMS, getCCAMSStudentProfile, getCCAMSStudentAttendance, getAttendanceByClass, clearCCAMSCache, getCCAMSClasses, cache, rows, text };

const cache = {};
const studentProfileCache = {};
const studentAttendanceCache = {};
const CACHE_TIME = 3 * 60 * 1000;
const CCAMS_API_BASE = "https://ccams-socket.thongtinxuanloc.com/api/v1";
const CCAMS_PARISH_CODE = "gxbienhoa";
const CCAMS_GLV_PHONE = "0857675733";
const text = html => String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const rows = html => [...String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => ({ html: cell[1], text: text(cell[1]) })));
const url = (path, params) => `${path}?${new URLSearchParams(params)}`;

async function load(path, params) {
  const response = await fetch(url(path, params), { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`CCAMS error: ${response.status}`);
  return response.text();
}

async function loadApi(path, params = {}) {
  const response = await fetch(url(`${CCAMS_API_BASE}${path}`, params), {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }
  });
  if (!response.ok) throw new Error(`CCAMS API error: ${response.status}`);
  return response.json();
}

async function loadAllApiPages(path, params = {}) {
  const first = await loadApi(path, { ...params, page: 1 });
  const pages = [first];
  const lastPage = Number(first?.last_page || first?.rows?.last_page || 1);
  for (let page = 2; page <= Math.min(lastPage, 100); page++) {
    pages.push(await loadApi(path, { ...params, page }));
  }
  return pages;
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
    const data = await loadApi(`/public/lookup/hocvien/${CCAMS_PARISH_CODE}/${encodeURIComponent(id)}`);
    const student = data?.hocvien || {};
    const profile = {
      dateOfBirth: student.NGAYSINH || "",
      fatherName: student.HOTENPHCHA || "",
      motherName: student.HOTENPHME || "",
      phones: []
    };
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

// Đọc đúng như khi mở link CCAMS: không truyền nienhoc để CCAMS tự chọn
// niên khóa hiện tại. Lịch sử vẫn đọc đủ các trang của niên khóa đó.
async function getCCAMSStudentAttendance(studentId) {
  const id = String(studentId || "").trim();
  const now = Date.now();
  if (!id) return null;
  if (studentAttendanceCache[id] && now - studentAttendanceCache[id].timestamp < CACHE_TIME) {
    return studentAttendanceCache[id].data;
  }

  const detail = await loadApi(`/public/lookup/hocvien/${CCAMS_PARISH_CODE}/${encodeURIComponent(id)}`);
  const student = detail?.hocvien;
  if (!student) return null;
  const attendancePages = await loadAllApiPages(
    `/public/lookup/hocvien/${CCAMS_PARISH_CODE}/${encodeURIComponent(id)}/diemdanh`,
    { per_page: 100 }
  );
  const items = attendancePages.flatMap(page => page?.data || []);
  const grouped = new Map();
  items.forEach(item => {
    const date = String(item.NGAYDIEMDANH || "").slice(0, 10);
    if (!date) return;
    const group = grouped.get(date) || {
      date: date.split("-").reverse().join("/"), mass: false, catechism: false,
      adoration: false, confession: false, other: false,
      schoolYear: item?.lophoc?.TENNIENHOC || "", className: item?.lophoc?.TENLOPHOC || "",
      marker: item.nguoidiemdanh || "", note: item.GHICHU || ""
    };
    // API mới: LOAI 1=Lễ, 2=Giáo lý, 3=Chầu, 4=Xưng tội, 5=Khác.
    // Chỉ tính dòng hiện diện; dòng có phép được giữ trong lịch sử nhưng không cộng điểm.
    if (!item.is_vangcp) {
      if (Number(item.LOAI) === 1) group.mass = true;
      if (Number(item.LOAI) === 2) group.catechism = true;
      if (Number(item.LOAI) === 3) group.adoration = true;
      if (Number(item.LOAI) === 4) group.confession = true;
      if (Number(item.LOAI) === 5) group.other = true;
    }
    grouped.set(date, group);
  });
  const attendance = [...grouped.values()];
  attendance.sort((a, b) => {
    const date = value => {
      const [day, month, year] = String(value).split("/").map(Number);
      return Date.UTC(year || 0, (month || 1) - 1, day || 1);
    };
    return date(b.date) - date(a.date);
  });

  const data = {
    studentId: student.MAHOCVIEN || id,
    name: student.hoten || [student.TENTHANH, student.HOCANHAN, student.TENCANHAN].filter(Boolean).join(" "),
    className: detail?.lop?.TENLOPHOC || "",
    dateOfBirth: student.NGAYSINH || "",
    fatherName: student.HOTENPHCHA || "",
    motherName: student.HOTENPHME || "",
    attendance,
    // CCAMS tổng kết ba loại đầu; Xưng tội không có thống kê nên đếm lịch sử.
    totalMass: Number(detail?.total?.thanhle || 0),
    catechism: Number(detail?.total?.giaoly || 0),
    adoration: Number(detail?.total?.chau || 0),
    confession: attendance.filter(item => item.confession).length
  };
  studentAttendanceCache[id] = { timestamp: now, data };
  return data;
}

async function getAttendanceByClass(classId, date) {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date))
    ? String(date)
    : String(date).split("/").reverse().join("-");
  const pages = await loadAllApiPages("/public/lookup/glv/diemdanh", {
    // Không ép nienhoc: API GLV chọn đúng niên khóa hiện tại như giao diện.
    phone: CCAMS_GLV_PHONE, khoi_lop: classId, loai: "all", search: "", date: isoDate, to: isoDate, per_page: 300
  });
  const marks = new Map();
  pages.flatMap(page => page?.rows?.data || []).forEach(item => {
    if (item.is_vangcp || !item.MAHOCVIEN) return;
    const key = String(item.MAHOCVIEN);
    const existing = marks.get(key) || "";
    const symbol = ({ 1: "C", 2: "G", 3: "T", 4: "X" })[Number(item.LOAI)] || "";
    marks.set(key, existing.includes(symbol) ? existing : `${existing}${symbol}`);
  });
  return [...marks].map(([studentId, mark]) => ({ studentId, mark }));
}

async function getCCAMSClasses() {
  const data = await loadApi("/public/lookup/glv/meta", { phone: CCAMS_GLV_PHONE });
  return (data?.filters?.grades || []).flatMap(grade => (grade.classes || []).map(classItem => ({
    id: `l_${classItem.MALOPHOC}`, name: classItem.TENLOPHOC || ""
  })));
}

module.exports = { getCCAMS, getCCAMSStudentProfile, getCCAMSStudentAttendance, getAttendanceByClass, clearCCAMSCache, getCCAMSClasses, cache, rows, text };

const cache = {};
const studentProfileCache = {};
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

async function getAttendanceByClass(classId, date) {
  const html = await load("https://ccams.thongtinxuanloc.com/", { phone: "0857675733", nienhoc: 3, khoi_lop: classId, loai: "all", search: "", date, to: date });
  return rows(html).filter(cells => cells.length >= 9 && cells[1].text).map(cells => ({
    studentId: cells[1].text,
    mark: [5, 6, 7, 8].map((index, mark) => /check|✓|✔|✅/i.test(`${cells[index].html} ${cells[index].text}`) ? "CGTX"[mark] : "").join("")
  }));
}

async function getCCAMSClasses() {
  const html = await load("https://ccams.thongtinxuanloc.com/", { phone: "0857675733" });
  return [...html.matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi)].map(match => ({ id: match[1], name: text(match[2]).replace(/^---\s*/, "") })).filter(item => item.id && item.id !== "all" && !item.id.startsWith("k_"));
}

module.exports = { getCCAMS, getCCAMSStudentProfile, getAttendanceByClass, clearCCAMSCache, getCCAMSClasses, cache, rows, text };

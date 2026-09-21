const ATTENDANCE_SHEET = "Thánh Lễ";
const SCORE_SHEET = "Điểm";
const STATUS_SHEET = "Tình Trạng";
const express = require("./worker-express");
const { createSheetsClient } = require("./services/google-sheets");
const STUDENT_AVATAR_LINKS = require("./student-avatar-links.json");
const {
  getCCAMS,
  getCCAMSStudentProfile,
  getCCAMSStudentAttendance,
  getAttendanceByClass,
  getCCAMSClasses
} = require("./services/ccams");


const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_GROUPS = {
  "man": "1J1Fgyk_Lr5Vp9IK99DVF3Z1SaADpbxonsRNtVim6W_E",
  "thao": "1Fziw9eSbGjA-TLkSqpVbas5gFa9fkwsECLNeb_j11Ww",
  "trinh": "1LmM866E7FaPJwsdtE3w7I2tSVU_z3I9YTpndxjfjQVc"
};

// Khóa lớp CCAMS theo GLV để không phụ thuộc tên lớp có thể đổi giữa các niên khóa.
const CCAMS_CLASS_IDS_BY_GROUP = {
  man: ["l_10144", "l_10152"],
  thao: ["l_10140"],
  trinh: ["l_10139", "l_10155"]
};

// =========================
// CACHE CONFIG
// =========================
const CACHE_DURATION = 60 * 1000; // 60 giây cho Sheet


const sheetStates = Object.fromEntries(
  Object.keys(SHEET_GROUPS).map(group => [group, {
    cacheData: null,
    cacheTimestamp: 0,
    studentMap: {},
    scoreMap: {},
    statusMap: {},
    statusRowMap: {},
    leaveMap: {}
  }])
);

function getGroup(req) {
  const group = String(req.query.group || "").trim().toLowerCase();
  if (!SHEET_GROUPS[group]) {
    const error = new Error("Nhóm lớp không hợp lệ");
    error.status = 400;
    throw error;
  }
  if (!req.dashboardAuthorized && !isDashboardCodeValid(req.get("x-dashboard-code"), group)) {
    const error = new Error("Phiên đăng nhập Dashboard không hợp lệ hoặc đã hết hạn");
    error.status = 401;
    throw error;
  }
  return group;
}

function getDashboardCodes() {
  try {
    const codes = JSON.parse(String(process.env.DASHBOARD_CODES || "{}"));
    return codes && typeof codes === "object" ? codes : {};
  } catch (_) {
    return {};
  }
}

function isDashboardCodeValid(code, group) {
  const enteredCode = String(code || "").trim();
  const expectedGroup = getDashboardCodes()[enteredCode];
  return Boolean(enteredCode && expectedGroup && String(expectedGroup).toLowerCase() === group);
}

function getState(group) {
  return sheetStates[group];
}

// Nếu có link riêng trong student-avatar-links.json thì ưu tiên link đó.
// Mã không có trong file vẫn dùng kho ảnh CCAMS như trước.
function getStudentAvatar(studentId) {
  const id = String(studentId || "").trim();
  const customUrl = String(STUDENT_AVATAR_LINKS[id] || "").trim();
  if (/^https:\/\//i.test(customUrl)) return customUrl;
  return `https://ttxl.s3-hn-2.cloud.cmctelecom.vn/ccams/gxbienhoa/hocvien/${encodeURIComponent(id)}.jpg`;
}


// =========================
// HELPER: Chuyển Google Serial Date
// =========================
function googleDateToString(serial) {
  if (!serial) return { date: "", weekday: "" };
  const utcDays = Math.floor(serial - 25569);
  const date = new Date(utcDays * 86400 * 1000);
  const weekdays = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  
  return {
    date: `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`,
    weekday: weekdays[date.getDay()]
  };
}

function splitLeaveItems(value) {
  return String(value || "")
    .split(/\s*;\s*/)
    .map(item => item.trim())
    .filter(Boolean);
}

// Điểm trung bình từ các cột đã có điểm (bỏ qua cột trống) — dùng cho bảng xếp hạng Top học viên.
function averageScore(score) {
  if (!score) return null;
  const fields = ["ghkiScore", "chkiScore", "ghkiiScore", "chkiiScore"];
  let sum = 0, count = 0;
  fields.forEach(key => {
    const raw = score[key];
    if (raw === "" || raw === undefined || raw === null) return;
    const num = Number(String(raw).replace(",", "."));
    if (Number.isFinite(num)) { sum += num; count++; }
  });
  return count ? sum / count : null;
}

// Có đơn "Vắng có phép" hay không (đơn thay thế buổi thứ 5 KHÔNG tính là vắng có phép).
function hasExcusedLeave(leaveText) {
  return splitLeaveItems(leaveText).some(item => /^Vắng có phép/i.test(item));
}

function parseAttendanceHeaderDate(value, targetYear) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }

  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!match) return null;
  const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : targetYear;
  return { year, month: Number(match[2]), day: Number(match[1]) };
}

function findAttendanceDateColumn(headers, dateStr) {
  const [year, month, day] = String(dateStr || "").split("-").map(Number);
  if (!year || !month || !day) return -1;
  return headers.findIndex(header => {
    const parsed = parseAttendanceHeaderDate(header, year);
    return parsed && parsed.year === year && parsed.month === month && parsed.day === day;
  });
}

function parseAttendanceDateInRange(value, startDate, endDate) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = parseAttendanceHeaderDate(value, startDate.getFullYear());
    return parsed ? new Date(parsed.year, parsed.month - 1, parsed.day) : null;
  }
  const match = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (match[3]) {
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    return new Date(year, month - 1, day);
  }
  for (let year = startDate.getFullYear(); year <= endDate.getFullYear(); year++) {
    const candidate = new Date(year, month - 1, day);
    if (candidate >= startDate && candidate <= endDate) return candidate;
  }
  return null;
}

function countWeekdaysInMonth(year, month, weekdays) {
  const lastDay = new Date(year, month, 0).getDate();
  let total = 0;
  for (let day = 1; day <= lastDay; day++) {
    if (weekdays.includes(new Date(year, month - 1, day).getDay())) total++;
  }
  return total;
}

// =========================
// CORE: Đọc Google Sheet
// =========================
async function loadSheetData(group) {
  const spreadsheetId = SHEET_GROUPS[group];
  const state = getState(group);
  const credentials =
  JSON.parse(process.env.GOOGLE_CREDENTIALS);

  const sheets = createSheetsClient(credentials);

  const [
    attendanceResponse,
    scoreResponse,
    statusResponse
  ] = await Promise.all([
      sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${ATTENDANCE_SHEET}!A:ZZ`,
          valueRenderOption: "UNFORMATTED_VALUE"
      }),

      sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${SCORE_SHEET}!A:L`,
          valueRenderOption: "UNFORMATTED_VALUE"
      }),

      sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${STATUS_SHEET}!A:F`
      })
  ]);

  const rows = attendanceResponse.data.values || [];
  const scoreRows = scoreResponse.data.values || [];
  const statusRows =
    statusResponse.data.values || [];

  const tempStudentMap = {};
  const tempScoreMap = {};
  const tempStatusMap = {};
  const tempStatusRowMap = {};
  const tempLeaveMap = {};

  // Map data học sinh (bắt đầu từ dòng 4 -> index 3)
  for (let i = 3; i < rows.length; i++) {
    const studentId = (rows[i][1] || "").toString().trim();
    if (studentId) {
      tempStudentMap[studentId] = rows[i];
      tempStudentMap[studentId]._rowNumber = i + 1;
    }
  }

  // Map data điểm
  for (let i = 3; i < scoreRows.length; i++) {
    const studentId = (scoreRows[i][1] || "").toString().trim();
    if (studentId) {
      tempScoreMap[studentId] = {
        ghkiScore: scoreRows[i][4] || "", ghkiResult: scoreRows[i][5] || "",
        chkiScore: scoreRows[i][6] || "", chkiResult: scoreRows[i][7] || "",
        ghkiiScore: scoreRows[i][8] || "", ghkiiResult: scoreRows[i][9] || "",
        chkiiScore: scoreRows[i][10] || "", chkiiResult: scoreRows[i][11] || ""
      };
    }
  }
  for (let i = 3; i < statusRows.length; i++) {

    const studentId =
        String(statusRows[i][1] || "")
        .trim();

    const status =
        String(statusRows[i][4] || "")
        .trim();
    const leave =
        String(statusRows[i][5] || "")
        .trim();

    if (studentId) {

        tempStatusMap[studentId] = status;
        tempStatusRowMap[studentId] = i + 1;
        tempLeaveMap[studentId] = leave;

    }
}

  // Cập nhật Cache
  state.cacheData = rows;
  state.cacheTimestamp = Date.now();
  state.studentMap = tempStudentMap;
  state.scoreMap = tempScoreMap;
  state.statusMap = tempStatusMap;
  state.statusRowMap = tempStatusRowMap;
  state.leaveMap = tempLeaveMap;

  console.log(`📥 Reload Sheet ${group} thành công (${Object.keys(state.studentMap).length} học sinh)`);
  return rows;
}

async function getSheetData(group) {
  const state = getState(group);
  if (state.cacheData && Date.now() - state.cacheTimestamp < CACHE_DURATION) {
    return state.cacheData;
  }
  return await loadSheetData(group);
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseAiDate(message) {
  const match = String(message || "").match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?\b/);
  if (!match) return null;
  const year = Number(match[3] || new Date().getFullYear());
  return `${year}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

async function buildAiContext(message, group) {
  await getSheetData(group);
  const state = getState(group);
  const text = normalizeSearch(message);
  const requestedDate = parseAiDate(message);

  if (text.includes("vang") && requestedDate) {
    const column = findAttendanceDateColumn(state.cacheData?.[2] || [], requestedDate);
    if (column === -1) return `Không tìm thấy cột điểm danh ngày ${requestedDate} trong Sheet.`;
    const absent = Object.values(state.studentMap)
      .filter(row => !String(row[column] || "").toUpperCase().includes("C"))
      .map(row => ({ name: String(row[2] || ""), studentId: String(row[1] || ""), className: String(row[3] || "") }));
    return `Dữ liệu chính xác từ Sheet cho ngày ${requestedDate}. Có ${absent.length} học viên vắng: ${JSON.stringify(absent)}.`;
  }

  if (text.includes("so dien thoai") || text.includes("sdt") || text.includes("dien thoai")) {
    const nameMatch = String(message || "").match(/(?:của|cua)\s+(.+?)(?:\?|$)/i);
    const nameQuery = normalizeSearch(nameMatch?.[1] || message.replace(/số điện thoại|so dien thoai|sđt|sdt/gi, ""));
    const matches = Object.values(state.studentMap)
      .filter(row => normalizeSearch(row[2]).includes(nameQuery))
      .slice(0, 3);
    if (!matches.length) return "Không tìm thấy học viên khớp với tên được hỏi.";
    const profiles = await Promise.all(matches.map(async row => {
      const studentId = String(row[1] || "");
      const profile = await getCCAMSStudentProfile(studentId);
      return { name: String(row[2] || ""), studentId, className: String(row[3] || ""), phones: profile.phones || [] };
    }));
    return `Kết quả tra cứu số điện thoại: ${JSON.stringify(profiles)}.`;
  }

  return "Chưa nhận diện được truy vấn dữ liệu. Hiện hỗ trợ: danh sách vắng theo ngày (ví dụ: 'Ngày 21/07/2026 vắng những em nào?') và số điện thoại theo tên (ví dụ: 'Số điện thoại của Mai Linh?').";
}

// Lịch sử tham dự lấy trực tiếp từ các cột ngày ở sheet Thánh Lễ.
function getStudentSheetAttendance(state, studentRow) {
  const headers = state.cacheData?.[2] || [];
  const currentYear = new Date().getFullYear();
  const attendance = [];
  let adoration = 0;
  let confession = 0;

  headers.forEach((header, columnIndex) => {
    const date = parseAttendanceHeaderDate(header, currentYear);
    if (!date) return;
    const mark = String(studentRow[columnIndex] || "").trim().toUpperCase();
    if (!mark) return;

    const item = {
      date: `${String(date.day).padStart(2, "0")}/${String(date.month).padStart(2, "0")}/${date.year}`,
      mass: mark.includes("C"),
      catechism: mark.includes("G"),
      adoration: mark.includes("T"),
      confession: mark.includes("X"),
      mark
    };
    if (item.adoration) adoration++;
    if (item.confession) confession++;
    attendance.push(item);
  });

  return { attendance, adoration, confession };
}

// =========================
// CORE: Parse dữ liệu CCAMS (Được tách riêng chuẩn hóa)
// =========================
async function getCCAMSData(phone, studentId) {
  if (!phone) return { totalMass: 0, catechism: 0, adoration: 0, attendance: [] };

  const ccams = await getCCAMS(phone);
  const $ = ccams.$;
  const targetTab = $(`#tab${studentId}`);

  console.log("Student:", studentId);
  console.log(
  $('[id*="' + studentId + '"]')
    .map((i,e)=>$(e).attr('id'))
    .get()
);


  if (!targetTab.length) {
    console.log(
      `❌ Không tìm thấy tab học viên ${studentId}`
    );

    return {
      totalMass: 0,
      catechism: 0,
      adoration: 0,
      attendance: []
    };
  }
  
  let totalMass = 0, catechism = 0, adoration = 0;
  const attendance = [];

  // 1. Lấy tổng số lượng
  targetTab.find('table.table-bordered').each((i, table) => {
    const headers = $(table).find('tr:first-child').text();
    if (headers.includes('Số Thánh lễ') && headers.includes('Số Giáo lý')) {
      const values = $(table).find('tr:nth-child(2)').find('td');
      totalMass = Number($(values[0]).text().trim()) || 0;
      catechism = Number($(values[1]).text().trim()) || 0;
      adoration = Number($(values[2]).text().trim()) || 0;
    }
  });

  // 2. Lấy lịch sử điểm danh
  $(`#tab${studentId}_diemdanh tbody tr`).each((i, row) => {
    const tds = $(row).find('td');
    if (tds.length < 11) return;

    attendance.push({
      date: $(tds[1]).text().trim(),
      mass: $(tds[2]).text().trim() === '✅', // Dùng === '✅' chính xác hơn includes
      catechism: $(tds[3]).text().trim() === '✅',
      adoration: $(tds[4]).text().trim() === '✅',
      confession: $(tds[5]).text().trim() === '✅',
      other: $(tds[6]).text().trim() === '✅',
      schoolYear: $(tds[7]).text().trim(),
      className: $(tds[8]).text().replace(/\s+/g, ' ').trim(),
      marker: $(tds[9]).text().trim(),
      note: $(tds[10]).text().trim()
    });
  });

  return { totalMass, catechism, adoration, attendance };
}

// Lịch mục vụ của niên khóa 2026–2027. Báo cáo tháng và số buổi vắng đều
// dùng chung lịch này, để không tính nhầm các ngày chưa khai giảng hoặc nghỉ.
const ATTENDANCE_CALENDAR = {
  firstAttendanceDay: "2026-09-14",
  fullDaysOff: [
    { start: "2027-02-07", end: "2027-02-14", label: "Nghỉ Tết 07/02–14/02/2027 — không tính Thánh lễ và Giáo lý" }
  ],
  catechismDaysOff: [
    { date: "2027-03-28", label: "Nghỉ Giáo lý ngày 28/03/2027 — vẫn có Thánh lễ" },
    { date: "2027-05-02", label: "Nghỉ Giáo lý ngày 02/05/2027 (lễ 30/4–1/5) — vẫn có Thánh lễ" }
  ]
};

function formatIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getMonthlyAttendanceSchedule(year, month) {
  const massDates = new Set();
  const catechismDates = new Set();
  const notes = [];
  if (year === 2026 && month === 9) {
    notes.push("Tháng 09/2026 bắt đầu tính điểm danh từ ngày 14/09");
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  for (let day = 1; day <= lastDay; day++) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const isoDate = formatIsoDate(year, month, day);
    const weekday = date.getUTCDay();
    if (isoDate < ATTENDANCE_CALENDAR.firstAttendanceDay) continue;

    const fullDayOff = ATTENDANCE_CALENDAR.fullDaysOff.find(item =>
      isoDate >= item.start && isoDate <= item.end
    );
    if (fullDayOff) {
      if ((weekday === 0 || weekday === 4) && !notes.includes(fullDayOff.label)) notes.push(fullDayOff.label);
      continue;
    }

    if (weekday === 0 || weekday === 4) massDates.add(isoDate);
    if (weekday === 0) {
      const catechismDayOff = ATTENDANCE_CALENDAR.catechismDaysOff.find(item => item.date === isoDate);
      if (catechismDayOff) {
        if (!notes.includes(catechismDayOff.label)) notes.push(catechismDayOff.label);
      } else {
        catechismDates.add(isoDate);
      }
    }
  }

  return { massDates, catechismDates, notes };
}

function getDailyAttendanceSchedule(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  if (isoDate < ATTENDANCE_CALENDAR.firstAttendanceDay) {
    return { massRequired: false, catechismRequired: false, note: "Chưa bắt đầu điểm danh niên khóa (từ 14/09/2026)" };
  }
  const fullDayOff = ATTENDANCE_CALENDAR.fullDaysOff.find(item => isoDate >= item.start && isoDate <= item.end);
  if (fullDayOff) return { massRequired: false, catechismRequired: false, note: fullDayOff.label };

  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  const catechismDayOff = ATTENDANCE_CALENDAR.catechismDaysOff.find(item => item.date === isoDate);
  return {
    massRequired: weekday === 0 || weekday === 4,
    catechismRequired: weekday === 0 && !catechismDayOff,
    note: catechismDayOff?.label || ""
  };
}

// Mã đăng nhập Dashboard được lưu trong Cloudflare Secret DASHBOARD_CODES.
app.post("/auth/dashboard", (req, res) => {
  const code = String(req.body?.code || "").trim();
  const group = String(getDashboardCodes()[code] || "").trim().toLowerCase();
  if (!SHEET_GROUPS[group]) {
    return res.status(401).json({ success: false, error: "Mã đăng nhập không đúng" });
  }
  return res.json({ success: true, group });
});

app.post("/import-attendance-range", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
        const group = getGroup(req);
        const { fromDate, toDate, classId } = req.body;
        const start = new Date(`${fromDate}T00:00:00`);
        const end = new Date(`${toDate}T00:00:00`);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end || !classId) {
            throw new Error("Khoảng ngày hoặc lớp không hợp lệ");
        }

        const dates = [];
        for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
            dates.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
        }

        // Chỉ đọc Sheet một lần để lấy danh sách, dòng học viên và các cột ngày.
        await getSheetData(group);
        const state = getState(group);
        const headers = state.cacheData?.[2] || [];
        const updates = [];
        const results = [];
        const total = dates.length;

        send("progress", { phase: "fetching", current: 0, total, message: "Đang lấy dữ liệu từ CCAMS..." });
        for (let index = 0; index < dates.length; index++) {
            const currentDate = dates[index];
            const dateCol = findAttendanceDateColumn(headers, currentDate);

            if (dateCol === -1) {
                results.push({ date: currentDate, count: 0, error: "Không tìm thấy cột ngày trong Sheet" });
                send("progress", { phase: "fetching", current: index + 1, total, date: currentDate, message: `Đã đọc ${index + 1}/${total} ngày` });
                continue;
            }

            try {
                const attendance = await getAttendanceByClass(classId, formatDateVN(currentDate));
                let count = 0;
                attendance.forEach(item => {
                    const student = state.studentMap[item.studentId];
                    if (!student) return;
                    updates.push({
                        range: `${ATTENDANCE_SHEET}!${columnLetter(dateCol + 1)}${student._rowNumber}`,
                        values: [[item.mark]]
                    });
                    count++;
                });
                results.push({ date: currentDate, count });
            } catch (err) {
                results.push({ date: currentDate, count: 0, error: err.message });
            }
            send("progress", { phase: "fetching", current: index + 1, total, date: currentDate, message: `Đã đọc ${index + 1}/${total} ngày từ CCAMS` });
        }

        send("progress", { phase: "writing", current: total, total, message: "Đang ghi toàn bộ dữ liệu vào Google Sheet..." });
        const lastUpdated = formatShortDateVN(toDate);
        updates.push({
            range: `${ATTENDANCE_SHEET}!G1`,
            values: [[`cập nhật gần đây: ${lastUpdated}`]]
        });
        const sheets = await getSheetsClient();
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SHEET_GROUPS[group],
            requestBody: { valueInputOption: "RAW", data: updates }
        });

        // Tránh đọc lại Sheet ngay sau khi ghi; request kế tiếp sẽ tự nạp dữ liệu mới.
        state.cacheData = null;
        state.cacheTimestamp = 0;
        send("complete", {
            success: true,
            results,
            lastUpdated: `cập nhật gần đây: ${lastUpdated}`
        });
    } catch (err) {
        console.error("Lỗi import điểm danh theo khoảng:", err);
        send("error", { success: false, error: err.message });
    } finally {
        res.end();
    }

});

app.post("/import-attendance", async (req,res)=>{

    try{
        const group = getGroup(req);

        const {
            date,
            classId
        } = req.body;

        const result =
            await importAttendance(date, classId, group);

        const lastUpdated = formatShortDateVN(date);
        const sheets = await getSheetsClient();
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_GROUPS[group],
            range: `${ATTENDANCE_SHEET}!G1`,
            valueInputOption: "RAW",
            requestBody: {
                values: [[`cập nhật gần đây: ${lastUpdated}`]]
            }
        });

        res.json({
            success:true,
            ...result,
            lastUpdated: `cập nhật gần đây: ${lastUpdated}`
        });

    }catch(err){

        console.error(err);

        res.status(500).json({
            success:false,
            message:err.message
        });
    }
});

// =========================
// API: Tra cứu chi tiết 1 học sinh
// =========================
app.get("/student/:id", async (req, res) => {
  try {
    const studentId = req.params.id.toString().trim();
    const requestedGroup = String(req.query.group || "").trim().toLowerCase();
    const requestedGroupValue = requestedGroup ? getGroup(req) : "";
    const groups = requestedGroupValue ? [requestedGroupValue] : Object.keys(SHEET_GROUPS);

    let group = null;
    let state = null;
    let studentRow = null;

    for (const candidate of groups) {
      await getSheetData(candidate);
      const candidateState = getState(candidate);
      if (candidateState.studentMap[studentId]) {
        group = candidate;
        state = candidateState;
        studentRow = candidateState.studentMap[studentId];
        break;
      }
    }

    // CCAMS đang chuyển sang API/giao diện mới. Vẫn ưu tiên dữ liệu CCAMS khi
    // đọc được, nhưng học viên đã có trong Sheet không bị báo "không tìm thấy"
    // chỉ vì trang CCAMS cũ tạm thời không còn trả HTML như trước.
    let ccamsStudent = null;
    try {
      ccamsStudent = await getCCAMSStudentAttendance(studentId);
    } catch (error) {
      console.warn("Không đọc được hồ sơ CCAMS, dùng Sheet dự phòng:", error.message);
    }

    if (!ccamsStudent && !studentRow) {
      return res.json({ success: false, message: "Không tìm thấy học viên" });
    }

    // Với Dashboard GLV: nếu CCAMS đọc được thì xác nhận đúng lớp CCAMS;
    // nếu CCAMS đang chuyển hệ thống thì việc mã nằm trong Sheet của chính
    // nhóm đang đăng nhập đã là bằng chứng em thuộc lớp quản lý.
    if (requestedGroupValue && ccamsStudent && !studentRow) {
      const ccamsClasses = await getCCAMSClasses();
      const allowedIds = CCAMS_CLASS_IDS_BY_GROUP[requestedGroupValue] || [];
      const managedClassNames = new Set(ccamsClasses
        .filter(item => allowedIds.includes(item.id))
        .map(item => String(item.name || "").replace(/\s+/g, " ").trim().toLowerCase()));
      const currentClass = String(ccamsStudent.className || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!managedClassNames.has(currentClass)) {
        return res.status(403).json({ success: false, message: "Học viên không thuộc lớp bạn đang quản lý" });
      }
    }

    const score = studentRow ? (state.scoreMap[studentId] || {}) : {};
    let ccamsProfile = {};
    try { ccamsProfile = await getCCAMSStudentProfile(studentId); } catch (_) { /* Không chặn tra cứu từ Sheet. */ }
    const sheetAttendance = studentRow ? getStudentSheetAttendance(state, studentRow) : { attendance: [], adoration: 0, confession: 0 };
    const source = ccamsStudent || {};

    return res.json({
      success: true,
      studentId: source.studentId || studentId,
      name: source.name || studentRow?.[2] || "",
      className: source.className || studentRow?.[3] || "",
      // Em thuộc lớp GLV phụ trách nhưng chưa được thêm vào Sheet được xem là
      // đang học mặc định; trạng thái thực tế vẫn ưu tiên dữ liệu Sheet.
      status: studentRow ? (state.statusMap[studentId] || "đang học") : "đang học",
      leave: studentRow ? (state.leaveMap[studentId] || "") : "",
      leaveItems: studentRow ? splitLeaveItems(state.leaveMap[studentId]) : [],
      group: group || "",
      // Điểm học tập chỉ nằm trong Sheet của lớp đó. Em cùng lớp nhưng chưa
      // có dòng Sheet vẫn xem được hồ sơ/điểm danh CCAMS, không hiện điểm.
      showScores: Boolean(studentRow),
      dateOfBirth: source.dateOfBirth || ccamsProfile.dateOfBirth || "",
      fatherName: source.fatherName || ccamsProfile.fatherName || "",
      motherName: source.motherName || ccamsProfile.motherName || "",
      phones: (ccamsProfile.phones?.length
        ? ccamsProfile.phones
        : String(studentRow?.[4] || "").match(/0\d{8,10}/g) || []),
      avatar: getStudentAvatar(studentId),
      totalMass: source.totalMass ?? Number(studentRow?.[5] || 0),
      catechism: source.catechism ?? Number(studentRow?.[8] || 0),
      adoration: source.adoration ?? sheetAttendance.adoration,
      confession: source.confession ?? sheetAttendance.confession,
      scores: score,
      attendance: source.attendance || sheetAttendance.attendance
    });

  } catch (err) {
    console.error("Lỗi /student/:id :", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================
// API: Cập nhật tình trạng học viên
// =========================
app.put("/student/:id/status", async (req, res) => {
  try {
    const group = getGroup(req);
    const studentId = String(req.params.id || "").trim();
    const status = String(req.body.status || "").trim();
    const allowedStatuses = [
      "\u0111ang h\u1ecdc",
      "ngh\u1ec9 ngang",
      "ngh\u1ec9 t\u1eeb \u0111\u1ea7u",
      "chuy\u1ec3n x\u1ee9",
      "n\u1ee3 b\u00e0i",
      "thi\u1ebfu \u0111i\u1ec3m l\u1ec5",
      "thi\u1ebfu \u0111i\u1ec3m gi\u00e1o l\u00fd"
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Tình trạng không hợp lệ" });
    }

    await getSheetData(group);
    const state = getState(group);
    if (!state.studentMap[studentId]) {
      return res.status(404).json({ success: false, message: "Không tìm thấy học viên" });
    }

    const sheets = await getSheetsClient();
    const spreadsheetId = SHEET_GROUPS[group];
    const statusRow = state.statusRowMap[studentId];

    if (statusRow) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${STATUS_SHEET}!E${statusRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [[status]] }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${STATUS_SHEET}!A:E`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [["", studentId, "", "", status]] }
      });
    }

    await loadSheetData(group);
    return res.json({ success: true, studentId, status });
  } catch (err) {
    console.error("Lỗi cập nhật tình trạng:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================
// API: Đơn phép học viên (Tình Trạng!F4:F)
// =========================
app.get("/leave-requests", async (req, res) => {
  try {
    const group = getGroup(req);
    await getSheetData(group);
    const state = getState(group);

    const requests = Object.values(state.studentMap)
      .filter(row => state.leaveMap[String(row[1] || "").trim()])
      .sort((a, b) => a._rowNumber - b._rowNumber)
      .map(row => {
        const studentId = String(row[1] || "").trim();
        return {
          studentId,
          name: row[2] || "",
          className: row[3] || "",
          leave: state.leaveMap[studentId],
          leaveItems: splitLeaveItems(state.leaveMap[studentId]),
          excusedCount: splitLeaveItems(state.leaveMap[studentId])
            .filter(item => /^Vắng có phép ngày\s+/i.test(item)).length
        };
      });

    return res.json({ success: true, requests });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================
// API: Điểm danh tự động từ Google Apps Script / lịch hẹn
// =========================
app.post("/scheduled-import", async (req, res) => {
  try {
    const suppliedSecret = String(req.get("x-automation-key") || req.body.secret || "");
    const expectedSecret = String(process.env.AUTOMATION_SECRET || "");
    if (!expectedSecret || suppliedSecret !== expectedSecret) {
      return res.status(401).json({ success: false, error: "Không có quyền chạy điểm danh tự động" });
    }

    req.dashboardAuthorized = true;
    const group = getGroup(req);
    const date = String(req.body.date || "").trim();
    const classId = String(req.body.classId || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !classId) {
      return res.status(400).json({ success: false, error: "Thiếu ngày hoặc mã lớp CCAMS" });
    }

    const result = await importAttendance(date, classId, group);
    const lastUpdated = formatShortDateVN(date);
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_GROUPS[group],
      range: `${ATTENDANCE_SHEET}!G1`,
      valueInputOption: "RAW",
      requestBody: { values: [[`cập nhật gần đây: ${lastUpdated}`]] }
    });

    return res.json({
      success: true,
      group,
      date,
      count: result.count,
      lastUpdated: `cập nhật gần đây: ${lastUpdated}`
    });
  } catch (err) {
    console.error("Lỗi điểm danh tự động:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Chỉnh sửa hoặc gỡ từng đơn phép; mảng leaveItems được nối lại bằng " ; " trong Sheet.
app.put("/leave-requests/:id", async (req, res) => {
  try {
    const group = getGroup(req);
    const studentId = String(req.params.id || "").trim();
    const leaveItems = Array.isArray(req.body.leaveItems)
      ? req.body.leaveItems.map(item => String(item || "").trim()).filter(Boolean)
      : null;

    if (!leaveItems) {
      return res.status(400).json({ success: false, message: "Dữ liệu đơn phép không hợp lệ" });
    }

    await getSheetData(group);
    const state = getState(group);
    if (!state.studentMap[studentId]) {
      return res.status(404).json({ success: false, message: "Không tìm thấy học viên" });
    }

    const excusedCount = leaveItems.filter(item => /^Vắng có phép\b/i.test(item)).length;
    if (excusedCount > 5) {
      return res.status(400).json({
        success: false,
        message: "Mỗi học viên chỉ được tối đa 5 đơn vắng có phép"
      });
    }

    const statusRow = state.statusRowMap[studentId];
    if (!statusRow) {
      return res.status(404).json({ success: false, message: "Học viên chưa có dữ liệu đơn phép" });
    }

    const sheets = await getSheetsClient();
    const leave = leaveItems.join(" ; ");
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_GROUPS[group],
      range: `${STATUS_SHEET}!F${statusRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[leave]] }
    });

    await loadSheetData(group);
    return res.json({ success: true, studentId, leave, leaveItems });
  } catch (err) {
    console.error("Lỗi cập nhật đơn phép:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/leave-requests", async (req, res) => {
  try {
    const group = getGroup(req);
    const studentId = String(req.body.studentId || "").trim();
    const type = String(req.body.type || "").trim();
    const replacementDay = String(req.body.replacementDay || "").trim();
    const absenceDate = String(req.body.absenceDate || "").trim();

    if (!studentId || !["makeup", "excused"].includes(type)) {
      return res.status(400).json({ success: false, message: "Thông tin đơn phép không hợp lệ" });
    }

    let leaveText = "";
    if (type === "makeup") {
      if (!replacementDay) {
        return res.status(400).json({ success: false, message: "Vui lòng nhập buổi thay thế" });
      }
      leaveText = `Đơn thay thế buổi thứ 5 sang ${replacementDay}`;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(absenceDate)) {
        return res.status(400).json({ success: false, message: "Vui lòng chọn ngày vắng" });
      }
      leaveText = `Vắng có phép ngày ${formatLeaveDateVN(absenceDate)}`;
    }

    await getSheetData(group);
    const state = getState(group);
    if (!state.studentMap[studentId]) {
      return res.status(404).json({ success: false, message: "Không tìm thấy học viên" });
    }

    const sheets = await getSheetsClient();
    const spreadsheetId = SHEET_GROUPS[group];
    const statusRow = state.statusRowMap[studentId];

    if (statusRow) {
      const current = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${STATUS_SHEET}!F${statusRow}`
      });
      const existingLeave = String(current.data.values?.[0]?.[0] || "").trim();
      const existingExcusedCount = splitLeaveItems(existingLeave)
        .filter(item => /^Vắng có phép\b/i.test(item)).length;
      if (type === "excused" && existingExcusedCount >= 5) {
        return res.status(400).json({
          success: false,
          message: "Học viên đã đủ 5 đơn vắng có phép"
        });
      }
      const value = existingLeave ? `${existingLeave} ; ${leaveText}` : leaveText;

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${STATUS_SHEET}!F${statusRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [[value]] }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${STATUS_SHEET}!A:F`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [["", studentId, "", "", "", leaveText]] }
      });
    }

    await loadSheetData(group);
    return res.json({ success: true, studentId, leave: getState(group).leaveMap[studentId] || leaveText });
  } catch (err) {
    console.error("Lỗi thêm đơn phép:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================
// API: Danh sách học sinh (Cho GLV)
// =========================
app.get("/students", async (req, res) => {
  try {
    const group = getGroup(req);
    await getSheetData(group);
    const state = getState(group);
    const students = Object.values(state.studentMap)
      .sort((a, b) => a._rowNumber - b._rowNumber)
      .map(row => ({
        studentId: row[1] || "",
        name: row[2] || "",
        className: row[3] || "",
        phone: row[4] || "",
        status:
            state.statusMap[
                String(row[1] || "").trim()
            ] || "",
        leave: state.leaveMap[String(row[1] || "").trim()] || ""
    }));

    res.json({ success: true, total: students.length, students });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================
// API: Báo cáo điểm danh theo tháng
// =========================
app.get("/monthly-attendance-report", async (req, res) => {
  try {
    const group = getGroup(req);
    const monthValue = String(req.query.month || "").trim();
    const className = String(req.query.className || "").trim();
    const match = monthValue.match(/^(\d{4})-(\d{2})$/);
    if (!match) return res.status(400).json({ success: false, message: "Tháng không hợp lệ" });

    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return res.status(400).json({ success: false, message: "Tháng không hợp lệ" });
    const requestedDaysOff = Math.floor(Number(req.query.catechismDaysOff || 0));

    await getSheetData(group);
    const state = getState(group);
    const headers = state.cacheData?.[2] || [];
    const monthColumns = headers.map((header, index) => ({ index, date: parseAttendanceHeaderDate(header, year) }))
      .filter(item => item.date && item.date.year === year && item.date.month === month);
    const calendarSchedule = getMonthlyAttendanceSchedule(year, month);
    const scheduledMass = calendarSchedule.massDates.size;
    const scheduledCatechism = calendarSchedule.catechismDates.size;
    const catechismDaysOff = Math.min(scheduledCatechism, Math.max(0, requestedDaysOff || 0));
    const effectiveCatechismDays = scheduledCatechism - catechismDaysOff;
    const students = Object.values(state.studentMap)
      .sort((a, b) => a._rowNumber - b._rowNumber)
      .filter(row => !className || String(row[3] || "").trim() === className)
      .map(row => {
        let massPresent = 0;
        let catechismPresent = 0;
        monthColumns.forEach(({ index, date }) => {
          const dateKey = formatIsoDate(date.year, date.month, date.day);
          const mark = String(row[index] || "").trim().toUpperCase();
          if (calendarSchedule.massDates.has(dateKey) && mark.includes("C")) massPresent++;
          if (calendarSchedule.catechismDates.has(dateKey) && mark.includes("G")) catechismPresent++;
        });
        const studentId = String(row[1] || "").trim();
        return {
          studentId,
          name: row[2] || "",
          className: row[3] || "",
          status: state.statusMap[studentId] || "",
          massPresent,
          massAbsent: Math.max(0, scheduledMass - massPresent),
          catechismPresent,
          catechismAbsent: Math.max(0, effectiveCatechismDays - catechismPresent)
        };
      });

    return res.json({
      success: true,
      month: monthValue,
      scheduledMass,
      scheduledCatechism,
      catechismDaysOff,
      effectiveCatechismDays,
      calendarNotes: calendarSchedule.notes,
      className,
      students
    });
  } catch (err) {
    console.error("Lỗi báo cáo tháng:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================
// API: Tổng quan chất lượng theo khoảng thời gian
// =========================
app.get("/quality-overview", async (req, res) => {
  try {
    const group = getGroup(req);
    const className = String(req.query.className || "").trim();
    const requestedStatuses = new Set(
      String(req.query.statuses || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean)
    );
    const startValue = String(req.query.startDate || ATTENDANCE_CALENDAR.firstAttendanceDay).trim();
    const endValue = String(req.query.endDate || formatIsoDate(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate())).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startValue) || !/^\d{4}-\d{2}-\d{2}$/.test(endValue) || startValue > endValue) {
      return res.status(400).json({ success: false, message: "Khoảng ngày không hợp lệ" });
    }

    await getSheetData(group);
    const state = getState(group);
    const startDate = new Date(`${startValue}T00:00:00`);
    const endDate = new Date(`${endValue}T23:59:59`);
    const headers = state.cacheData?.[2] || [];
    const attendanceDates = headers.map((header, index) => {
      const value = parseAttendanceDateInRange(header, startDate, endDate);
      if (!value || value < startDate || value > endDate) return null;
      const key = formatIsoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
      const calendar = getDailyAttendanceSchedule(key);
      return calendar && (calendar.massRequired || calendar.catechismRequired)
        ? { index, value, key, calendar, month: key.slice(0, 7) }
        : null;
    }).filter(Boolean).sort((a, b) => a.value - b.value);

    const students = Object.values(state.studentMap)
      .filter(row => !className || String(row[3] || "").trim() === className)
      .filter(row => !requestedStatuses.size || requestedStatuses.has(String(state.statusMap[String(row[1] || "").trim()] || "").trim().toLowerCase()))
      .map(row => ({
        row,
        studentId: String(row[1] || "").trim(),
        status: String(state.statusMap[String(row[1] || "").trim()] || "").trim()
      }));

    const months = new Map();
    const days = attendanceDates.map(item => ({
      date: item.key,
      label: `${String(item.value.getDate()).padStart(2, "0")}/${String(item.value.getMonth() + 1).padStart(2, "0")}`,
      massAbsent: 0,
      catechismAbsent: 0
    }));
    attendanceDates.forEach(item => {
      if (!months.has(item.month)) {
        months.set(item.month, { month: item.month, massExpected: 0, massPresent: 0, catechismExpected: 0, catechismPresent: 0 });
      }
      const month = months.get(item.month);
      if (item.calendar.massRequired) month.massExpected += students.length;
      if (item.calendar.catechismRequired) month.catechismExpected += students.length;
    });

    const attentionStatuses = new Set(["nghỉ ngang", "nợ bài", "thiếu điểm lễ", "thiếu điểm giáo lý"]);
    const attentionStudentIds = new Set();
    const hasThreeConsecutiveAbsences = (student, predicate, symbol) => {
      let streak = 0;
      for (const item of attendanceDates) {
        if (!predicate(item)) continue;
        if (String(student.row[item.index] || "").toUpperCase().includes(symbol)) streak = 0;
        else streak += 1;
        if (streak >= 3) return true;
      }
      return false;
    };

    students.forEach(student => {
      if (attentionStatuses.has(student.status.toLowerCase()) ||
        hasThreeConsecutiveAbsences(student, item => item.calendar.massRequired, "C") ||
        hasThreeConsecutiveAbsences(student, item => item.calendar.catechismRequired, "G")) {
        attentionStudentIds.add(student.studentId);
      }

      attendanceDates.forEach((item, index) => {
        const mark = String(student.row[item.index] || "").trim().toUpperCase();
        const month = months.get(item.month);
        if (item.calendar.massRequired) {
          if (mark.includes("C")) month.massPresent += 1;
          else days[index].massAbsent += 1;
        }
        if (item.calendar.catechismRequired) {
          if (mark.includes("G")) month.catechismPresent += 1;
          else days[index].catechismAbsent += 1;
        }
      });
    });

    const monthly = [...months.values()].map(item => ({
      ...item,
      massRate: item.massExpected ? Math.round(item.massPresent * 1000 / item.massExpected) / 10 : null,
      catechismRate: item.catechismExpected ? Math.round(item.catechismPresent * 1000 / item.catechismExpected) / 10 : null
    }));
    const totalMassExpected = monthly.reduce((sum, item) => sum + item.massExpected, 0);
    const totalMassPresent = monthly.reduce((sum, item) => sum + item.massPresent, 0);
    const totalCatechismExpected = monthly.reduce((sum, item) => sum + item.catechismExpected, 0);
    const totalCatechismPresent = monthly.reduce((sum, item) => sum + item.catechismPresent, 0);

    return res.json({
      success: true,
      filters: { startDate: startValue, endDate: endValue, className, statuses: [...requestedStatuses] },
      summary: {
        students: students.length,
        massRate: totalMassExpected ? Math.round(totalMassPresent * 1000 / totalMassExpected) / 10 : null,
        catechismRate: totalCatechismExpected ? Math.round(totalCatechismPresent * 1000 / totalCatechismExpected) / 10 : null,
        massAbsent: Math.max(0, totalMassExpected - totalMassPresent),
        catechismAbsent: Math.max(0, totalCatechismExpected - totalCatechismPresent),
        attentionCount: attentionStudentIds.size
      },
      monthly,
      trend: days
    });
  } catch (err) {
    console.error("Lỗi tổng quan chất lượng:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================
// API: Học viên cần quan tâm
// =========================
app.get("/attention-students", async (req, res) => {
  try {
    const group = getGroup(req);
    await getSheetData(group);
    const state = getState(group);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const headers = state.cacheData?.[2] || [];
    const firstRow = state.cacheData?.[0] || [];
    const configuredStart = parseAttendanceHeaderDate(firstRow[10], today.getFullYear()); // K1
    const configuredEnd = parseAttendanceHeaderDate(firstRow[12], today.getFullYear()); // M1
    const startDate = configuredStart
      ? new Date(configuredStart.year, configuredStart.month - 1, configuredStart.day)
      : new Date(today.getFullYear(), 0, 1);
    const configuredEndDate = configuredEnd
      ? new Date(configuredEnd.year, configuredEnd.month - 1, configuredEnd.day)
      : today;
    if (configuredEndDate < today) {
      return res.json({
        success: true,
        total: 0,
        students: [],
        classes: [],
        summerBreak: true,
        endDate: configuredEndDate
      });
    }
    const endDate = configuredEndDate < today ? configuredEndDate : today;
    const attendanceDates = headers.map((header, index) => {
      const value = parseAttendanceDateInRange(header, startDate, endDate);
      return value && value >= startDate && value <= endDate ? { index, weekday: value.getDay(), value } : null;
    }).filter(Boolean).sort((a, b) => a.value - b.value);

    const catechismDates = attendanceDates.filter(item => item.weekday === 0).slice(-5);
    const massDates = attendanceDates.filter(item => item.weekday === 0 || item.weekday === 4).slice(-5);
    const attentionStatuses = new Set([
      "ngh\u1ec9 ngang", "n\u1ee3 b\u00e0i", "thi\u1ebfu \u0111i\u1ec3m l\u1ec5", "thi\u1ebfu \u0111i\u1ec3m gi\u00e1o l\u00fd"
    ]);

    const students = Object.values(state.studentMap).map(row => {
      const studentId = String(row[1] || "").trim();
      const status = String(state.statusMap[studentId] || "").trim();
      const reasons = [];
      const isAbsent = (dateItem, symbol) => !String(row[dateItem.index] || "").toUpperCase().includes(symbol);
      const formatDate = item => `${String(item.value.getDate()).padStart(2, "0")}/${String(item.value.getMonth() + 1).padStart(2, "0")}`;
      const absenceStreak = (dates, symbol) => {
        const streak = [];
        for (let index = dates.length - 1; index >= 0; index--) {
          if (!isAbsent(dates[index], symbol)) break;
          streak.unshift(dates[index]);
        }
        return streak;
      };
      const catechismStreak = absenceStreak(catechismDates, "G");
      const massStreak = absenceStreak(massDates, "C");

      if (catechismStreak.length >= 3) {
        reasons.push({ type: "catechism", label: `Vắng Giáo Lý ${catechismStreak.length} CN liên tiếp: ${catechismStreak.map(formatDate).join(", ")}` });
      }
      if (massStreak.length >= 3) {
        reasons.push({ type: "mass", label: `Vắng Thánh Lễ ${massStreak.length} buổi liên tiếp: ${massStreak.map(formatDate).join(", ")}` });
      }
      if (attentionStatuses.has(status.toLowerCase())) {
        reasons.push({ type: "status", label: status });
      }

      return reasons.length ? {
        studentId,
        name: row[2] || "",
        className: row[3] || "",
        status,
        reasons
      } : null;
    }).filter(Boolean);

    const classes = [];
    students.forEach(student => {
      let classGroup = classes.find(item => item.className === student.className);
      if (!classGroup) {
        classGroup = { className: student.className || "Chưa xếp lớp", students: [] };
        classes.push(classGroup);
      }
      classGroup.students.push(student);
    });
    classes.forEach(classGroup => classGroup.students.sort((a, b) => {
      const lastName = name => String(name || "").trim().split(/\s+/).pop() || "";
      return lastName(a.name).localeCompare(lastName(b.name), "vi", { sensitivity: "base" }) ||
        String(a.name || "").localeCompare(String(b.name || ""), "vi", { sensitivity: "base" });
    }));

    return res.json({
      success: true,
      total: students.length,
      students,
      classes,
      criteria: { catechismDays: catechismDates.length, massDays: massDates.length, startDate, endDate }
    });
  } catch (err) {
    console.error("Lỗi danh sách cần quan tâm:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================
// BACKGROUND TASK: Rebuild Summary Cache
// =========================


// =========================
// API: Trigger cập nhật & Lấy Summary
// =========================


app.get("/student-summary", async (req, res) => {
  try {
    const group = getGroup(req);
    await getSheetData(group);
    const state = getState(group);

    const students = Object.values(state.studentMap)
      .sort((a, b) => a._rowNumber - b._rowNumber)
      .map(row => {
        const studentId = String(row[1] || "").trim();
        const score = state.scoreMap[studentId] || {};
        return {
          studentId: row[1] || "",
          name: row[2] || "",
          className: row[3] || "",
          totalMass: Number(row[5] || 0),
          catechism: Number(row[8] || 0),

          status: state.statusMap[studentId] || "",
          // Dùng cho bảng "Top học viên xuất sắc" ở Dashboard GLV — không tốn thêm lượt gọi Sheet
          // vì scoreMap/leaveMap đã có sẵn trong cache khi loadSheetData chạy.
          avgScore: averageScore(score),
          hasExcusedLeave: hasExcusedLeave(state.leaveMap[studentId]),
          avatar: getStudentAvatar(studentId)
        };
      });
    res.json({
      success: true,
      total: students.length,
      students
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// =========================
// API: Mốc cập nhật điểm danh gần nhất
// =========================
app.get("/attendance-last-updated", async (req, res) => {
  try {
    const group = getGroup(req);
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_GROUPS[group],
      range: `${ATTENDANCE_SHEET}!G1`
    });

    const lastUpdated = String(response.data.values?.[0]?.[0] || "Chưa có lần cập nhật nào").trim();
    return res.json({ success: true, lastUpdated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


app.get("/today-attendance", async (req, res) => {
  try {
    const group = getGroup(req);
    const spreadsheetId = SHEET_GROUPS[group];
    const state = getState(group);

    // Luôn lấy dữ liệu mới nhất
    await loadSheetData(group);

    const sheets = await getSheetsClient();

    const headerRes =
      await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${ATTENDANCE_SHEET}!1:3`
      });

    const headers =
      headerRes.data.values?.[2] || [];

    const now = new Date();

    const todayColName =
      `${now.getDate()}/${now.getMonth() + 1}`;

    const dateCol =
      headers.findIndex(
        h => String(h).trim() === todayColName
      );

    console.log("Today:", todayColName);
    console.log("DateCol:", dateCol);

    if (dateCol === -1) {
      return res.json({
        success: false,
        message: `Không tìm thấy cột ${todayColName}`
      });
    }

    const presentStudents = [];
    const absentStudents = [];

    Object.values(state.studentMap).forEach(row => {

      const value =
        String(row[dateCol] || "")
          .trim()
          .toUpperCase();

      const student = {
        studentId: row[1] || "",
        name: row[2] || "",
        className: row[3] || "",
        status:
            state.statusMap[
                String(row[1] || "").trim()
            ] || ""
    };

      // Có mặt nếu là C hoặc CG
      if (value.includes("C")) {
        presentStudents.push(student);
      } else {
        absentStudents.push(student);
      }

    });

    return res.json({
      success: true,
      date: todayColName,
      total: presentStudents.length + absentStudents.length,
      present: presentStudents.length,
      absent: absentStudents.length,
      presentStudents,
      absentStudents
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      success: false,
      error: err.message
    });

  }
});

app.get("/attendance-report", async (req, res) => {

    try {
        const group = getGroup(req);
        const spreadsheetId = SHEET_GROUPS[group];
        const state = getState(group);

        await getSheetData(group);

        const className =
            String(req.query.className || "").trim();

        const date =
            String(req.query.date || "").trim();
        const dateIso =
            String(req.query.dateIso || "").trim();

        if (!date) {
            return res.status(400).json({
                success: false,
                message: "Thiếu ngày"
            });
        }
        const calendar = getDailyAttendanceSchedule(dateIso);

        const sheets =
            await getSheetsClient();

        const headerRes =
            await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${ATTENDANCE_SHEET}!1:3`
            });

        const headers =
            headerRes.data.values?.[2] || [];

        const dateCol =
            headers.findIndex(
                h => String(h).trim() === date
            );

        if (dateCol === -1) {
            return res.json({
                success: false,
                message: `Không tìm thấy cột ${date}`
            });
        }

        const students =
            Object.values(state.studentMap)
            .filter(row => {

                if (!className) return true;

                return (
                    String(row[3] || "").trim()
                    === className
                );

            })
            .map(row => {

                const mark =
                    String(
                        row[dateCol] || ""
                    )
                    .trim()
                    .toUpperCase();

                return {

                    studentId:
                        row[1] || "",

                    name:
                        row[2] || "",

                    className:
                        row[3] || "",

                    status:
                        state.statusMap[
                            String(row[1] || "").trim()
                        ] || "",

                    mark,

                    tl: mark.includes("C"),
                    gl: mark.includes("G"),
                    tt: mark.includes("T"),
                    xt: mark.includes("X")
                };

            });

        res.json({
            success: true,
            total: students.length,
            students,
            calendar
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });

    }

});

// =========================
// API: Refresh Cache
// =========================
app.get("/refresh-cache", async (req, res) => {
  try {
    const group = getGroup(req);
    const state = getState(group);
    state.cacheData = null;
    state.cacheTimestamp = 0;
    state.studentMap = {};
    state.scoreMap = {};
    state.statusMap = {};
    state.statusRowMap = {};
    state.leaveMap = {};
    
    await loadSheetData(group);
    return res.json({ success: true, message: "Cache refreshed" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================
// Home
// =========================
app.get("/", (req, res) => {
  res.json({ success: true, message: "Giaoly API đang hoạt động" });
});

/* AI chat disabled by request.
app.post("/ai/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message || message.length > 500) return res.status(400).json({ success: false, error: "Câu hỏi không hợp lệ" });
    if (!req.env?.AI) return res.status(503).json({ success: false, error: "Chưa cấu hình Workers AI cho trợ lý" });
    const group = getGroup(req);
    const context = await buildAiContext(message, group);
    const normalizedQuestion = normalizeSearch(message);
    if (normalizedQuestion.includes("so dien thoai") || normalizedQuestion.includes("sdt") || normalizedQuestion.includes("dien thoai")) {
      const phoneData = context.match(/:\s*(\[.*\])\.$/);
      if (phoneData) {
        const students = JSON.parse(phoneData[1]);
        const reply = students.map(student => {
          const phones = student.phones?.length ? student.phones.join(", ") : "chưa có số điện thoại";
          return `${student.name} (${student.studentId}, lớp ${student.className}): ${phones}`;
        }).join("\n");
        return res.json({ success: true, reply: reply || "Không tìm thấy số điện thoại." });
      }
      return res.json({ success: true, reply: context });
    }
    const aiResult = await req.env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
      messages: [
        { role: "system", content: "Bạn là trợ lý nội bộ cho giáo lý viên đã được ủy quyền. Chỉ trả lời bằng tiếng Việt, ngắn gọn, lịch sự, và chỉ dùng dữ liệu trong ngữ cảnh. Không suy đoán hoặc bịa dữ liệu. Được phép cung cấp số điện thoại phụ huynh khi câu hỏi hỏi về số điện thoại và ngữ cảnh có số đó, vì đây là tác vụ nghiệp vụ nội bộ. Khi có danh sách, trình bày tên, mã học viên và lớp rõ ràng." },
        { role: "user", content: `Câu hỏi: ${message}\n\nNgữ cảnh dữ liệu đã được Worker lọc: ${context}` }
      ],
      max_tokens: 400
    });
    return res.json({ success: true, reply: aiResult.response || aiResult.result || "Không có phản hồi từ trợ lý AI." });
    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        reasoning: { effort: "low" },
        instructions: "Bạn là trợ lý cho giáo lý viên. Chỉ trả lời bằng tiếng Việt, ngắn gọn, lịch sự, và chỉ dùng dữ liệu trong ngữ cảnh. Không suy đoán hoặc bịa dữ liệu. Khi có danh sách, trình bày tên, mã học viên và lớp rõ ràng.",
        input: `Câu hỏi: ${message}\n\nNgữ cảnh dữ liệu đã được Worker lọc: ${context}`
      })
    });
    const data = await aiResponse.json();
    if (!aiResponse.ok) throw new Error(data?.error?.message || "Không thể gọi dịch vụ AI");
    const reply = data.output_text || data.output?.flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("\n") || "Không có phản hồi từ trợ lý AI.";
    res.json({ success: true, reply });
  } catch (error) {
    console.error("AI chat error:", error);
    res.status(500).json({ success: false, error: error.message || "Không thể xử lý câu hỏi AI" });
  }
});

*/
function formatDateVN(dateStr) {
  const d = new Date(dateStr);

  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();

  return `${dd}/${mm}/${yyyy}`;
}

function formatShortDateVN(dateStr) {
  const [year, month, day] = String(dateStr || "").split("-");
  if (!year || !month || !day) return "";
  return `${day}/${month}`;
}

function formatLeaveDateVN(dateStr) {
  const [year, month, day] = String(dateStr || "").split("-");
  if (!year || !month || !day) return "";
  const weekday = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][new Date(`${dateStr}T00:00:00`).getDay()];
  return `${day}/${month}/${year} (${weekday})`;
}

async function importAttendance(date, classId, group) {

  // Workers may start a fresh isolate for any request. Always load the
  // student map before matching CCAMS attendance instead of relying on a
  // warm in-memory cache left by a previous manual import.
  await getSheetData(group);
  const sheets = await getSheetsClient();
  const spreadsheetId = SHEET_GROUPS[group];
  const state = getState(group);

  const attendance =
    await getAttendanceByClass(
      classId,
      formatDateVN(date)
    );
  console.log(
    "Tổng học viên CCAMS:",
    attendance.length
  );
  console.log("CLASS:", classId);
  console.log("ATTENDANCE:", attendance.slice(0,10));

  const headerRes =
    await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${ATTENDANCE_SHEET}!1:3`
    });

  const headers =
  headerRes.data.values?.[2] || [];

  console.log("Date frontend gửi:", date);
  console.log("Date format VN:", formatDateVN(date));
  console.log("Headers:", headers);

  const d = new Date(date);
  const targetDate =
      `${d.getDate()}/${d.getMonth() + 1}`;

  console.log("Target:", targetDate);

  const dateCol =
      headers.findIndex(
          h => String(h).trim() === targetDate
      );

  if (dateCol === -1) {
    throw new Error(
      `Không tìm thấy cột ngày ${date}`
    );
  }

  const realColumn =
    dateCol + 1;
  

  const updates = [];

  attendance.forEach(item => {

    const student =
      state.studentMap[item.studentId];

    if (!student) return;

    updates.push({
      range:
        `${ATTENDANCE_SHEET}!${columnLetter(realColumn)}${student._rowNumber}`,
      values: [[item.mark]]
    });

  });

  if (updates.length) {

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: updates
      }
    });

  }

  // Không đọc lại cả 3 sheet sau khi vừa ghi; lần request sau sẽ tự nạp cache mới.
  state.cacheData = null;
  state.cacheTimestamp = 0;

  return {
    count: updates.length,
    message:
      `Đã cập nhật ${updates.length} học sinh`
  };
}

app.get("/classes", async (req, res) => {

  try {
    const group = getGroup(req);

    await getSheetData(group);
    const state = getState(group);

    const sheetClasses =
      [...new Set(
        Object.values(state.studentMap)
          .map(r => String(r[3] || "").trim())
          .filter(Boolean)
      )];

    const ccamsClasses =
      await getCCAMSClasses();

    const allowedClassIds = CCAMS_CLASS_IDS_BY_GROUP[group] || [];
    const result = allowedClassIds.length
      ? ccamsClasses.filter(c => allowedClassIds.includes(c.id))
      : ccamsClasses.filter(c => sheetClasses.includes(c.name));

    res.json(result);

  } catch (err) {

    res.status(500).json({
      success: false,
      error: err.message
    });

  }
});

function columnLetter(col) {
  let letter = "";

  while (col > 0) {
    let temp = (col - 1) % 26;

    letter =
      String.fromCharCode(temp + 65) +
      letter;

    col = (col - temp - 1) / 26;
  }

  return letter;
}

async function getSheetsClient() {
  const credentials =
    JSON.parse(process.env.GOOGLE_CREDENTIALS);

  return createSheetsClient(credentials);
}


// =========================
// Start Server
// =========================
if (!globalThis.__CLOUDFLARE_WORKER__) app.listen(PORT, async () => {
  try {
    await Promise.all(Object.keys(SHEET_GROUPS).map(loadSheetData));
    
    // Cho phép rebuild summary chạy ngầm sau khi server đã start
    
  } catch (err) {
    console.error("Không thể tải dữ liệu ban đầu:", err.message);
  }

  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

module.exports = app;

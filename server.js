const ATTENDANCE_SHEET = "Thánh Lễ";
const SCORE_SHEET = "Điểm";
const STATUS_SHEET = "Tình Trạng";
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const {
  getCCAMS,
  getCCAMSStudentProfile,
  getAttendanceByClass,
  getCCAMSClasses
} = require("./services/ccams");

const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHEET_GROUPS = {
  "2b": "1J1Fgyk_Lr5Vp9IK99DVF3Z1SaADpbxonsRNtVim6W_E",
  "1e": "1Fziw9eSbGjA-TLkSqpVbas5gFa9fkwsECLNeb_j11Ww",
  "2f": "1LmM866E7FaPJwsdtE3w7I2tSVU_z3I9YTpndxjfjQVc"
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
  return group;
}

function getState(group) {
  return sheetStates[group];
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

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets"
  ]
});

  const sheets = google.sheets({ version: "v4", auth });

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
    const groups = requestedGroup ? [getGroup(req)] : Object.keys(SHEET_GROUPS);

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

    if (!studentRow) {
      return res.json({ success: false, message: "Không tìm thấy học sinh" });
    }

    const sheetAttendance = getStudentSheetAttendance(state, studentRow);
    
    // Gọi 1 lần duy nhất
    const score = state.scoreMap[studentId] || {};
    const ccamsProfile = await getCCAMSStudentProfile(studentId);

    return res.json({
      success: true,
      studentId: studentRow[1] || "",
      name: studentRow[2] || "",
      className: studentRow[3] || "",
      status:
      state.statusMap[studentId] || "",
      leave: state.leaveMap[studentId] || "",
      leaveItems: splitLeaveItems(state.leaveMap[studentId]),
      group,
      dateOfBirth: ccamsProfile.dateOfBirth || "",
      fatherName: ccamsProfile.fatherName || "",
      motherName: ccamsProfile.motherName || "",
      phones: ccamsProfile.phones || [],
      avatar: `https://ccams.thongtinxuanloc.com/student/bienhoa/${studentId}/image`,
      totalMass: Number(studentRow[5] || 0),
      catechism: Number(studentRow[8] || 0),
      adoration: sheetAttendance.adoration,
      confession: sheetAttendance.confession,
      scores: score,
      attendance: sheetAttendance.attendance
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

    const scheduledMass = countWeekdaysInMonth(year, month, [0, 4]);
    const scheduledCatechism = countWeekdaysInMonth(year, month, [0]);
    const catechismDaysOff = Math.min(scheduledCatechism, Math.max(0, requestedDaysOff || 0));
    const effectiveCatechismDays = scheduledCatechism - catechismDaysOff;
    const students = Object.values(state.studentMap)
      .sort((a, b) => a._rowNumber - b._rowNumber)
      .filter(row => !className || String(row[3] || "").trim() === className)
      .map(row => {
        let massPresent = 0;
        let catechismPresent = 0;
        monthColumns.forEach(({ index }) => {
          const mark = String(row[index] || "").trim().toUpperCase();
          if (mark.includes("C")) massPresent++;
          if (mark.includes("G")) catechismPresent++;
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
      className,
      students
    });
  } catch (err) {
    console.error("Lỗi báo cáo tháng:", err);
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
    const endDate = configuredEndDate < today ? configuredEndDate : today;
    const attendanceDates = headers.map((header, index) => {
      const value = parseAttendanceDateInRange(header, startDate, endDate);
      return value && value >= startDate && value <= endDate ? { index, weekday: value.getDay(), value } : null;
    }).filter(Boolean).sort((a, b) => a.value - b.value);

    const catechismDates = attendanceDates.filter(item => item.weekday === 0).slice(-3);
    const massDates = attendanceDates.filter(item => item.weekday === 0 || item.weekday === 4).slice(-3);
    const attentionStatuses = new Set([
      "ngh\u1ec9 ngang", "n\u1ee3 b\u00e0i", "thi\u1ebfu \u0111i\u1ec3m l\u1ec5", "thi\u1ebfu \u0111i\u1ec3m gi\u00e1o l\u00fd"
    ]);

    const students = Object.values(state.studentMap).map(row => {
      const studentId = String(row[1] || "").trim();
      const status = String(state.statusMap[studentId] || "").trim();
      const reasons = [];
      const isAbsent = (dateItem, symbol) => !String(row[dateItem.index] || "").toUpperCase().includes(symbol);

      if (catechismDates.length === 3 && catechismDates.every(item => isAbsent(item, "G"))) {
        reasons.push({ type: "catechism", label: "Vắng Giáo Lý 3 CN liên tiếp" });
      }
      if (massDates.length === 3 && massDates.every(item => isAbsent(item, "C"))) {
        reasons.push({ type: "mass", label: "Vắng Thánh Lễ 3 buổi liên tiếp" });
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
      .map(row => ({
        studentId: row[1] || "",
        name: row[2] || "",
        className: row[3] || "",
        totalMass: Number(row[5] || 0),
        catechism: Number(row[8] || 0),

        status:
            state.statusMap[
                String(row[1] || "").trim()
            ] || ""
    }));
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

        if (!date) {
            return res.status(400).json({
                success: false,
                message: "Thiếu ngày"
            });
        }

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

    const result =
      ccamsClasses.filter(c =>
        sheetClasses.includes(c.name)
      );

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

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets"
    ]
  });

  return google.sheets({
    version: "v4",
    auth
  });
}


// =========================
// Start Server
// =========================
app.listen(PORT, async () => {
  try {
    await Promise.all(Object.keys(SHEET_GROUPS).map(loadSheetData));
    
    // Cho phép rebuild summary chạy ngầm sau khi server đã start
    
  } catch (err) {
    console.error("Không thể tải dữ liệu ban đầu:", err.message);
  }

  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

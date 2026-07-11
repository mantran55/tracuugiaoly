const ATTENDANCE_SHEET = "Thánh Lễ";
const SCORE_SHEET = "Điểm";
const STATUS_SHEET = "Tình Trạng";
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const {
  getCCAMS,
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
    statusRowMap: {}
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
          range: `${STATUS_SHEET}!A:E`
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

    if (studentId) {

        tempStatusMap[studentId] = status;
        tempStatusRowMap[studentId] = i + 1;

    }
}

  // Cập nhật Cache
  state.cacheData = rows;
  state.cacheTimestamp = Date.now();
  state.studentMap = tempStudentMap;
  state.scoreMap = tempScoreMap;
  state.statusMap = tempStatusMap;
  state.statusRowMap = tempStatusRowMap;

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

    try {
        const group = getGroup(req);

        const {
            fromDate,
            toDate,
            classId
        } = req.body;

        const start =
            new Date(fromDate);

        const end =
            new Date(toDate);

        const results = [];

        for (
            let d = new Date(start);
            d <= end;
            d.setDate(d.getDate() + 1)
        ) {

            const currentDate =
                new Date(
                    d.getTime() -
                    d.getTimezoneOffset() * 60000
                )
                .toISOString()
                .split("T")[0];

            try {

                const result =
                    await importAttendance(
                        currentDate,
                        classId,
                        group
                    );

                results.push({
                    date: currentDate,
                    count: result.count
                });

            } catch (err) {

                results.push({
                    date: currentDate,
                    count: 0
                });

            }
        }

        const lastUpdated = formatShortDateVN(toDate);
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
            success: true,
            results,
            lastUpdated: `cập nhật gần đây: ${lastUpdated}`
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });

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

    const phone = (studentRow[4] || "").toString().trim();
    
    // Gọi 1 lần duy nhất
    const ccamsData =
      await getCCAMSData(
        phone,
        studentId
      );
    const score = state.scoreMap[studentId] || {};

    return res.json({
      success: true,
      studentId: studentRow[1] || "",
      name: studentRow[2] || "",
      className: studentRow[3] || "",
      status:
      state.statusMap[studentId] || "",
      group,
      avatar: `https://ccams.thongtinxuanloc.com/student/bienhoa/${studentId}/image`,
      totalMass: ccamsData.totalMass,
      catechism: ccamsData.catechism,
      adoration: ccamsData.adoration,
      scores: score,
      attendance: ccamsData.attendance
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
    const allowedStatuses = ["đang học", "nghỉ ngang", "nghỉ từ đầu", "chuyển xứ", "nợ bài"];

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
            ] || ""
    }));

    res.json({ success: true, total: students.length, students });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
      if (value === "C" || value === "CG") {
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

                    tl:
                        mark === "C" ||
                        mark === "CG",

                    gl:
                        mark === "G" ||
                        mark === "CG"
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

  await loadSheetData(group);

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

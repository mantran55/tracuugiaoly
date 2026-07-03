const ATTENDANCE_SHEET = "Thánh Lễ";
const SCORE_SHEET = "Điểm";
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
const SPREADSHEET_ID = "1J1Fgyk_Lr5Vp9IK99DVF3Z1SaADpbxonsRNtVim6W_E";

// =========================
// CACHE CONFIG
// =========================
const CACHE_DURATION = 60 * 1000; // 60 giây cho Sheet


let cacheData = null;
let cacheTimestamp = 0;
let studentMap = {};
let scoreMap = {};


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
async function loadSheetData() {
  const credentials =
  JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets"
  ]
});

  const sheets = google.sheets({ version: "v4", auth });

  const [attendanceResponse, scoreResponse] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${ATTENDANCE_SHEET}!A:ZZ`,
      valueRenderOption: "UNFORMATTED_VALUE"
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SCORE_SHEET}!A:L`,
      valueRenderOption: "UNFORMATTED_VALUE"
    })
  ]);

  const rows = attendanceResponse.data.values || [];
  const scoreRows = scoreResponse.data.values || [];

  const tempStudentMap = {};
  const tempScoreMap = {};

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

  // Cập nhật Cache
  cacheData = rows;
  cacheTimestamp = Date.now();
  studentMap = tempStudentMap;
  scoreMap = tempScoreMap;

  console.log(`📥 Reload Sheet thành công (${Object.keys(studentMap).length} học sinh)`);
  return rows;
}

async function getSheetData() {
  if (cacheData && Date.now() - cacheTimestamp < CACHE_DURATION) {
    return cacheData;
  }
  return await loadSheetData();
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

app.post("/import-attendance", async (req,res)=>{

    try{

        const {
            date,
            classId
        } = req.body;

        const result =
            await importAttendance(date,classId);

        res.json({
            success:true,
            ...result
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
    await getSheetData();

    const studentRow = studentMap[studentId];
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
    const score = scoreMap[studentId] || {};

    return res.json({
      success: true,
      studentId: studentRow[1] || "",
      name: studentRow[2] || "",
      className: studentRow[3] || "",
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
// API: Danh sách học sinh (Cho GLV)
// =========================
app.get("/students", async (req, res) => {
  try {
    await getSheetData();
    const students = Object.values(studentMap)
      .sort((a, b) => a._rowNumber - b._rowNumber)
      .map(row => ({
        studentId: row[1] || "",
        name: row[2] || "",
        className: row[3] || "",
        phone: row[4] || ""
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
    await getSheetData();

    const students = Object.values(studentMap)
      .sort((a, b) => a._rowNumber - b._rowNumber)
      .map(row => ({
        studentId: row[1] || "",
        name: row[2] || "",
        className: row[3] || "",
        totalMass: Number(row[5] || 0),
        catechism: Number(row[8] || 0)
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


app.get("/today-attendance", async (req, res) => {
  try {

    // Luôn lấy dữ liệu mới nhất
    await loadSheetData();

    const sheets = await getSheetsClient();

    const headerRes =
      await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
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

    Object.values(studentMap).forEach(row => {

      const value =
        String(row[dateCol] || "")
          .trim()
          .toUpperCase();

      const student = {
        studentId: row[1] || "",
        name: row[2] || "",
        className: row[3] || ""
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


// =========================
// API: Refresh Cache
// =========================
app.get("/refresh-cache", async (req, res) => {
  try {
    cacheData = null; cacheTimestamp = 0;
    studentMap = {}; scoreMap = {};
    
    await loadSheetData();
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

async function importAttendance(date, classId) {

  const sheets = await getSheetsClient();

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
      spreadsheetId: SPREADSHEET_ID,
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
      studentMap[item.studentId];

    if (!student) return;

    updates.push({
      range:
        `${ATTENDANCE_SHEET}!${columnLetter(realColumn)}${student._rowNumber}`,
      values: [[item.mark]]
    });

  });

  if (updates.length) {

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: "RAW",
        data: updates
      }
    });

  }

  await loadSheetData();

  return {
    count: updates.length,
    message:
      `Đã cập nhật ${updates.length} học sinh`
  };
}

app.get("/classes", async (req, res) => {

  try {

    await getSheetData();

    const sheetClasses =
      [...new Set(
        Object.values(studentMap)
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
    // CHỈ load Sheet khi khởi động. KHÔNG await rebuildSummaryCache() để server không bị treo
    await loadSheetData();
    
    // Cho phép rebuild summary chạy ngầm sau khi server đã start
    
  } catch (err) {
    console.error("Không thể tải dữ liệu ban đầu:", err.message);
  }

  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

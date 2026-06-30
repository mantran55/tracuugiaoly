const ATTENDANCE_SHEET = "Thánh Lễ";
const SCORE_SHEET = "Điểm";
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
let visibleRows = 10;
const app = express();

app.use(cors());

const PORT = process.env.PORT || 3000;

const SPREADSHEET_ID =
  "1J1Fgyk_Lr5Vp9IK99DVF3Z1SaADpbxonsRNtVim6W_E";



const CACHE_DURATION = 60 * 1000; // 60 giây

let cacheData = null;
let cacheTimestamp = 0;
let studentMap = {};
let scoreMap = {};

// =========================
// Chuyển Google Serial Date
// =========================

function googleDateToString(serial) {
  if (!serial) return "";

  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400;

  const date = new Date(utcValue * 1000);

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();

  const weekdays = [
    "CN", // 0
    "T2", // 1
    "T3",
    "T4",
    "T5",
    "T6",
    "T7"
  ];

  const thu = weekdays[date.getDay()];

  return {
  date: `${day}/${month}/${year}`,
  weekday: thu
};
}

// =========================
// Đọc Google Sheet
// =========================

async function loadSheetData() {

  const credentials = JSON.parse(
  process.env.GOOGLE_CREDENTIALS
);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ]
});

  const sheets = google.sheets({
    version: "v4",
    auth
  });

  const [attendanceResponse, scoreResponse] =
  await Promise.all([

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

  const rows =
  attendanceResponse.data.values || [];

const scoreRows =
  scoreResponse.data.values || [];

  const tempStudentMap = {};
  const tempScoreMap = {};

  for (let i = 3; i < rows.length; i++) {

  const studentId =
    (rows[i][1] || "")
      .toString()
      .trim();

  if (studentId) {
    tempStudentMap[studentId] = rows[i];
  }
}

  for (let i = 3; i < scoreRows.length; i++) {

  const studentId =
    (scoreRows[i][1] || "")
      .toString()
      .trim();

  if (studentId) {

    tempScoreMap[studentId] = {

      ghkiScore: scoreRows[i][4] || "",
      ghkiResult: scoreRows[i][5] || "",

      chkiScore: scoreRows[i][6] || "",
      chkiResult: scoreRows[i][7] || "",

      ghkiiScore: scoreRows[i][8] || "",
      ghkiiResult: scoreRows[i][9] || "",

      chkiiScore: scoreRows[i][10] || "",
      chkiiResult: scoreRows[i][11] || ""

    };
  }
}

  cacheData = rows;
  cacheTimestamp = Date.now();
  studentMap = tempStudentMap;
  scoreMap = tempScoreMap;

  console.log(
    `📥 Reload Sheet thành công (${Object.keys(studentMap).length} học sinh)`
  );

  return rows;
}

async function getSheetData() {

  const now = Date.now();

  if (
    cacheData &&
    now - cacheTimestamp < CACHE_DURATION
  ) {
    return cacheData;
  }

  return await loadSheetData();
}

// =========================
// API Tra cứu học sinh
// =========================

app.get("/student/:id", async (req, res) => {

  try {

    const studentId =
      req.params.id
        .toString()
        .trim();

    const rows = await getSheetData();

    if (rows.length < 4) {

      return res.status(500).json({
        success: false,
        message: "Sheet không có dữ liệu."
      });
    }

    const studentRow =
      studentMap[studentId];

    const score =
  scoreMap[studentId] || {

    ghkiScore: "",
    ghkiResult: "",

    chkiScore: "",
    chkiResult: "",

    ghkiiScore: "",
    ghkiiResult: "",

    chkiiScore: "",
    chkiiResult: ""

  };

    if (!studentRow) {

      return res.json({
        success: false,
        message: "Không tìm thấy học sinh"
      });
    }

    const headerRow = rows[2];

    const attendance = [];

    for (
      let col = 9;
      col < headerRow.length;
      col++
    ) {

      const value =
        (studentRow[col] || "")
          .toString()
          .trim()
          .toUpperCase();

      if (!value) continue;

      const dateInfo = googleDateToString(headerRow[col]);

attendance.push({
    date: dateInfo.date,
    weekday: dateInfo.weekday,
    mass: value === "C" || value === "CG",
    catechism: value === "G" || value === "CG"
});
    }

    return res.json({

      success: true,

      studentId:
        studentRow[1] || "",

      name:
        studentRow[2] || "",

      className:
        studentRow[3] || "",

      totalMass:
        Number(studentRow[4] || 0),

      weekdayMass:
        Number(studentRow[5] || 0),

      thursdayMass:
        Number(studentRow[6] || 0),

      sundayMass:
        Number(studentRow[7] || 0),

      catechism:
        Number(studentRow[8] || 0),

      scores: score,

      attendance

      

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
// Refresh Cache
// =========================

app.get("/refresh-cache", async (req, res) => {

  try {

    cacheData = null;
    cacheTimestamp = 0;
    studentMap = {};
    scoreMap = {};

    await loadSheetData();

    return res.json({
      success: true,
      message: "Cache refreshed"
    });

  } catch (err) {

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// =========================
// Home
// =========================

app.get("/", (req, res) => {

  res.json({
    success: true,
    message: "Giaoly API đang hoạt động"
  });

});

// =========================
// Start Server
// =========================

app.listen(PORT, async () => {

  try {

    await loadSheetData();

  } catch (err) {

    console.error(
      "Không thể tải dữ liệu ban đầu:",
      err.message
    );
  }

  console.log(
    `🚀 Server running at http://localhost:${PORT}`
  );

});
//services/ccams.js
const axios = require("axios");
const cheerio = require("cheerio");

const cache = {};
const CACHE_TIME = 3 * 60 * 1000; // 3 phút

async function getCCAMS(phone) {
  try {
    const now = Date.now();

    // Kiểm tra cache
    if (
      cache[phone] &&
      now - cache[phone].timestamp < CACHE_TIME
    ) {
      console.log(`⚡ CCAMS Cache: ${phone}`);

      return cache[phone].data;
    }

    let fullHtml = "";
    let page = 1;
    const phoneParam = encodeURIComponent(phone);

    while (true) {
      const response = await axios.get(
        `https://ccams.thongtinxuanloc.com/?phone=${phoneParam}&page=${page}`,
        {
          timeout: 15000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36",
          },
        }
      );

      const html = response.data;

      if (!html || html.length < 100) {
        break;
      }

      fullHtml += html;

      console.log(`📄 CCAMS Page ${page}`);

      // Không còn trang tiếp theo
      if (!html.includes(`page=${page + 1}`)) {
        break;
      }

      page++;
    }

    const $ = cheerio.load(fullHtml);

    const result = {
      html: fullHtml,
      $
    };

    // Lưu cache
    cache[phone] = {
      timestamp: now,
      data: result
    };

    return result;

  } catch (error) {
    console.error(
      "❌ CCAMS Error:",
      error.message
    );

    return {
      html: "",
      $: cheerio.load("")
    };
  }
}

function clearCCAMSCache() {
  Object.keys(cache).forEach(key => {
    delete cache[key];
  });

  console.log("🗑️ CCAMS cache cleared");
}


async function getAttendanceByClass(classId, date) {

  console.log("CCAMS URL:");
  console.log("date =", date);
  console.log("classId =", classId);
  console.log("params =", {
      phone: "0857675733",
      nienhoc: 3,
      khoi_lop: classId,
      loai: "all",
      search: "",
      date,
      to: date
  });
  const response = await axios.get(
    "https://ccams.thongtinxuanloc.com/",
    {
      params: {
        phone: "0857675733",
        nienhoc: 3,
        khoi_lop: classId,
        loai: "all",
        search: "",
        date,
        to: date
      },
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36"
      }
    }
  );

  const $ = cheerio.load(response.data);

  const students = [];

  $("tbody tr").each((_, row) => {

    const td = $(row).find("td");

    if (td.length < 7) return;

    const studentId =
      $(td[1]).text().trim();

    if (!studentId) return;

    const hasMass =
      $(td[5]).html()?.includes("check") ||
      $(td[5]).text().includes("✓");

    const hasCatechism =
      $(td[6]).html()?.includes("check") ||
      $(td[6]).text().includes("✓");

    let mark = "";

    if (hasMass && hasCatechism) {
      mark = "CG";
    } else if (hasMass) {
      mark = "C";
    } else if (hasCatechism) {
      mark = "G";
    }

    students.push({
      studentId,
      mark
    });

  });

  console.log(
    `📥 ${classId} - ${date}: ${students.length} học viên`
  );

  return students;
}

async function getCCAMSClasses() {

  const response = await axios.get(
    "https://ccams.thongtinxuanloc.com/",
    {
      params: {
        phone: "0857675733"
      },
      timeout: 15000
    }
  );

  const $ = cheerio.load(response.data);

  const classes = [];

  $('select[name="khoi_lop"] option').each((_, el) => {

    const id = $(el).attr("value");
    let name = $(el).text().trim();

    name = name.replace(/^---\s*/, "");

    if (
      !id ||
      id === "all" ||
      id.startsWith("k_")
    ) {
      return;
    }

    classes.push({
      id,
      name
    });
  });

  return classes;
}

module.exports = {
  getCCAMS,
  getAttendanceByClass,
  clearCCAMSCache,
  getCCAMSClasses,
  cache
};

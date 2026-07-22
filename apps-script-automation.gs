/*
 * Dán file này vào Extensions > Apps Script của một Google Sheet.
 * 1) Sửa các giá trị trong SCHEDULES.
 * 2) Project Settings > Script properties: thêm AUTOMATION_SECRET.
 * 3) Chạy installAttendanceTriggers() một lần để cấp quyền và tạo lịch chạy.
 */

const API_URL = 'https://tracuugiaoly.onrender.com/scheduled-import';

// classId là mã lớp CCAMS mà dashboard đang dùng khi lấy điểm danh thủ công.
const SCHEDULES = [
  { group: '2b', classId: 'DIEN_MA_LOP_CCAMS_2B', weekdays: [0, 1, 2, 3, 4, 5, 6] },
  { group: '1e', classId: 'DIEN_MA_LOP_CCAMS_1E', weekdays: [0, 1, 2, 3, 4, 5, 6] }
];

function installAttendanceTriggers() {
  const handlers = [
    'runScheduledAttendance',
    'runWeekdayMorningAttendance',
    'runWeekdayEveningAttendance',
    'runWeekdayNightAttendance',
    'runSundayMorningAttendance',
    'runSundayLateMorningAttendance',
    'runSundayAfternoonAttendance',
    'runSundayNightAttendance'
  ];
  ScriptApp.getProjectTriggers()
    .filter(trigger => handlers.includes(trigger.getHandlerFunction()))
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  // Apps Script chạy trong một khoảng thời gian quanh giờ đặt, không đảm bảo chính xác từng phút.
  ScriptApp.newTrigger('runWeekdayMorningAttendance')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .nearMinute(0)
    .create();

  ScriptApp.newTrigger('runWeekdayEveningAttendance')
    .timeBased()
    .everyDays(1)
    .atHour(19)
    .nearMinute(0)
    .create();

  ScriptApp.newTrigger('runWeekdayNightAttendance')
    .timeBased()
    .everyDays(1)
    .atHour(20)
    .nearMinute(0)
    .create();

  ScriptApp.newTrigger('runSundayMorningAttendance')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(7)
    .nearMinute(0)
    .create();

  ScriptApp.newTrigger('runSundayLateMorningAttendance')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(8)
    .nearMinute(45)
    .create();

  ScriptApp.newTrigger('runSundayAfternoonAttendance')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(16)
    .nearMinute(0)
    .create();

  ScriptApp.newTrigger('runSundayNightAttendance')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(20)
    .nearMinute(0)
    .create();
}

// Giữ tên cũ để không cần sửa nếu bạn đã chạy hàm này trước đó.
function installDailyTrigger() {
  installAttendanceTriggers();
}

function runWeekdayMorningAttendance() {
  if (new Date().getDay() !== 0) runScheduledAttendance();
}

function runWeekdayEveningAttendance() {
  if (new Date().getDay() !== 0) runScheduledAttendance();
}

function runWeekdayNightAttendance() {
  if (new Date().getDay() !== 0) runScheduledAttendance();
}

function runSundayMorningAttendance() {
  runScheduledAttendance();
}

function runSundayLateMorningAttendance() {
  runScheduledAttendance();
}

function runSundayAfternoonAttendance() {
  runScheduledAttendance();
}

function runSundayNightAttendance() {
  runScheduledAttendance();
}

function runScheduledAttendance() {
  const now = new Date();
  const weekday = now.getDay(); // CN = 0, Thứ Năm = 4
  const secret = PropertiesService.getScriptProperties().getProperty('AUTOMATION_SECRET');
  if (!secret) throw new Error('Chưa có Script Property AUTOMATION_SECRET');

  const timeZone = 'Asia/Ho_Chi_Minh';
  // Luôn đồng bộ bù ngày hôm qua trước, sau đó mới lấy ngày hôm nay.
  const dates = [
    Utilities.formatDate(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone, 'yyyy-MM-dd'),
    Utilities.formatDate(now, timeZone, 'yyyy-MM-dd')
  ];
  SCHEDULES
    .filter(schedule => schedule.weekdays.includes(weekday))
    .forEach(schedule => {
      if (String(schedule.classId).startsWith('DIEN_')) {
        throw new Error(`Chưa điền classId cho nhóm ${schedule.group}`);
      }
      dates.forEach(date => {
        const response = UrlFetchApp.fetch(`${API_URL}?group=${encodeURIComponent(schedule.group)}`, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-automation-key': secret },
          payload: JSON.stringify({ date, classId: schedule.classId }),
          muteHttpExceptions: true
        });
        const body = response.getContentText();
        console.log(`${schedule.group} - ${date}: ${response.getResponseCode()} ${body}`);
        if (response.getResponseCode() >= 300) {
          throw new Error(`Điểm danh tự động thất bại (${schedule.group}, ${date}): ${body}`);
        }
      });
    });
}

const WEEKDAY_INDEX = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function defaultSettings() {
  return {
    timezone: "Africa/Cairo",
    reportTime: "17:40",
    weeklyOffDays: [5, 6],
    holidays: [],
  };
}

function formatDateInZone(value, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value instanceof Date ? value : new Date(value));
}

function weekdayInZone(value, timeZone) {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "Africa/Cairo",
    weekday: "short",
  })
    .format(value instanceof Date ? value : new Date(value))
    .slice(0, 3)
    .toLowerCase();
  return WEEKDAY_INDEX[label] ?? 0;
}

function publicSettings(row) {
  const base = defaultSettings();
  if (!row) return base;
  return {
    timezone: row.timezone || base.timezone,
    reportTime: row.reportTime || base.reportTime,
    weeklyOffDays: Array.isArray(row.weeklyOffDays) ? row.weeklyOffDays.map(Number) : base.weeklyOffDays,
    holidays: Array.isArray(row.holidays) ? row.holidays : [],
  };
}

function evaluateCalendar(settings, now = new Date()) {
  const config = publicSettings(settings);
  const date = formatDateInZone(now, config.timezone);
  const weekday = weekdayInZone(now, config.timezone);
  if (config.weeklyOffDays.includes(weekday)) {
    return {
      canRunToday: false,
      reason: "weekend",
      date,
      timezone: config.timezone,
      reportTime: config.reportTime,
    };
  }
  const holiday = config.holidays.find((item) => item && item.date === date);
  if (holiday) {
    return {
      canRunToday: false,
      reason: "holiday",
      holidayName: holiday.name || "",
      date,
      timezone: config.timezone,
      reportTime: config.reportTime,
    };
  }
  return {
    canRunToday: true,
    reason: null,
    date,
    timezone: config.timezone,
    reportTime: config.reportTime,
  };
}

async function loadSettings(prisma) {
  if (!prisma?.settings?.findFirst) return defaultSettings();
  const row = await prisma.settings.findFirst();
  return publicSettings(row);
}

module.exports = {
  defaultSettings,
  publicSettings,
  formatDateInZone,
  weekdayInZone,
  evaluateCalendar,
  loadSettings,
};

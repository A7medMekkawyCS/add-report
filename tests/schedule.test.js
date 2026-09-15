const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { evaluateCalendar } = require("../src/lib/schedule");

const settings = {
  timezone: "Africa/Cairo",
  reportTime: "17:40",
  weeklyOffDays: [5, 6],
  holidays: [{ date: "2026-09-16", name: "Prophet's Birthday" }],
};

describe("evaluateCalendar", () => {
  it("skips Friday in Africa/Cairo", () => {
    const result = evaluateCalendar(settings, new Date("2026-09-18T12:00:00+03:00"));
    assert.equal(result.canRunToday, false);
    assert.equal(result.reason, "weekend");
  });

  it("skips a listed holiday", () => {
    const result = evaluateCalendar(settings, new Date("2026-09-16T12:00:00+03:00"));
    assert.equal(result.canRunToday, false);
    assert.equal(result.reason, "holiday");
    assert.equal(result.holidayName, "Prophet's Birthday");
  });

  it("allows a normal weekday", () => {
    const result = evaluateCalendar(settings, new Date("2026-09-15T12:00:00+03:00"));
    assert.equal(result.canRunToday, true);
    assert.equal(result.reportTime, "17:40");
  });
});

const { decryptSecret } = require("../crypto/secrets");
const { extractTaskId } = require("../lib/taskId");
const { reportHash } = require("../lib/hash");
const { evaluateCalendar, loadSettings } = require("../lib/schedule");

function normalizeReport(report) {
  return String(report).replace(/\\n/g, "\n");
}

async function handleSubmitReport(req, res, { prisma, submitTimesheet, mutex }) {
  if (mutex.isRunning) {
    return res.status(409).json({
      success: false,
      message: "Another timesheet submission is already running",
    });
  }

  const body = req.body || {};
  if (body.automationId) {
    return submitByAutomation({ req, res, prisma, submitTimesheet, mutex });
  }
  return submitDeprecated({ req, res, submitTimesheet, mutex });
}

async function submitByAutomation({ req, res, prisma, submitTimesheet, mutex }) {
  const automationId = req.body.automationId;
  const date = String(req.body.date || "").trim();
  const report = normalizeReport(req.body.report || "").trim();

  if (automationId == null || String(automationId).trim() === "") {
    return res.status(400).json({ success: false, message: "automationId is required" });
  }
  if (!date) {
    return res.status(400).json({ success: false, message: "date is required" });
  }
  if (!report) {
    return res.status(400).json({ success: false, message: "report is required" });
  }

  const automation = await prisma.automationRule.findUnique({
    where: { id: automationId },
    include: { user: true, odooProfile: true },
  });

  if (!automation || automation.enabled === false) {
    return res.status(404).json({ success: false, message: "Automation not found or disabled" });
  }
  if (!automation.odooProfile || automation.odooProfile.enabled === false) {
    return res.status(400).json({ success: false, message: "Odoo profile is missing or disabled" });
  }

  const settings = await loadSettings(prisma);
  const when = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00+03:00`) : new Date();
  const calendar = evaluateCalendar(settings, when);
  if (!calendar.canRunToday) {
    return res.status(200).json({
      success: false,
      skipped: true,
      reason: calendar.reason,
      message:
        calendar.reason === "holiday"
          ? `Skipped holiday${calendar.holidayName ? `: ${calendar.holidayName}` : ""}`
          : "Skipped weekend / off day",
    });
  }

  const existing = await prisma.timesheetRun.findUnique({
    where: { automationId_date: { automationId, date } },
  });
  if (existing?.status === "success") {
    return res.status(409).json({
      success: false,
      duplicate: true,
      message: "Timesheet already submitted for this automation/date",
    });
  }

  const hours = Number(automation.hours);
  const taskUrl = automation.odooTaskUrl;
  const taskId = extractTaskId(taskUrl);
  let password;
  try {
    password = decryptSecret(automation.odooProfile.encryptedPassword);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Failed to decrypt Odoo password",
    });
  }

  mutex.isRunning = true;
  try {
    await prisma.timesheetRun.upsert({
      where: { automationId_date: { automationId, date } },
      create: {
        automationId,
        date,
        status: "failed",
        reportHash: reportHash(report),
        errorMessage: null,
      },
      update: {
        status: "failed",
        reportHash: reportHash(report),
        errorMessage: null,
      },
    });

    console.log("[API] submit-report automationId:", automationId, "taskId:", taskId);

    await submitTimesheet({
      report,
      date,
      hours,
      taskUrl,
      odooUrl: automation.odooProfile.odooUrl,
      login: automation.odooProfile.login,
      password,
      employeeName: automation.user?.name || "",
    });

    await prisma.timesheetRun.update({
      where: { automationId_date: { automationId, date } },
      data: { status: "success", errorMessage: null },
    });

    return res.json({
      success: true,
      message: "Timesheet submitted successfully",
      automationId,
      user: automation.user?.name || "",
      project: automation.projectName,
      taskId,
      hours,
      date,
    });
  } catch (err) {
    const message = err.message || "Failed to submit timesheet";
    await prisma.timesheetRun
      .update({
        where: { automationId_date: { automationId, date } },
        data: { status: "failed", errorMessage: message },
      })
      .catch(() => {});
    console.error("[SUBMIT REPORT ERROR]", message);
    return res.status(500).json({
      success: false,
      error: message,
    });
  } finally {
    mutex.isRunning = false;
  }
}

async function submitDeprecated({ req, res, submitTimesheet, mutex }) {
  const { report, date, taskUrl, hours = 7 } = req.body || {};
  const missing = [];
  if (!report || String(report).trim() === "") missing.push("report");
  if (!date || String(date).trim() === "") missing.push("date");
  if (!taskUrl || String(taskUrl).trim() === "") missing.push("taskUrl");
  if (missing.length) {
    return res.status(400).json({
      success: false,
      message: `Missing required field(s): ${missing.join(", ")}`,
    });
  }
  if (Number.isNaN(Number(hours)) || Number(hours) <= 0) {
    return res.status(400).json({
      success: false,
      message: "hours must be a positive number",
    });
  }

  console.warn("[DEPRECATED] submit-report without automationId is deprecated");
  mutex.isRunning = true;
  try {
    const normalizedReport = normalizeReport(report);
    console.log("[API] submit-report taskUrl:", String(taskUrl).trim());
    await submitTimesheet({
      report: normalizedReport,
      date,
      hours,
      taskUrl,
    });
    return res.json({
      success: true,
      message: "Timesheet submitted successfully",
      deprecated: true,
    });
  } catch (err) {
    const message = err.message || "Failed to submit timesheet";
    console.error("[SUBMIT REPORT ERROR]", message);
    return res.status(500).json({
      success: false,
      error: message,
    });
  } finally {
    mutex.isRunning = false;
  }
}

module.exports = { handleSubmitReport };

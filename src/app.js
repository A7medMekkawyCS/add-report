const path = require("path");
const express = require("express");
const { requireApiSecret } = require("./middleware/requireApiSecret");
const { usersRouter, odooProfilesRouter, automationsRouter, settingsRouter } = require("./routes/crud");
const { handleSubmitReport } = require("./services/submitReport");

function createApp(deps = {}) {
  const prisma = deps.prisma || deps.db || require("./db/mongoAdapter");
  const submitTimesheet =
    deps.submitTimesheet || require("../odoo-timesheet-puppeteer").submitTimesheet;
  const mutex = deps.mutex || { isRunning: false };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-API-SECRET");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      success: true,
      message: "Auto Report API is running",
    });
  });

  app.post("/submit-report", requireApiSecret, (req, res) => {
    return handleSubmitReport(req, res, { prisma, submitTimesheet, mutex });
  });

  app.use("/api/users", requireApiSecret, usersRouter(prisma));
  app.use("/api/odoo-profiles", requireApiSecret, odooProfilesRouter(prisma));
  app.use("/api/automations", requireApiSecret, automationsRouter(prisma));
  app.use("/api/settings", requireApiSecret, settingsRouter(prisma));

  const frontendDist = path.join(__dirname, "..", "frontend", "dist");
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api\/)(?!\/submit-report)(?!\/health).*/, (req, res, next) => {
    if (req.method !== "GET") return next();
    res.sendFile(path.join(frontendDist, "index.html"), (err) => {
      if (err) next();
    });
  });

  return app;
}

module.exports = { createApp };

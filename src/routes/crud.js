const { publicOdooProfile } = require("../lib/sanitize");
const { encryptSecret } = require("../crypto/secrets");

function handlePrismaError(err, res) {
  if (err.code === "P2025") {
    return res.status(404).json({ success: false, message: "Not found" });
  }
  if (err.code === "P2002") {
    return res.status(409).json({ success: false, message: "Already exists" });
  }
  if (err.code === "P2003") {
    return res.status(409).json({
      success: false,
      message: "Cannot delete because related records exist",
    });
  }
  console.error("[API ERROR]", err.message);
  return res.status(500).json({ success: false, error: err.message });
}

function usersRouter(prisma) {
  const express = require("express");
  const router = express.Router();

  router.get("/", async (_req, res) => {
    try {
      const users = await prisma.user.findMany({ orderBy: { id: "desc" } });
      return res.json({ success: true, data: users });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const { name, email, enabled = true } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ success: false, message: "name is required" });
      }
      if (!email || !String(email).trim()) {
        return res.status(400).json({ success: false, message: "email is required" });
      }
      const user = await prisma.user.create({
        data: {
          name: String(name).trim(),
          email: String(email).trim().toLowerCase(),
          enabled: Boolean(enabled),
        },
      });
      return res.status(201).json({ success: true, data: user });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.put("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const { name, email, enabled } = req.body || {};
      const data = {};
      if (name != null) data.name = String(name).trim();
      if (email != null) data.email = String(email).trim().toLowerCase();
      if (enabled != null) data.enabled = Boolean(enabled);
      const user = await prisma.user.update({ where: { id }, data });
      return res.json({ success: true, data: user });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      await prisma.user.delete({ where: { id } });
      return res.json({ success: true });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

function odooProfilesRouter(prisma) {
  const express = require("express");
  const router = express.Router();
  const include = { user: true };

  router.get("/", async (_req, res) => {
    try {
      const profiles = await prisma.odooProfile.findMany({ include, orderBy: { id: "desc" } });
      return res.json({ success: true, data: profiles.map(publicOdooProfile) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const { userId, profileKey, odooUrl, login, password, enabled = true } = req.body || {};
      const missing = [];
      if (!userId) missing.push("userId");
      if (!profileKey) missing.push("profileKey");
      if (!odooUrl) missing.push("odooUrl");
      if (!login) missing.push("login");
      if (!password) missing.push("password");
      if (missing.length) {
        return res.status(400).json({
          success: false,
          message: `Missing required field(s): ${missing.join(", ")}`,
        });
      }
      const profile = await prisma.odooProfile.create({
        data: {
          userId,
          profileKey: String(profileKey).trim(),
          odooUrl: String(odooUrl).trim().replace(/\/+$/, ""),
          login: String(login).trim(),
          encryptedPassword: encryptSecret(password),
          enabled: Boolean(enabled),
        },
        include,
      });
      return res.status(201).json({ success: true, data: publicOdooProfile(profile) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.put("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const { userId, profileKey, odooUrl, login, password, enabled } = req.body || {};
      const data = {};
      if (userId != null) data.userId = userId;
      if (profileKey != null) data.profileKey = String(profileKey).trim();
      if (odooUrl != null) data.odooUrl = String(odooUrl).trim().replace(/\/+$/, "");
      if (login != null) data.login = String(login).trim();
      if (enabled != null) data.enabled = Boolean(enabled);
      if (password != null && String(password).trim() !== "") {
        data.encryptedPassword = encryptSecret(password);
      }
      const profile = await prisma.odooProfile.update({ where: { id }, data, include });
      return res.json({ success: true, data: publicOdooProfile(profile) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      await prisma.odooProfile.delete({ where: { id } });
      return res.json({ success: true });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

function automationsRouter(prisma) {
  const express = require("express");
  const router = express.Router();
  const { resolveAutomation, normalizeGitlabPath } = require("../lib/resolveAutomation");
  const { publicAutomation } = require("../lib/sanitize");
  const include = { user: true, odooProfile: { include: { user: true } } };

  router.post("/resolve", async (req, res) => {
    try {
      const { gitlabProjectPath, authorName, authorEmail } = req.body || {};
      const path = String(gitlabProjectPath || "").trim();
      if (!path) {
        return res.status(400).json({ success: false, message: "gitlabProjectPath is required" });
      }
      const rules = await prisma.automationRule.findMany({
        where: { enabled: true },
        include: { user: true },
      });
      const mapped = rules.map((rule) => ({
        ...rule,
        userName: rule.user?.name,
        userEmail: rule.user?.email,
      }));
      return res.json(resolveAutomation(mapped, { gitlabProjectPath: path, authorName, authorEmail }));
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/", async (_req, res) => {
    try {
      const rules = await prisma.automationRule.findMany({ include, orderBy: { id: "desc" } });
      return res.json({ success: true, data: rules.map(publicAutomation) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const rule = await prisma.automationRule.findUnique({ where: { id }, include });
      if (!rule) return res.status(404).json({ success: false, message: "Not found" });
      return res.json({ success: true, data: publicAutomation(rule) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const payload = req.body || {};
      const required = [
        "userId",
        "odooProfileId",
        "name",
        "projectName",
        "gitlabProjectPath",
        "gitlabAuthorName",
        "gitlabAuthorEmail",
        "odooTaskUrl",
      ];
      const missing = required.filter((key) => payload[key] == null || String(payload[key]).trim() === "");
      if (missing.length) {
        return res.status(400).json({
          success: false,
          message: `Missing required field(s): ${missing.join(", ")}`,
        });
      }
      const rule = await prisma.automationRule.create({
        data: {
          userId: payload.userId,
          odooProfileId: payload.odooProfileId,
          name: String(payload.name).trim(),
          enabled: payload.enabled != null ? Boolean(payload.enabled) : true,
          projectName: String(payload.projectName).trim(),
          gitlabProjectPath: normalizeGitlabPath(payload.gitlabProjectPath),
          gitlabAuthorName: String(payload.gitlabAuthorName).trim(),
          gitlabAuthorEmail: String(payload.gitlabAuthorEmail).trim(),
          odooTaskUrl: String(payload.odooTaskUrl).trim(),
          hours: payload.hours != null ? Number(payload.hours) : 7,
          timezone: payload.timezone ? String(payload.timezone).trim() : "Africa/Cairo",
          reportTime: payload.reportTime ? String(payload.reportTime).trim() : "17:40",
          ignoreMergeCommits:
            payload.ignoreMergeCommits != null ? Boolean(payload.ignoreMergeCommits) : true,
        },
        include,
      });
      return res.status(201).json({ success: true, data: publicAutomation(rule) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.put("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const payload = req.body || {};
      const data = {};
      const fields = [
        "name",
        "projectName",
        "gitlabProjectPath",
        "gitlabAuthorName",
        "gitlabAuthorEmail",
        "odooTaskUrl",
        "timezone",
        "reportTime",
      ];
      for (const field of fields) {
        if (payload[field] == null) continue;
        data[field] =
          field === "gitlabProjectPath"
            ? normalizeGitlabPath(payload[field])
            : String(payload[field]).trim();
      }
      if (payload.userId != null) data.userId = payload.userId;
      if (payload.odooProfileId != null) data.odooProfileId = payload.odooProfileId;
      if (payload.hours != null) data.hours = Number(payload.hours);
      if (payload.enabled != null) data.enabled = Boolean(payload.enabled);
      if (payload.ignoreMergeCommits != null) {
        data.ignoreMergeCommits = Boolean(payload.ignoreMergeCommits);
      }
      const rule = await prisma.automationRule.update({ where: { id }, data, include });
      return res.json({ success: true, data: publicAutomation(rule) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      await prisma.automationRule.delete({ where: { id } });
      return res.json({ success: true });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

module.exports = {
  usersRouter,
  odooProfilesRouter,
  automationsRouter,
  handlePrismaError,
};

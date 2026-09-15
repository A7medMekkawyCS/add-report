const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createMemoryPrisma } = require("./helpers/memoryPrisma");

process.env.API_SECRET = "test-secret";
process.env.CREDENTIALS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { encryptSecret } = require("../src/crypto/secrets");
const { createApp } = require("../src/app");

function seedData() {
  const encryptedPassword = encryptSecret("odoo-password-ahmed");
  return {
    users: [
      { id: 3, name: "Ahmed Mekawy", email: "ahmed@example.com", enabled: true },
      { id: 4, name: "Mohamed Emad", email: "mohamed@example.com", enabled: true },
    ],
    odooProfiles: [
      {
        id: 1,
        userId: 3,
        profileKey: "ahmed-main",
        odooUrl: "https://e.aait.sa",
        login: "ahmed@company.com",
        encryptedPassword,
        enabled: true,
      },
      {
        id: 2,
        userId: 4,
        profileKey: "mohamed-main",
        odooUrl: "https://e.aait.sa",
        login: "mohamed@company.com",
        encryptedPassword: encryptSecret("odoo-password-mohamed"),
        enabled: true,
      },
    ],
    automationRules: [
      {
        id: 17,
        userId: 3,
        odooProfileId: 1,
        name: "Ahmed - Haki",
        enabled: true,
        projectName: "Haki",
        gitlabProjectPath: "a5945/mohamed-emad/haki",
        gitlabAuthorName: "Ahmed Mekawy",
        gitlabAuthorEmail: "ahmedmekawyxa@gmail.com",
        odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/23524",
        hours: 7,
        timezone: "Africa/Cairo",
        reportTime: "17:40",
        ignoreMergeCommits: true,
      },
      {
        id: 22,
        userId: 3,
        odooProfileId: 1,
        name: "Ahmed - Zafirra",
        enabled: true,
        projectName: "Zafirra",
        gitlabProjectPath: "a5945/waled-hossam/zafirra",
        gitlabAuthorName: "Ahmed Mekawy",
        gitlabAuthorEmail: "ahmedmekawyxa@gmail.com",
        odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/217398",
        hours: 7,
        timezone: "Africa/Cairo",
        reportTime: "17:40",
        ignoreMergeCommits: true,
      },
      {
        id: 31,
        userId: 4,
        odooProfileId: 2,
        name: "Mohamed - Haki",
        enabled: true,
        projectName: "Haki",
        gitlabProjectPath: "a5945/mohamed-emad/haki",
        gitlabAuthorName: "Mohamed Emad",
        gitlabAuthorEmail: "mohamed@example.com",
        odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/28218",
        hours: 7,
        timezone: "Africa/Cairo",
        reportTime: "17:40",
        ignoreMergeCommits: true,
      },
    ],
    timesheetRuns: [],
  };
}

describe("API", () => {
  let app;
  let prisma;
  let submitted;

  beforeEach(() => {
    prisma = createMemoryPrisma(seedData());
    submitted = [];
    app = createApp({
      prisma,
      submitTimesheet: async (payload) => {
        submitted.push(payload);
      },
    });
  });

  it("GET /health", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  it("rejects n8n endpoints without API secret", async () => {
    const res = await request(app).post("/api/automations/resolve").send({
      gitlabProjectPath: "a5945/mohamed-emad/haki",
    });
    assert.equal(res.status, 401);
  });

  it("creates a user", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("X-API-SECRET", "test-secret")
      .send({ name: "New User", email: "new@example.com" });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.name, "New User");
  });

  it("creates an Odoo profile without returning the password", async () => {
    const res = await request(app)
      .post("/api/odoo-profiles")
      .set("X-API-SECRET", "test-secret")
      .send({
        userId: 3,
        profileKey: "ahmed-secondary",
        odooUrl: "https://e.aait.sa",
        login: "ahmed2@company.com",
        password: "plain-password",
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.profileKey, "ahmed-secondary");
    assert.equal("password" in res.body.data, false);
    assert.equal("encryptedPassword" in res.body.data, false);
    assert.ok(prisma._state.odooProfiles.find((p) => p.profileKey === "ahmed-secondary").encryptedPassword);
  });

  it("keeps the old password when edit password is blank", async () => {
    const before = prisma._state.odooProfiles.find((p) => p.id === 1).encryptedPassword;
    const res = await request(app)
      .put("/api/odoo-profiles/1")
      .set("X-API-SECRET", "test-secret")
      .send({ login: "ahmed-updated@company.com", password: "" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.login, "ahmed-updated@company.com");
    assert.equal(prisma._state.odooProfiles.find((p) => p.id === 1).encryptedPassword, before);
  });

  it("creates an automation", async () => {
    const res = await request(app)
      .post("/api/automations")
      .set("X-API-SECRET", "test-secret")
      .send({
        userId: 3,
        odooProfileId: 1,
        name: "Ahmed - Extra",
        projectName: "Extra",
        gitlabProjectPath: "a5945/example/extra",
        gitlabAuthorName: "Ahmed Mekawy",
        gitlabAuthorEmail: "ahmedmekawyxa@gmail.com",
        odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/11111",
        hours: 6,
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.projectName, "Extra");
  });

  it("resolves Haki/Ahmed", async () => {
    const res = await request(app)
      .post("/api/automations/resolve")
      .set("X-API-SECRET", "test-secret")
      .send({
        gitlabProjectPath: "a5945/mohamed-emad/haki",
        authorName: "Ahmed Mekawy",
        authorEmail: "ahmedmekawyxa@gmail.com",
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.matched, true);
    assert.equal(res.body.automation.id, 17);
    assert.equal("password" in res.body.automation, false);
    assert.equal("encryptedPassword" in res.body.automation, false);
  });

  it("resolves Zafirra/Ahmed to a different task", async () => {
    const res = await request(app)
      .post("/api/automations/resolve")
      .set("X-API-SECRET", "test-secret")
      .send({
        gitlabProjectPath: "a5945/waled-hossam/zafirra",
        authorName: "Ahmed Mekawy",
        authorEmail: "ahmedmekawyxa@gmail.com",
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.automation.id, 22);
    assert.equal(res.body.automation.odooTaskUrl.includes("217398"), true);
  });

  it("returns no match for the wrong author", async () => {
    const res = await request(app)
      .post("/api/automations/resolve")
      .set("X-API-SECRET", "test-secret")
      .send({
        gitlabProjectPath: "a5945/mohamed-emad/haki",
        authorName: "Unknown",
        authorEmail: "unknown@example.com",
      });
    assert.deepEqual(res.body, { matched: false });
  });

  it("returns no match for a disabled automation", async () => {
    prisma._state.automationRules.find((r) => r.id === 17).enabled = false;
    const res = await request(app)
      .post("/api/automations/resolve")
      .set("X-API-SECRET", "test-secret")
      .send({
        gitlabProjectPath: "a5945/mohamed-emad/haki",
        authorName: "Ahmed Mekawy",
        authorEmail: "ahmedmekawyxa@gmail.com",
      });
    assert.deepEqual(res.body, { matched: false });
  });

  it("submits a report by automationId using DB credentials and task URL", async () => {
    const res = await request(app)
      .post("/submit-report")
      .set("X-API-SECRET", "test-secret")
      .send({
        automationId: 17,
        report: "1. Fix email\n2. Update validation",
        date: "2026-09-15",
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.automationId, 17);
    assert.equal(res.body.user, "Ahmed Mekawy");
    assert.equal(res.body.project, "Haki");
    assert.equal(res.body.taskId, "23524");
    assert.equal(res.body.hours, 7);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].taskUrl, "https://e.aait.sa/odoo/my-tasks/23524");
    assert.equal(submitted[0].odooUrl, "https://e.aait.sa");
    assert.equal(submitted[0].login, "ahmed@company.com");
    assert.equal(submitted[0].password, "odoo-password-ahmed");
    assert.equal(submitted[0].hours, 7);
  });

  it("returns 409 for a duplicate automation/date success", async () => {
    await request(app)
      .post("/submit-report")
      .set("X-API-SECRET", "test-secret")
      .send({
        automationId: 17,
        report: "1. First",
        date: "2026-09-15",
      });
    const res = await request(app)
      .post("/submit-report")
      .set("X-API-SECRET", "test-secret")
      .send({
        automationId: 17,
        report: "1. Second",
        date: "2026-09-15",
      });
    assert.equal(res.status, 409);
    assert.equal(res.body.duplicate, true);
    assert.equal(submitted.length, 1);
  });

  it("allows retry after a failed run", async () => {
    prisma._state.timesheetRuns.push({
      id: 1,
      automationId: 17,
      date: "2026-09-15",
      status: "failed",
      errorMessage: "timeout",
    });
    const res = await request(app)
      .post("/submit-report")
      .set("X-API-SECRET", "test-secret")
      .send({
        automationId: 17,
        report: "1. Retry",
        date: "2026-09-15",
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  it("supports deprecated submit-report body", async () => {
    const res = await request(app)
      .post("/submit-report")
      .set("X-API-SECRET", "test-secret")
      .send({
        report: "1. Old flow",
        date: "2026-09-15",
        hours: 7,
        taskUrl: "https://e.aait.sa/odoo/my-tasks/23524",
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.deprecated, true);
    assert.equal(submitted[0].taskUrl, "https://e.aait.sa/odoo/my-tasks/23524");
  });

  it("skips submit-report on a holiday", async () => {
    prisma._state.settings.holidays = [{ date: "2026-09-15", name: "Test holiday" }];
    const res = await request(app)
      .post("/submit-report")
      .set("X-API-SECRET", "test-secret")
      .send({
        automationId: 17,
        report: "1. Should skip",
        date: "2026-09-15",
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.skipped, true);
    assert.equal(res.body.success, false);
    assert.equal(submitted.length, 0);
  });

  it("reads and saves schedule settings", async () => {
    const res = await request(app)
      .put("/api/settings")
      .set("X-API-SECRET", "test-secret")
      .send({
        reportTime: "18:00",
        timezone: "Africa/Cairo",
        weeklyOffDays: [5, 6],
        holidays: [{ date: "2026-10-06", name: "Armed Forces Day" }],
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.reportTime, "18:00");
    assert.equal(res.body.data.holidays[0].date, "2026-10-06");
  });
});

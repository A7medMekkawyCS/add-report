const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { extractTaskId } = require("../src/lib/taskId");
const { publicOdooProfile, publicAutomation } = require("../src/lib/sanitize");

describe("extractTaskId", () => {
  it("extracts the id from a my-tasks URL", () => {
    assert.equal(extractTaskId("https://e.aait.sa/odoo/my-tasks/23524"), "23524");
  });

  it("returns null when the URL has no task id", () => {
    assert.equal(extractTaskId("https://e.aait.sa/odoo/my-tasks"), null);
  });
});

describe("sanitize", () => {
  it("strips encryptedPassword from odoo profiles", () => {
    const cleaned = publicOdooProfile({
      id: 1,
      profileKey: "ahmed-main",
      login: "user@example.com",
      encryptedPassword: "abc",
      password: "plain",
    });
    assert.equal("encryptedPassword" in cleaned, false);
    assert.equal("password" in cleaned, false);
    assert.equal(cleaned.login, "user@example.com");
  });

  it("strips secret fields from automations", () => {
    const cleaned = publicAutomation({
      id: 17,
      name: "Ahmed - Haki",
      encryptedPassword: "abc",
      password: "plain",
    });
    assert.equal("encryptedPassword" in cleaned, false);
    assert.equal("password" in cleaned, false);
    assert.equal(cleaned.id, 17);
  });
});

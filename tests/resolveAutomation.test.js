const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { resolveAutomation } = require("../src/lib/resolveAutomation");

function rule(overrides) {
  return {
    id: 1,
    name: "Ahmed - Haki",
    enabled: true,
    userId: 3,
    userName: "Ahmed Mekawy",
    userEmail: "ahmedmekawyxa@gmail.com",
    projectName: "Haki",
    gitlabProjectPath: "a5945/mohamed-emad/haki",
    gitlabAuthorName: "Ahmed Mekawy",
    gitlabAuthorEmail: "ahmedmekawyxa@gmail.com",
    odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/23524",
    hours: 7,
    timezone: "Africa/Cairo",
    reportTime: "17:40",
    ignoreMergeCommits: true,
    encryptedPassword: "should-never-match-on-this",
    ...overrides,
  };
}

const rules = [
  rule({ id: 17, name: "Ahmed - Haki" }),
  rule({
    id: 22,
    name: "Ahmed - Zafirra",
    projectName: "Zafirra",
    gitlabProjectPath: "a5945/waled-hossam/zafirra",
    odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/217398",
  }),
  rule({
    id: 31,
    name: "Mohamed - Haki",
    userId: 4,
    userName: "Mohamed Emad",
    gitlabAuthorName: "Mohamed Emad",
    gitlabAuthorEmail: "mohamed@example.com",
    odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/28218",
  }),
  rule({
    id: 99,
    name: "Disabled Haki",
    enabled: false,
    gitlabAuthorEmail: "disabled@example.com",
    gitlabAuthorName: "Disabled User",
  }),
];

describe("resolveAutomation", () => {
  it("matches Haki + Ahmed by email", () => {
    const result = resolveAutomation(rules, {
      gitlabProjectPath: "a5945/mohamed-emad/haki",
      authorName: "Ahmed Mekawy",
      authorEmail: "ahmedmekawyxa@gmail.com",
    });
    assert.equal(result.matched, true);
    assert.equal(result.automation.id, 17);
    assert.equal(result.automation.projectName, "Haki");
    assert.equal(result.automation.odooTaskUrl, "https://e.aait.sa/odoo/my-tasks/23524");
  });

  it("matches GitLab path case-insensitively", () => {
    const result = resolveAutomation(rules, {
      gitlabProjectPath: "a5945/waled-hossam/Zafirra",
      authorName: "Ahmed Mekawy",
      authorEmail: "ahmedmekawyxa@gmail.com",
    });
    assert.equal(result.matched, true);
    assert.equal(result.automation.id, 22);
    assert.equal(result.automation.projectName, "Zafirra");
  });

  it("matches Zafirra + Ahmed as a different task", () => {
    const result = resolveAutomation(rules, {
      gitlabProjectPath: "a5945/waled-hossam/zafirra",
      authorName: "Ahmed Mekawy",
      authorEmail: "ahmedmekawyxa@gmail.com",
    });
    assert.equal(result.matched, true);
    assert.equal(result.automation.id, 22);
    assert.equal(result.automation.projectName, "Zafirra");
    assert.equal(result.automation.odooTaskUrl, "https://e.aait.sa/odoo/my-tasks/217398");
  });

  it("matches a different user on the same repo", () => {
    const result = resolveAutomation(rules, {
      gitlabProjectPath: "a5945/mohamed-emad/haki",
      authorName: "Mohamed Emad",
      authorEmail: "mohamed@example.com",
    });
    assert.equal(result.matched, true);
    assert.equal(result.automation.id, 31);
    assert.equal(result.automation.userName, "Mohamed Emad");
    assert.equal(result.automation.odooTaskUrl, "https://e.aait.sa/odoo/my-tasks/28218");
  });

  it("prefers email over name when both are present", () => {
    const result = resolveAutomation(rules, {
      gitlabProjectPath: "a5945/mohamed-emad/haki",
      authorName: "Ahmed Mekawy",
      authorEmail: "mohamed@example.com",
    });
    assert.equal(result.matched, true);
    assert.equal(result.automation.id, 31);
  });

  it("falls back to author name when email does not match", () => {
    const result = resolveAutomation(rules, {
      gitlabProjectPath: "a5945/mohamed-emad/haki",
      authorName: "  AHMED MEKAWY ",
      authorEmail: "unknown@example.com",
    });
    assert.equal(result.matched, true);
    assert.equal(result.automation.id, 17);
  });

  it("returns no match for the wrong author", () => {
    const result = resolveAutomation(rules, {
      gitlabProjectPath: "a5945/mohamed-emad/haki",
      authorName: "Someone Else",
      authorEmail: "someone@example.com",
    });
    assert.deepEqual(result, { matched: false });
  });

  it("returns no match for a disabled automation", () => {
    const result = resolveAutomation(rules, {
      gitlabProjectPath: "a5945/mohamed-emad/haki",
      authorName: "Disabled User",
      authorEmail: "disabled@example.com",
    });
    assert.deepEqual(result, { matched: false });
  });

  it("never returns secret fields", () => {
    const result = resolveAutomation(rules, {
      gitlabProjectPath: "a5945/mohamed-emad/haki",
      authorName: "Ahmed Mekawy",
      authorEmail: "ahmedmekawyxa@gmail.com",
    });
    assert.equal(result.automation.userEmail, "ahmedmekawyxa@gmail.com");
    assert.equal("encryptedPassword" in result.automation, false);
    assert.equal("password" in result.automation, false);
    assert.equal("login" in result.automation, false);
  });
});

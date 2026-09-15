function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeGitlabPath(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function publicAutomation(rule) {
  if (!rule) return null;
  return {
    id: rule.id,
    name: rule.name,
    userId: rule.userId,
    userName: rule.userName,
    userEmail: rule.userEmail || "",
    projectName: rule.projectName,
    gitlabProjectPath: rule.gitlabProjectPath,
    odooTaskUrl: rule.odooTaskUrl,
    hours: rule.hours,
    timezone: rule.timezone,
    reportTime: rule.reportTime,
    ignoreMergeCommits: rule.ignoreMergeCommits,
    enabled: rule.enabled !== false,
  };
}

function resolveAutomation(rules, { gitlabProjectPath, authorName, authorEmail } = {}) {
  const path = normalizeGitlabPath(gitlabProjectPath);
  if (!path) return { matched: false };

  const email = normalize(authorEmail);
  const name = normalize(authorName);

  const candidates = (rules || []).filter(
    (rule) =>
      rule.enabled !== false && normalizeGitlabPath(rule.gitlabProjectPath) === path
  );

  let matched = null;
  if (email) {
    matched = candidates.find((rule) => normalize(rule.gitlabAuthorEmail) === email) || null;
  }
  if (!matched && name) {
    matched = candidates.find((rule) => normalize(rule.gitlabAuthorName) === name) || null;
  }

  if (!matched) return { matched: false };
  return { matched: true, automation: publicAutomation(matched) };
}

module.exports = {
  normalize,
  normalizeGitlabPath,
  resolveAutomation,
};

function normalize(value) {
  return String(value || "").trim().toLowerCase();
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
  };
}

function resolveAutomation(rules, { gitlabProjectPath, authorName, authorEmail } = {}) {
  const path = String(gitlabProjectPath || "").trim();
  if (!path) return { matched: false };

  const email = normalize(authorEmail);
  const name = normalize(authorName);

  const candidates = (rules || []).filter(
    (rule) => rule.enabled !== false && String(rule.gitlabProjectPath || "").trim() === path
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
  resolveAutomation,
};

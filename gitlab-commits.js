const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const axios = require("axios");

/**
 * Fetch the latest commits for the given GitLab project, filtered by author.
 * Looks across ALL branches (so commits pushed to feature branches show up too).
 * @param {Object} params
 * @param {string} params.token        GitLab personal access token
 * @param {string} params.projectId    URL-encoded project path or numeric ID
 * @param {string} [params.authorName] Match commits by author name (case-insensitive, partial)
 * @param {string} [params.authorEmail] Optional: also match by author email
 * @param {string} [params.projectUrl] Used to build commit URLs if API doesn't return web_url
 * @param {number} [params.limit]      Maximum number of commits returned
 * @param {string} [params.since]      ISO date – only commits after this moment
 */
async function getCommits({
  token,
  projectId,
  authorName,
  authorEmail,
  projectUrl,
  limit = 50,
  since,
}) {
  if (!token) throw new Error("GitLab token is missing");
  if (!projectId) throw new Error("GitLab projectId is missing");
  if (!authorName && !authorEmail) {
    throw new Error(
      "Missing author filter. Set GITLAB_AUTHOR_NAME (or <PROJECT>_AUTHOR_NAME) in .env."
    );
  }

  const params = new URLSearchParams({
    per_page: "100",
    all: "true",
    with_stats: "false",
  });
  if (since) params.set("since", since);

  const url = `https://gitlab.com/api/v4/projects/${projectId}/repository/commits?${params}`;
  const res = await axios.get(url, {
    headers: { "PRIVATE-TOKEN": token },
  });

  const wanted = authorName ? authorName.trim().toLowerCase() : "";
  const wantedEmail = authorEmail ? authorEmail.trim().toLowerCase() : "";

  const bySha = new Map();
  for (const c of res.data) {
    if (!bySha.has(c.id)) bySha.set(c.id, c);
  }

  return Array.from(bySha.values())
    .filter((c) => {
      const aName = (c.author_name || "").toLowerCase();
      const cName = (c.committer_name || "").toLowerCase();
      const aEmail = (c.author_email || "").toLowerCase();
      const cEmail = (c.committer_email || "").toLowerCase();
      if (wanted && (aName.includes(wanted) || cName.includes(wanted))) return true;
      if (wantedEmail && (aEmail === wantedEmail || cEmail === wantedEmail))
        return true;
      return false;
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit)
    .map((c) => ({
      message: c.title,
      author: c.author_name,
      date: c.created_at,
      sha: c.id,
      shortSha: c.short_id,
      webUrl:
        c.web_url ||
        (projectUrl ? `${projectUrl.replace(/\/+$/, "")}/-/commit/${c.id}` : ""),
    }));
}

async function listMembershipProjects(token) {
  const projects = [];
  let page = 1;
  for (;;) {
    const res = await axios.get("https://gitlab.com/api/v4/projects", {
      params: {
        membership: true,
        simple: true,
        order_by: "last_activity_at",
        sort: "desc",
        per_page: 100,
        page,
      },
      headers: { "PRIVATE-TOKEN": token },
    });
    projects.push(...res.data);
    if (res.data.length < 100) break;
    page += 1;
  }
  return projects;
}

async function getCommitsAcrossMembershipProjects({
  token,
  authorName,
  authorEmail,
  limit = 50,
  since,
}) {
  const projects = await listMembershipProjects(token);
  const perProjectCap = Math.min(100, Math.max(limit, 20));

  const batchSize = 8;
  const merged = [];
  for (let i = 0; i < projects.length; i += batchSize) {
    const batch = projects.slice(i, i + batchSize);
    const chunk = await Promise.all(
      batch.map(async (p) => {
        try {
          const commits = await getCommits({
            token,
            projectId: p.id,
            projectUrl: p.web_url,
            authorName,
            authorEmail,
            limit: perProjectCap,
            since,
          });
          return commits.map((c) => ({
            ...c,
            projectPath: p.path_with_namespace || String(p.id),
          }));
        } catch (err) {
          const status = err.response?.status;
          if (status === 403 || status === 404) return [];
          throw err;
        }
      })
    );
    merged.push(...chunk.flat());
  }

  const bySha = new Map();
  for (const c of merged) {
    if (!bySha.has(c.sha)) bySha.set(c.sha, c);
  }

  return Array.from(bySha.values())
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limit);
}

module.exports = {
  getCommits,
  getCommitsAcrossMembershipProjects,
  listMembershipProjects,
};

if (require.main === module) {
  const projectArg = (process.argv[2] || "").toUpperCase();
  const mode = (process.argv[3] || "").toLowerCase();
  const FALLBACK = 2;

  const get = (suffix, fallback) =>
    (projectArg && process.env[`${projectArg}_${suffix}`]) || fallback;

  const projectIdFromEnv =
    get("PROJECT_ID", process.env.GITLAB_PROJECT_ID) || null;
  const projectId =
    projectIdFromEnv ||
    (projectArg ? "a5945%2Fwaled-hossam%2FZafirra" : null);
  const projectUrl =
    get("PROJECT_URL", process.env.GITLAB_PROJECT_URL) ||
    (projectArg ? "https://gitlab.com/a5945/waled-hossam/Zafirra" : "");
  const token = get("TOKEN", process.env.GITLAB_TOKEN);
  const authorName = get("AUTHOR_NAME", process.env.GITLAB_AUTHOR_NAME);
  const authorEmail = get("AUTHOR_EMAIL", process.env.GITLAB_AUTHOR_EMAIL);

  const useAllMembershipProjects = !projectArg && !projectIdFromEnv;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  if (useAllMembershipProjects) {
    console.log("Project : all membership projects (GitLab)");
  } else {
    console.log(`Project : ${projectId}`);
  }
  console.log(`Author  : ${authorName}${authorEmail ? ` <${authorEmail}>` : ""}`);

  (async () => {
    try {
      let all;
      if (useAllMembershipProjects) {
        all = await getCommitsAcrossMembershipProjects({
          token,
          authorName,
          authorEmail,
          limit: 50,
        });
      } else {
        all = await getCommits({
          token,
          projectId,
          projectUrl,
          authorName,
          authorEmail,
          limit: 50,
        });
      }

      let commits = all;
      let usedFallback = false;
      if (mode !== "all") {
        const todays = all.filter((c) => new Date(c.date) >= startOfToday);
        if (todays.length > 0) {
          commits = todays;
          console.log(`Today  : ${commits.length} commit(s) found.`);
        } else {
          commits = all.slice(0, FALLBACK);
          usedFallback = true;
          console.log(
            `Today  : 0 commits — falling back to the last ${commits.length}.`
          );
        }
      }

      console.log(
        `\nReturning ${commits.length} commit(s)${
          usedFallback ? " (fallback)" : ""
        }:`
      );
      commits.forEach((c, i) => {
        const t = new Date(c.date).toLocaleString();
        const scope = c.projectPath ? `${c.projectPath} · ` : "";
        console.log(`  ${i + 1}. [${t}] ${scope}${c.author} – ${c.message}`);
      });
    } catch (err) {
      console.error(err.response?.data || err.message);
      process.exit(1);
    }
  })();
}

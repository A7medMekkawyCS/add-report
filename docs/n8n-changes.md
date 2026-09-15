# n8n workflow changes

Keep the existing GitLab webhook, Data Table `daily_commits`, schedule, success email, and Railway HTTP node. Replace hardcoded authors/task URLs with resolve + `automationId`.

Store `API_SECRET` as an n8n credential / environment variable. Do not paste it into node JSON.

## 1. Extract Commit Info

Replace the hardcoded `allowedAuthors` filter with extraction of repo path + author. If `ignoreMergeCommits` later comes from the matched automation, still drop merge commits here as a first pass.

```javascript
const payload = $json.body || $json;
const commits = payload.commits || [];
const branch = (payload.ref || '').replace('refs/heads/', '');
const repoPath =
  payload.project?.path_with_namespace ||
  String(payload.project?.path_with_namespace || payload.repository?.homepage || '')
    .replace(/^https?:\/\/gitlab\.com\//i, '')
    .replace(/\.git$/, '');

return commits.map((commit) => ({
  json: {
    id: commit.id,
    short_id: commit.id?.substring(0, 8),
    title: commit.title || commit.message?.split('\n')[0],
    message: commit.message,
    timestamp: commit.timestamp,
    url: commit.url,
    author_name: commit.author?.name || '',
    author_email: commit.author?.email || '',
    branch,
    repo_path: String(repoPath || '').replace(/^\/+|\/+$/g, ''),
    project: payload.project?.name || payload.repository?.name || '',
  },
}));
```

## 2. Ignore Merge + Dedupe

Keep the current node.

## 3. Resolve automation

Add an HTTP Request node after extract/dedupe:

- Method: `POST`
- URL: `https://YOUR-RAILWAY-HOST/api/automations/resolve`
- Header: `X-API-SECRET` = n8n env `API_SECRET`
- Body:

```json
{
  "gitlabProjectPath": "{{ $json.repo_path }}",
  "authorName": "{{ $json.author_name }}",
  "authorEmail": "{{ $json.author_email }}"
}
```

Then IF `{{ $json.matched }}` is true. If false, stop. The commit does not belong to a configured automation.

Merge the resolve result back onto the commit item before saving:

```javascript
const commit = $('Ignore Merge + Dedupe').item.json;
const resolved = $json;
if (!resolved.matched) return [];
const automation = resolved.automation;
return [{
  json: {
    ...commit,
    automation_id: automation.id,
    user_id: automation.userId,
    project_name: automation.projectName,
    odoo_task_url: automation.odooTaskUrl,
    hours: automation.hours,
    timezone: automation.timezone,
    report_time: automation.reportTime,
    ignore_merge_commits: automation.ignoreMergeCommits,
    processed: false,
  },
}];
```

If `ignore_merge_commits` is true, skip merge titles here too.

## 4. Save to daily_commits

Add columns if missing:

- `repo_path`
- `automation_id`
- `user_id`
- `project_name`
- `odoo_task_url`
- `hours`

Keep `commit_id`, `title`, `timestamp`, `url`, `author_name`, `author_email`, `branch`, `processed`.

## 5. Build reports at 17:40

Replace the hardcoded task URL / allowed authors with grouping by `automation_id`.

```javascript
const rows = $input.all().map((item) => item.json || {});

const dateInZone = (value, timeZone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));

const isMergeCommit = (title, message) => {
  const firstLine = String(title || message || '').split('\n')[0].trim();
  return /^(merge\b|merge branch\b|merge pull request\b|merge remote-tracking\b)/i.test(firstLine);
};

const grouped = new Map();
for (const row of rows) {
  if (!row.automation_id || !row.commit_id || !row.timestamp) continue;
  if (row.ignore_merge_commits !== false && isMergeCommit(row.title, row.message)) continue;
  const timeZone = row.timezone || 'Africa/Cairo';
  const today = dateInZone(new Date(), timeZone);
  if (dateInZone(row.timestamp, timeZone) !== today) continue;
  const key = String(row.automation_id);
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(row);
}

return Array.from(grouped.entries()).map(([automationId, commits]) => {
  const unique = [...new Map(commits.map((row) => [row.commit_id, row])).values()];
  const first = unique[0];
  const report = unique.map((commit, index) => `${index + 1}. ${commit.title}`).join('\n');
  return {
    json: {
      has_commits: unique.length > 0,
      automationId: Number(automationId),
      date: dateInZone(new Date(), first.timezone || 'Africa/Cairo'),
      hours: first.hours,
      project: first.project_name,
      report,
      commits_count: unique.length,
      commits: unique,
    },
  };
});
```

Each item is one report. Loop / split the items and POST once per automation.

## 6. Submit to Railway

Body fields:

- `automationId` = `{{ $json.automationId }}`
- `report` = `{{ $json.report }}`
- `date` = `{{ $json.date }}`

Remove `taskUrl`, `hours`, and any Odoo login/password fields.

Timeout stays 600000. Header remains `X-API-SECRET`.

Treat `409` + `duplicate=true` as already submitted: do not retry, still mark those commits processed if you want to stop reprocessing.

## 7. Examples

Haki / Ahmed resolves to Ahmed's Haki task.

Zafirra / Ahmed resolves to Ahmed's Zafirra task.

Haki / Mohamed resolves to Mohamed's Haki task.

Unknown author → `matched: false` → ignore.

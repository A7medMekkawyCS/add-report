const fs = require("fs");
const path = require("path");

const DATA_TABLE = {
  __rl: true,
  value: "JYLh0ZkfFMHptkar",
  mode: "list",
  cachedResultName: "daily_commits",
  cachedResultUrl: "/projects/RqZrCeVweVm2uW0F/datatables/JYLh0ZkfFMHptkar",
};

const RAILWAY_BASE = "https://add-report-production.up.railway.app";

const gmailCreds = {
  gmailOAuth2: {
    id: "ES4H1R3FE2DBhG9u",
    name: "Gmail account",
  },
};

function col(id, type = "string", extra = {}) {
  return {
    id,
    displayName: id,
    required: false,
    defaultMatch: false,
    display: true,
    type,
    readOnly: false,
    removed: false,
    ...extra,
  };
}

const saveSchema = [
  col("commit_id"),
  col("title"),
  col("timestamp"),
  col("url"),
  col("author_name"),
  col("author_email"),
  col("branch"),
  col("repo_path"),
  col("automation_id"),
  col("user_id"),
  col("user_name"),
  col("project_name"),
  col("hours", "number"),
  col("notification_email"),
  col("report_time"),
  col("timezone"),
  col("processed", "boolean"),
  col("project"),
];

const extractCode = `const payload = $json.body || $json;
const commits = payload.commits || [];

const homepage = String(payload.repository?.homepage || payload.project?.web_url || '');
const repoPath =
  payload.project?.path_with_namespace ||
  homepage
    .replace(/^https?:\\/\\/acgit\\.aait\\.cloud\\//i, '')
    .replace(/^https?:\\/\\/gitlab\\.com\\//i, '')
    .replace(/\\.git$/i, '')
    .replace(/\\/$/, '') ||
  '';

const branch = (payload.ref || '').replace('refs/heads/', '');

return commits.map((commit) => ({
  json: {
    commit_id: commit.id,
    title: commit.title || commit.message?.split('\\n')[0] || '',
    message: commit.message || '',
    timestamp: commit.timestamp,
    url: commit.url,
    author_name: commit.author?.name || '',
    author_email: commit.author?.email || '',
    repo_path: String(repoPath || '').replace(/^\\/+|\\/+$/g, '').toLowerCase(),
    branch,
  },
}));`;

const ignoreMergeCode = `const isMergeCommit = (title, message) => {
  const firstLine = String(title || message || '').split('\\n')[0].trim();
  return /^(merge branch\\b|merge remote\\b|merge pull request\\b|merge\\b)/i.test(firstLine);
};

const seen = new Map();
for (const item of $input.all()) {
  const row = item.json || {};
  const commitId = row.commit_id || row.url;
  if (!commitId) continue;
  if (row.ignore_merge_commits !== false && isMergeCommit(row.title, row.message)) continue;
  if (seen.has(commitId)) continue;
  seen.set(commitId, row);
}

return Array.from(seen.values()).map((json) => ({ json }));`;

const attachCode = `const commit = $('Extract Commit Info').item.json;
const automation = $json.automation;

return [{
  json: {
    ...commit,
    automation_id: automation.id,
    user_id: automation.userId,
    user_name: automation.userName,
    notification_email: automation.userEmail || '',
    project_name: automation.projectName,
    hours: Number(automation.hours ?? 7),
    ignore_merge_commits: automation.ignoreMergeCommits ?? true,
    report_time: automation.reportTime || '17:40',
    timezone: automation.timezone || 'Africa/Cairo',
    processed: false,
  },
}];`;

const buildReportsCode = `const rows = $input.all()
  .map((i) => i.json)
  .filter((row) => row.processed === false && row.automation_id);

const cairoDate = (value) => {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
};

const today = cairoDate(new Date());

const todayRows = rows.filter((row) => {
  if (!row.timestamp) return false;
  return cairoDate(row.timestamp) === today;
});

const dedupeMap = new Map();
for (const row of todayRows) {
  const key = \`\${row.automation_id}:\${row.commit_id || row.url}\`;
  if (!dedupeMap.has(key)) dedupeMap.set(key, row);
}

const uniqueRows = [...dedupeMap.values()];
const groups = {};

for (const row of uniqueRows) {
  const key = String(row.automation_id);
  if (!groups[key]) {
    groups[key] = {
      automationId: row.automation_id,
      userId: row.user_id,
      user: row.user_name,
      notificationEmail: row.notification_email || '',
      project: row.project_name,
      hours: Number(row.hours || 7),
      reportTime: row.report_time || '17:40',
      timezone: row.timezone || 'Africa/Cairo',
      rows: [],
    };
  }
  groups[key].rows.push(row);
}

const result = Object.values(groups).map((group) => {
  const report = group.rows
    .map((row, index) => \`\${index + 1}. \${row.title}\`)
    .join('\\n');
  return {
    json: {
      automationId: group.automationId,
      userId: group.userId,
      user: group.user,
      notificationEmail: group.notificationEmail,
      project: group.project,
      date: today,
      hours: group.hours,
      reportTime: group.reportTime,
      timezone: group.timezone,
      commits_count: group.rows.length,
      report,
      row_ids: group.rows.map((r) => r.id).filter(Boolean),
      commit_ids: group.rows.map((r) => r.commit_id).filter(Boolean),
      has_commits: group.rows.length > 0,
    },
  };
});

if (result.length === 0) {
  return [{ json: { has_commits: false, date: today, report: '', commits_count: 0 } }];
}
return result;`;

const applyDashboardCode = `const report = $('Build Dynamic Reports').item.json;
const live = $json.data || {};

if (!live.id && !live.userId) {
  return [];
}
if (live.enabled === false) {
  return [];
}

const minutesFromHhmm = (value) => {
  const match = String(value || '17:40').match(/(\\d{1,2}):(\\d{2})/);
  if (!match) return 17 * 60 + 40;
  return Number(match[1]) * 60 + Number(match[2]);
};

const nowMinutes = (timeZone) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
};

const timezone = live.timezone || report.timezone || 'Africa/Cairo';
const reportTime = live.reportTime || report.reportTime || '17:40';
if (nowMinutes(timezone) < minutesFromHhmm(reportTime)) {
  return [];
}

return [{
  json: {
    ...report,
    hours: Number(live.hours ?? report.hours ?? 7),
    project: live.projectName || report.project,
    user: live.user?.name || live.userName || report.user,
    notificationEmail: live.user?.email || live.userEmail || report.notificationEmail,
    has_commits: true,
  },
}];`;

const prepareSubmitCode = `const report = $json;
return [{
  json: {
    automationId: report.automationId,
    report: report.report,
    date: report.date,
    row_ids: report.row_ids || [],
    commit_ids: report.commit_ids || [],
    user: report.user,
    notificationEmail: report.notificationEmail || '',
    project: report.project,
    hours: report.hours,
    commits_count: report.commits_count,
    has_commits: report.has_commits,
  },
}];`;

const prepareProcessedCode = `const report = $('Prepare Submit Payload').item.json;
const rowIds = report.row_ids || [];
if (rowIds.length) {
  return rowIds.map((id) => ({ json: { id, processed: true } }));
}
return (report.commit_ids || []).map((commit_id) => ({
  json: { commit_id, processed: true },
}));`;

const prepareSuccessEmailCode = `const report = $('Prepare Submit Payload').item.json;
return [{
  json: {
    notificationEmail: report.notificationEmail,
    user: report.user,
    project: report.project,
    date: report.date,
    hours: report.hours,
    commits_count: report.commits_count,
    report: report.report,
    automationId: report.automationId,
  },
}];`;

const prepareFailureEmailCode = `const report = $('Prepare Submit Payload').item.json;
const railway = $json;
return [{
  json: {
    notificationEmail: report.notificationEmail,
    user: report.user,
    project: report.project,
    date: report.date,
    hours: report.hours,
    automationId: report.automationId,
    error: railway.error || railway.message || 'Submit failed',
  },
}];`;

const workflow = {
  name: "auto-report",
  nodes: [
    {
      parameters: { httpMethod: "POST", path: "gitlab-commits", options: {} },
      type: "n8n-nodes-base.webhook",
      typeVersion: 2.1,
      position: [-800, 592],
      id: "59953f59-1b9c-449d-839c-9d9bcb3bb030",
      name: "Collect GitLab Commits",
      webhookId: "22bdde68-cc92-4f0f-83cd-431b056cdc24",
    },
    {
      parameters: { jsCode: extractCode },
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [-560, 592],
      id: "9cbac8d2-619b-4df5-9761-53f486fc0856",
      name: "Extract Commit Info",
    },
    {
      parameters: {
        method: "POST",
        url: `${RAILWAY_BASE}/api/automations/resolve`,
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: "X-API-SECRET", value: "={{ $vars.API_SECRET }}" }],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody:
          "={{ JSON.stringify({ gitlabProjectPath: $json.repo_path, authorName: $json.author_name, authorEmail: $json.author_email }) }}",
        options: { response: { response: { neverError: true } } },
      },
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.5,
      position: [-320, 592],
      id: "7c1a2b3d-4e5f-4a61-b001-resolveautom01",
      name: "Resolve Automation",
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
          conditions: [
            {
              id: "afound-matched-true-0001",
              leftValue: "={{ $json.matched }}",
              rightValue: "",
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
      type: "n8n-nodes-base.if",
      typeVersion: 2.3,
      position: [-80, 592],
      id: "7c1a2b3d-4e5f-4a61-b002-automationfnd",
      name: "Automation Found?",
    },
    {
      parameters: { jsCode: attachCode },
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [160, 496],
      id: "7c1a2b3d-4e5f-4a61-b003-attachautomat",
      name: "Attach Automation",
    },
    {
      parameters: { jsCode: ignoreMergeCode },
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [400, 496],
      id: "70cbe0ed-9090-4342-9df4-60c5a5f39f23",
      name: "Ignore Merge + Dedupe",
    },
    {
      parameters: {
        operation: "rowNotExists",
        dataTableId: DATA_TABLE,
        matchType: "allConditions",
        filters: {
          conditions: [{ keyName: "commit_id", keyValue: "={{ $json.commit_id }}" }],
        },
      },
      type: "n8n-nodes-base.dataTable",
      typeVersion: 1.1,
      position: [640, 496],
      id: "152a96ba-06bd-47a3-9907-40c817e54f31",
      name: "Commit Not Saved Yet",
    },
    {
      parameters: {
        dataTableId: DATA_TABLE,
        columns: {
          mappingMode: "defineBelow",
          value: {
            commit_id: "={{ $json.commit_id }}",
            title: "={{ $json.title }}",
            timestamp: "={{ $json.timestamp }}",
            url: "={{ $json.url }}",
            author_name: "={{ $json.author_name }}",
            author_email: "={{ $json.author_email }}",
            branch: "={{ $json.branch }}",
            repo_path: "={{ $json.repo_path }}",
            automation_id: "={{ $json.automation_id }}",
            user_id: "={{ $json.user_id }}",
            user_name: "={{ $json.user_name }}",
            project_name: "={{ $json.project_name }}",
            hours: "={{ $json.hours }}",
            report_time: "={{ $json.report_time }}",
            timezone: "={{ $json.timezone }}",
            notification_email: "={{ $json.notification_email }}",
            processed: "={{ false }}",
            project: "={{ $json.project_name }}",
          },
          matchingColumns: [],
          schema: saveSchema,
          attemptToConvertTypes: false,
          convertFieldsToString: false,
        },
        options: {},
      },
      type: "n8n-nodes-base.dataTable",
      typeVersion: 1.1,
      position: [880, 496],
      id: "6bd70c5a-6228-452d-813a-5e65fb3c45d4",
      name: "Save processed=false",
    },
    {
      parameters: {
        rule: {
          interval: [{ field: "minutes", minutesInterval: 5 }],
        },
      },
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.4,
      position: [-800, 880],
      id: "a47404c0-5001-4508-a2ca-24dc9dcf7052",
      name: "Schedule Trigger",
    },
    {
      parameters: {
        operation: "get",
        dataTableId: DATA_TABLE,
        filters: {
          conditions: [{ keyName: "processed", condition: "isFalse" }],
        },
        returnAll: true,
      },
      type: "n8n-nodes-base.dataTable",
      typeVersion: 1.1,
      position: [-560, 880],
      id: "42c9da51-cbb5-4a07-9ccf-deadaee324d1",
      name: "Get processed=false",
      alwaysOutputData: true,
    },
    {
      parameters: { jsCode: buildReportsCode },
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [-320, 880],
      id: "f49a31c6-a0e4-48b4-9f15-8795fe114b5c",
      name: "Build Dynamic Reports",
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
          conditions: [
            {
              id: "a69248a3-9c51-4a3c-a6a9-12cf32bf3e69",
              leftValue: "={{ $json.has_commits }}",
              rightValue: "",
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
      type: "n8n-nodes-base.if",
      typeVersion: 2.3,
      position: [-80, 880],
      id: "1f9a197e-8fc7-48a2-ad00-35ea0ea37c29",
      name: "If has_commits",
    },
    {
      parameters: {
        method: "GET",
        url: `={{ '${RAILWAY_BASE}/api/automations/' + $json.automationId }}`,
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: "X-API-SECRET", value: "={{ $vars.API_SECRET }}" }],
        },
        options: {
          response: {
            response: { neverError: true },
          },
        },
      },
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.5,
      position: [80, 784],
      id: "7c1a2b3d-4e5f-4a61-b007-loadautomation",
      name: "Load Automation",
    },
    {
      parameters: { jsCode: applyDashboardCode },
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [160, 688],
      id: "7c1a2b3d-4e5f-4a61-b008-applydashboard",
      name: "Apply Dashboard Config",
    },
    {
      parameters: { jsCode: prepareSubmitCode },
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [160, 784],
      id: "7c1a2b3d-4e5f-4a61-b004-preparesubmit",
      name: "Prepare Submit Payload",
    },
    {
      parameters: {
        method: "POST",
        url: `${RAILWAY_BASE}/submit-report`,
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: "X-API-SECRET", value: "={{ $vars.API_SECRET }}" }],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody:
          "={{ JSON.stringify({ automationId: $json.automationId, report: $json.report, date: $json.date }) }}",
        options: {
          response: { response: { neverError: true } },
          timeout: 600000,
        },
      },
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.5,
      position: [400, 784],
      id: "78040f60-949e-4818-8372-c38311d18bdf",
      name: "Submit to Railway",
      retryOnFail: false,
      onError: "continueRegularOutput",
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 3 },
          conditions: [
            {
              id: "e5f6a7b8-c9d0-4123-e456-f708192a3b4c",
              leftValue: "={{ $json.success === true || $json.duplicate === true }}",
              rightValue: "",
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
      type: "n8n-nodes-base.if",
      typeVersion: 2.3,
      position: [640, 784],
      id: "0c5efc91-9893-43ff-b43f-4efe6ea9ff58",
      name: "If success",
    },
    {
      parameters: { jsCode: prepareProcessedCode },
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [880, 688],
      id: "2bd27168-2b39-4f5a-84e8-eace9c2132de",
      name: "Prepare processed rows",
    },
    {
      parameters: {
        operation: "update",
        dataTableId: DATA_TABLE,
        matchType: "allConditions",
        filters: {
          conditions: [{ keyName: "id", keyValue: "={{ $json.id }}" }],
        },
        columns: {
          mappingMode: "defineBelow",
          value: { processed: "={{ true }}" },
          matchingColumns: ["id"],
          schema: [col("id", "string", { defaultMatch: true }), col("processed", "boolean")],
          attemptToConvertTypes: false,
          convertFieldsToString: false,
        },
        options: {},
      },
      type: "n8n-nodes-base.dataTable",
      typeVersion: 1.1,
      position: [1120, 688],
      id: "ef7a63c2-fa4e-4778-b21a-1c6d7a4f34b1",
      name: "Mark processed=true",
    },
    {
      parameters: { jsCode: prepareSuccessEmailCode },
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1360, 688],
      id: "0d30eeb9-753d-41e0-a8aa-7588a1af82a1",
      name: "Prepare success email",
    },
    {
      parameters: {
        sendTo: "={{ $json.notificationEmail }}",
        subject: "✅ Daily Report Uploaded - {{ $json.project }} - {{ $json.date }}",
        message:
          "=Employee: {{ $json.user }}\nProject: {{ $json.project }}\nDate: {{ $json.date }}\nHours: {{ $json.hours }}\nCommits: {{ $json.commits_count }}\n\nReport:\n{{ $json.report }}\n\nStatus:\nUploaded successfully to Odoo.",
        options: { appendAttribution: false },
      },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.2,
      position: [1600, 688],
      id: "929c8ef0-36a9-4da5-9ce4-1975ff0ec037",
      name: "Send a message",
      webhookId: "a46059ba-9552-4d9d-98c9-f55132700f75",
      credentials: gmailCreds,
    },
    {
      parameters: { jsCode: prepareFailureEmailCode },
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [880, 960],
      id: "7c1a2b3d-4e5f-4a61-b005-preparefailml",
      name: "Prepare failure email",
    },
    {
      parameters: {
        sendTo: "={{ $json.notificationEmail }}",
        subject: "❌ Daily Report Failed - {{ $json.project }} - {{ $json.date }}",
        message:
          "=Employee: {{ $json.user }}\nProject: {{ $json.project }}\nAutomation ID: {{ $json.automationId }}\nDate: {{ $json.date }}\n\nError:\n{{ $json.error }}",
        options: { appendAttribution: false },
      },
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.2,
      position: [1120, 960],
      id: "7c1a2b3d-4e5f-4a61-b006-sendfailgmail",
      name: "Send failure message",
      credentials: gmailCreds,
    },
  ],
  pinData: {},
  connections: {
    "Collect GitLab Commits": {
      main: [[{ node: "Extract Commit Info", type: "main", index: 0 }]],
    },
    "Extract Commit Info": {
      main: [[{ node: "Resolve Automation", type: "main", index: 0 }]],
    },
    "Resolve Automation": {
      main: [[{ node: "Automation Found?", type: "main", index: 0 }]],
    },
    "Automation Found?": {
      main: [[{ node: "Attach Automation", type: "main", index: 0 }], []],
    },
    "Attach Automation": {
      main: [[{ node: "Ignore Merge + Dedupe", type: "main", index: 0 }]],
    },
    "Ignore Merge + Dedupe": {
      main: [[{ node: "Commit Not Saved Yet", type: "main", index: 0 }]],
    },
    "Commit Not Saved Yet": {
      main: [[{ node: "Save processed=false", type: "main", index: 0 }]],
    },
    "Schedule Trigger": {
      main: [[{ node: "Get processed=false", type: "main", index: 0 }]],
    },
    "Get processed=false": {
      main: [[{ node: "Build Dynamic Reports", type: "main", index: 0 }]],
    },
    "Build Dynamic Reports": {
      main: [[{ node: "If has_commits", type: "main", index: 0 }]],
    },
    "If has_commits": {
      main: [[{ node: "Load Automation", type: "main", index: 0 }], []],
    },
    "Load Automation": {
      main: [[{ node: "Apply Dashboard Config", type: "main", index: 0 }]],
    },
    "Apply Dashboard Config": {
      main: [[{ node: "Prepare Submit Payload", type: "main", index: 0 }]],
    },
    "Prepare Submit Payload": {
      main: [[{ node: "Submit to Railway", type: "main", index: 0 }]],
    },
    "Submit to Railway": {
      main: [[{ node: "If success", type: "main", index: 0 }]],
    },
    "If success": {
      main: [
        [{ node: "Prepare processed rows", type: "main", index: 0 }],
        [{ node: "Prepare failure email", type: "main", index: 0 }],
      ],
    },
    "Prepare processed rows": {
      main: [[{ node: "Mark processed=true", type: "main", index: 0 }]],
    },
    "Mark processed=true": {
      main: [[{ node: "Prepare success email", type: "main", index: 0 }]],
    },
    "Prepare success email": {
      main: [[{ node: "Send a message", type: "main", index: 0 }]],
    },
    "Prepare failure email": {
      main: [[{ node: "Send failure message", type: "main", index: 0 }]],
    },
  },
  active: false,
  settings: {
    executionOrder: "v1",
    binaryMode: "separate",
    timeSavedMode: "fixed",
    timezone: "Africa/Cairo",
    callerPolicy: "workflowsFromSameOwner",
    availableInMCP: false,
  },
  versionId: "670b232a-11cc-4f63-a7eb-b1fd267574c5",
  meta: {
    templateCredsSetupCompleted: true,
    instanceId: "736466bab75bccfae6c7e5bdc308419908d577e83bae14c55e94ed4c44a41b92",
  },
  nodeGroups: [],
  id: "Yg0tscwRNFit4TZA",
  tags: [],
};

const outDir = path.join(__dirname, "..", "n8n");
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, "dynamic-auto-report-workflow.json");
fs.writeFileSync(dest, `${JSON.stringify(workflow, null, 2)}\n`);
fs.writeFileSync(
  path.join(__dirname, "..", "auto-report (1).json"),
  `${JSON.stringify(workflow, null, 2)}\n`
);
console.log("Wrote", dest);

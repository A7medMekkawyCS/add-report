require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const path = require("path");
const readline = require("readline/promises");
const puppeteer = require("puppeteer");
const { getCommits } = require("./gitlab-commits");

const FALLBACK_COUNT = 3;
const COMMIT_LIMIT = 100;
const NOTEBOOK_TAB = "Timesheets";
const USER_DATA_DIR = path.join(__dirname, ".puppeteer-profile");

/** `.env` lines like KEY="https://..."` — strip wrapping quotes so the URL matches the file. */
function trimEnvQuotes(value) {
  if (value == null) return value;
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** GitLab API `projectId`: URL-encoded path (`group%2Fsub%2Frepo`) from a repo HTTPS URL. */
function gitlabProjectIdFromRepoUrl(repoUrl) {
  const u = trimEnvQuotes(repoUrl);
  if (!u) return null;
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (!path) return null;
    return path.replace(/\//g, "%2F");
  } catch {
    return null;
  }
}

function parseClockToday(hm) {
  const [h, m] = String(hm).split(":").map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** Billable hours for a day (float). Uses DAILY_HOURS if set, else WORK_END − WORK_START − BREAK_HOURS. */
function billableHoursForConfig(cfg) {
  const workStart = parseClockToday(cfg.workStart);
  const workEnd = parseClockToday(cfg.workEnd);
  const workDuration = (workEnd - workStart) / (1000 * 60 * 60);
  if (cfg.dailyHours != null && Number.isFinite(cfg.dailyHours)) {
    return Math.max(0, cfg.dailyHours);
  }
  return Math.max(0, workDuration - cfg.breakHours);
}

/** Hours string for Odoo backend list (decimal). */
function formatHoursForOdoo(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return String(h);
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/\.?0+$/, "");
}

/** Hours as HH:MM for portal "Time Spent" column (e.g. 7 → "07:00"). */
function formatHoursAsTimeSpent(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return String(h);
  const totalMinutes = Math.round(n * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function isPortalMyTasksUrl(url) {
  return /\/odoo\/my-tasks\/\d+/i.test(String(url || ""));
}

function getOdooBaseUrl(odooUrl) {
  return trimEnvQuotes(odooUrl || process.env.ODOO_URL || "https://e.aait.sa").replace(/\/+$/, "");
}

function normalizeReport(report) {
  return String(report).replace(/\\n/g, "\n");
}

function extractMyTaskId(url) {
  const m = String(url || "").match(/my-tasks\/(\d+)/i);
  return m ? m[1] : null;
}

function extractBackendTaskId(url) {
  const m = String(url || "").match(/[?&#]id=(\d+)/i);
  return m ? m[1] : null;
}

function getExpectedTaskId(taskUrl) {
  return extractMyTaskId(taskUrl) || extractBackendTaskId(taskUrl);
}

async function assertCorrectTaskOpen(page, taskUrl) {
  const expectedId = getExpectedTaskId(taskUrl);
  const currentUrl = page.url();
  console.log("[ODOO] current URL after navigation:", currentUrl);

  if (expectedId && !currentUrl.includes(expectedId)) {
    throw new Error(
      `Wrong task opened. Expected task ${expectedId}, current URL: ${currentUrl}`
    );
  }
}

async function navigateToTask(page, taskUrl) {
  const finalTaskUrl = trimEnvQuotes(String(taskUrl || "").trim());
  if (!finalTaskUrl) throw new Error("taskUrl is required");

  console.log("[ODOO] taskUrl received:", finalTaskUrl);
  console.log("[ODOO] navigating to task...");

  try {
    await page.goto(finalTaskUrl, { waitUntil: "networkidle2", timeout: 60_000 });
  } catch {
    await page.goto(finalTaskUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  await assertCorrectTaskOpen(page, finalTaskUrl);
  console.log("[ODOO] Task opened");
  return finalTaskUrl;
}

async function verifyTimesheetSaved(page, report) {
  const firstLine = String(report).split("\n")[0].trim();
  if (!firstLine) throw new Error("Cannot verify timesheet: report is empty");

  console.log("[ODOO] Verifying timesheet");
  await sleep(1500);

  const found = await page
    .waitForFunction(
      (text) => {
        const tables = Array.from(
          document.querySelectorAll(".o_list_view table, table.o_list_table, table")
        );
        for (const table of tables) {
          const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
            (th.textContent || "").trim().toLowerCase()
          );
          if (
            !headers.some(
              (h) =>
                h.includes("description") ||
                h.includes("time spent") ||
                h.includes("وصف") ||
                h.includes("وقت")
            )
          ) {
            continue;
          }
          for (const td of table.querySelectorAll("tbody td")) {
            if ((td.textContent || "").includes(text)) return true;
          }
        }
        return false;
      },
      { timeout: 15_000 },
      firstLine
    )
    .then(() => true)
    .catch(() => false);

  if (!found) {
    throw new Error(
      `Timesheet save verification failed. Report not found after save: ${firstLine}`
    );
  }
  console.log("[ODOO] Timesheet verified successfully");
}

async function logPageContextOnError(page) {
  if (!page) return;
  try {
    console.log("[ODOO] Current URL on error:", page.url());
    console.log("[ODOO] Page title:", await page.title());
  } catch {
    // ignore
  }
}

function resolveProjectConfig(projectName) {
  const upper = projectName ? projectName.toUpperCase() : "";
  // Per-script vars (e.g. ZAFIRRA_PROJECT_URL) take precedence; fall back to
  // a generic GITLAB_*/ODOO_* only if no script-scoped value is defined.
  const get = (suffix, fallback) => {
    if (upper) {
      const scoped = process.env[`${upper}_${suffix}`];
      if (scoped !== undefined && scoped !== "") return scoped;
    }
    return fallback;
  };
  const gitlabProjectUrl = trimEnvQuotes(
    get("PROJECT_URL", process.env.GITLAB_PROJECT_URL)
  );
  let gitlabProjectId = trimEnvQuotes(get("PROJECT_ID", process.env.GITLAB_PROJECT_ID));
  if (!gitlabProjectId && gitlabProjectUrl) {
    gitlabProjectId = gitlabProjectIdFromRepoUrl(gitlabProjectUrl);
  }

  return {
    projectName: projectName || "default",
    // GitLab
    token: trimEnvQuotes(get("TOKEN", process.env.GITLAB_TOKEN)),
    gitlabProjectId,
    // Repo root URL (Odoo + GitLab API); PROJECT_ID optional if PROJECT_URL is set (derived).
    gitlabProjectUrl,
    authorName: trimEnvQuotes(get("AUTHOR_NAME", process.env.GITLAB_AUTHOR_NAME)),
    authorEmail: trimEnvQuotes(get("AUTHOR_EMAIL", process.env.GITLAB_AUTHOR_EMAIL)),
    // Odoo
    taskUrl: trimEnvQuotes(get("TASK_URL", process.env.ODOO_TASK_URL)),
    timesheetField: process.env.ODOO_TIMESHEET_FIELD || "timesheet_ids",
    descField: process.env.ODOO_DESC_FIELD || "name",
    hoursField: process.env.ODOO_HOURS_FIELD || "unit_amount",
    gitField: process.env.ODOO_GIT_FIELD || "x_git_link",
    // Workday split
    workStart: process.env.WORK_START || "10:00",
    workEnd: process.env.WORK_END || "18:00",
    breakHours: Number(process.env.BREAK_HOURS ?? 1),
    dailyHours: process.env.DAILY_HOURS ? Number(process.env.DAILY_HOURS) : null,
    projects: (process.env.PROJECTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Browser
    headless: process.env.ODOO_HEADLESS === "1",
    slowMoMs: Number(process.env.ODOO_SLOW_MO_MS || 25),
  };
}

function getOdooFieldConfig() {
  return {
    timesheetField: process.env.ODOO_TIMESHEET_FIELD || "timesheet_ids",
    descField: process.env.ODOO_DESC_FIELD || "name",
    hoursField: process.env.ODOO_HOURS_FIELD || "unit_amount",
    gitField: process.env.ODOO_GIT_FIELD || "x_git_link",
    dateField: process.env.ODOO_DATE_FIELD || "date",
    employeeField: process.env.ODOO_EMPLOYEE_FIELD || "employee_id",
  };
}

function getEmployeeName() {
  return trimEnvQuotes(
    process.env.ODOO_EMPLOYEE_NAME || process.env.GITLAB_AUTHOR_NAME || ""
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toOdooDateString(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function scopeSelector(fieldName) {
  if (!/^[a-z][a-z0-9_]*$/i.test(fieldName)) {
    throw new Error(`Refusing unsafe timesheet field name: ${fieldName}`);
  }
  return `div[name="${fieldName}"]`;
}

/** Build a map of column header text → { name, index } from the timesheet table. */
async function getHeaderMap(page, fieldName) {
  const root = scopeSelector(fieldName);
  return page.$$eval(`${root} thead th`, (ths) => {
    const map = {};
    ths.forEach((th, idx) => {
      const text = (th.textContent || "").trim();
      const name = th.getAttribute("name") || th.getAttribute("data-name");
      if (text) map[text.toLowerCase()] = { name, index: idx, text };
    });
    return map;
  });
}

async function countDataRows(page, fieldName) {
  return page.$$eval(
    `${scopeSelector(fieldName)} tbody tr.o_data_row`,
    (rows) => rows.length
  );
}

/** Inject tab helpers into every new document (browser context). */
async function installBrowserTabHelpers(page) {
  await page.evaluateOnNewDocument(() => {
    window.__odooTabHelpers = function odooTabHelpers() {
      function tabAliases(wanted) {
        const w = String(wanted || "").trim().toLowerCase();
        return [
          w,
          "timesheets",
          "timesheet",
          "hours spent",
          "الجداول الزمنية",
          "الجدول الزمني",
          "سجلات الدوام",
          "سجل الوقت",
          "جداول البيانات",
          "ساعات العمل",
          "ساعات",
          "الساعات",
          "جداول",
        ];
      }

      function tabTextMatches(rawText, wanted) {
        const raw = String(rawText || "").trim().toLowerCase();
        const text = raw
          .replace(/\s*\(\d+\)\s*$/, "")
          .replace(/\s*\d+\s*$/, "")
          .trim();
        const hay = `${raw} ${text}`;
        if (/\btimesheets?\b/.test(hay)) return true;
        const phrases = tabAliases(wanted).filter((t) => t && t.length >= 4);
        if (phrases.some((t) => hay.includes(t))) return true;
        return ["ساعات", "الساعات", "جداول"].some(
          (t) => text === t || text.startsWith(t + " ") || raw.startsWith(t)
        );
      }

      function clickMoreNotebookMenu() {
        const labels = ["more", "المزيد", "أخرى", "other"];
        const nodes = Array.from(
          document.querySelectorAll(
            ".o_notebook .nav-link, .o_notebook button, .o_notebook .dropdown-toggle, .nav-tabs .dropdown-toggle, .o_notebook [role='tab']"
          )
        );
        const el = nodes.find((node) => {
          const t = (node.textContent || "").trim().toLowerCase();
          if (!t || t.length > 24) return false;
          return labels.some((lbl) => t === lbl || t.startsWith(lbl + " ") || t.startsWith(lbl));
        });
        if (!el) return false;
        el.click();
        return true;
      }

      function elementOwnText(el) {
        return Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent || "").trim())
          .join(" ")
          .trim();
      }

      function collectTabCandidates() {
        const selectors = [
          ".o_notebook .nav-link",
          ".o_notebook_headers a",
          ".o_notebook a",
          ".nav-tabs a",
          ".nav-tabs button",
          ".nav-item a",
          ".nav-item button",
          ".nav-item label",
          '[role="tab"]',
          '[role="tablist"] a',
          '[role="tablist"] button',
          "a.nav-link",
          "button.nav-link",
          ".o_group .nav a",
          ".o_group .nav button",
        ];
        const seen = new Set();
        const links = [];
        const add = (el) => {
          if (el && !seen.has(el)) {
            seen.add(el);
            links.push(el);
          }
        };
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(add);
        }
        document.querySelectorAll("a, button, label, [role='tab'], li").forEach((el) => {
          const text = (elementOwnText(el) || el.textContent || "").trim();
          if (text.length > 0 && text.length <= 40) add(el);
        });
        return links;
      }

      function findTabClickTargets(wanted) {
        const targets = [];
        const seen = new Set();
        const add = (el) => {
          const clickEl =
            el.closest('a, button, [role="tab"], li, label, .nav-link, .nav-item') || el;
          if (clickEl && !seen.has(clickEl)) {
            seen.add(clickEl);
            targets.push(clickEl);
          }
        };

        collectTabCandidates().forEach((el) => {
          const text = elementOwnText(el) || el.textContent || "";
          if (tabTextMatches(text, wanted)) add(el);
        });

        document.querySelectorAll("a, button, label, span, div, li, [role='tab']").forEach((el) => {
          const text = (elementOwnText(el) || el.textContent || "").trim();
          if (!text || text.length > 40) return;
          if (tabTextMatches(text, wanted)) add(el);
        });

        return targets;
      }

      function dispatchClick(el) {
        el.scrollIntoView({ block: "center", inline: "center" });
        if (typeof el.click === "function") el.click();
        ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
          el.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
          );
        });
      }

      function isAddLineVisibleInDom() {
        const labels = ["add a line", "add line", "إضافة بند", "أضف سطراً"];
        return Array.from(document.querySelectorAll("a, button, td, span, div")).some((el) => {
          const t = (el.textContent || "").trim().toLowerCase();
          return labels.some((lbl) => t === lbl || t.startsWith(lbl));
        });
      }

      function isTimesheetTableVisibleInDom() {
        const tables = Array.from(
          document.querySelectorAll(".o_list_view table, table.o_list_table, table")
        );
        const hasTable = tables.some((table) => {
          const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
            (th.textContent || "").trim().toLowerCase()
          );
          return headers.some(
            (h) =>
              h.includes("time spent") ||
              h.includes("description") ||
              h.includes("date") ||
              h.includes("وصف") ||
              h.includes("تاريخ") ||
              h.includes("وقت") ||
              h.includes("موظف")
          );
        });
        return hasTable || isAddLineVisibleInDom();
      }

      function isTabActive(el) {
        const navItem = el.closest(".nav-item");
        return (
          el.classList.contains("active") ||
          el.getAttribute("aria-selected") === "true" ||
          el.classList.contains("selected") ||
          Boolean(navItem && navItem.classList.contains("active"))
        );
      }

      function listVisibleTabLabels() {
        return collectTabCandidates()
          .map((el) => (el.textContent || "").trim())
          .filter(Boolean)
          .slice(0, 30);
      }

      function clickTabByLabel(wanted) {
        let targets = findTabClickTargets(wanted);
        if (!targets.length) {
          clickMoreNotebookMenu();
          targets = findTabClickTargets(wanted);
        }
        if (!targets.length) {
          return { found: false, tabs: listVisibleTabLabels(), openedMore: true };
        }
        const visible = targets.find((target) => {
          const rect = target.getBoundingClientRect();
          return rect.width >= 2 && rect.height >= 2;
        });
        const target = visible || targets[0];
        dispatchClick(target);
        return {
          found: true,
          active: isTabActive(target),
          text: (target.textContent || "").trim(),
          hidden: !visible,
        };
      }

      return {
        tabTextMatches,
        collectTabCandidates,
        findTabClickTargets,
        isTimesheetTableVisibleInDom,
        isAddLineVisibleInDom,
        isTabActive,
        listVisibleTabLabels,
        clickTabByLabel,
        clickMoreNotebookMenu,
      };
    };

    /** Set input/textarea/contenteditable without Illegal invocation (correct prototype). */
    window.__odooNativeSetValue = function odooNativeSetValue(el, value, fireChange = true) {
      if (!el) return false;
      const text = String(value);
      if (el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        if (fireChange) el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
        return false;
      }
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc?.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      if (fireChange) el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
  });
}

async function isTimesheetTableVisible(page) {
  return page.evaluate(() => window.__odooTabHelpers().isTimesheetTableVisibleInDom());
}

async function waitForTimesheetsContent(page, timeoutMs = 15_000) {
  await page.waitForFunction(
    () => window.__odooTabHelpers().isTimesheetTableVisibleInDom(),
    { timeout: timeoutMs }
  );
}

async function logVisibleTabs(page) {
  const tabs = await page.evaluate(() => window.__odooTabHelpers().listVisibleTabLabels());
  console.log("[ODOO] Visible tabs on page:", tabs.join(" | ") || "(none)");
}

/** Click an Odoo notebook / portal tab by visible label; confirm via active state or content. */
async function openNotebookTab(page, label) {
  const wanted = String(label).trim().toLowerCase();
  const isTimesheets = wanted.includes("timesheet");

  if (isTimesheets && (await isTimesheetTableVisible(page))) {
    console.log("[ODOO] Timesheets content already visible");
    return;
  }

  await page
    .waitForFunction(
      () => {
        const h = window.__odooTabHelpers();
        return (
          h.collectTabCandidates().length > 0 ||
          h.isTimesheetTableVisibleInDom() ||
          document.body.innerText.toLowerCase().includes("description")
        );
      },
      { timeout: 45_000 }
    )
    .catch(() => {
      console.warn("[ODOO] Task form tabs not ready yet — continuing");
    });

  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await page.evaluate((wantedInner) => {
      return window.__odooTabHelpers().clickTabByLabel(wantedInner);
    }, wanted);

    if (!result.found) {
      console.log(`[ODOO] Tab "${label}" not found yet (attempt ${attempt + 1}/10)`);
      if (result.tabs?.length) {
        console.log(`[ODOO] Visible tabs: ${result.tabs.join(" | ")}`);
      }
      await page.evaluate(() => {
        const h = window.__odooTabHelpers();
        if (typeof h.clickMoreNotebookMenu === "function") h.clickMoreNotebookMenu();
        window.scrollTo(0, Math.min(document.body.scrollHeight, 800));
      });
      await sleep(1000);
      continue;
    }

    console.log(`[ODOO] Clicked tab "${result.text || label}"`);
    await sleep(1200);

    if (isTimesheets) {
      const ready = await page
        .waitForFunction(() => window.__odooTabHelpers().isTimesheetTableVisibleInDom(), {
          timeout: 12_000,
        })
        .then(() => true)
        .catch(() => false);
      if (ready) {
        console.log("[ODOO] Timesheets tab opened");
        return;
      }
    }

    if (result.active) return;

    await sleep(600);
  }

  if (isTimesheets && (await isTimesheetTableVisible(page))) {
    console.log("[ODOO] Timesheets content visible after retries");
    return;
  }

  if (isTimesheets) {
    console.log("[ODOO] Trying mouse click fallback for Timesheets tab");
    const points = await page.evaluate((wantedInner) => {
      return window.__odooTabHelpers()
        .findTabClickTargets(wantedInner)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            text: (el.textContent || "").trim(),
          };
        })
        .filter((p) => p.x > 0 && p.y > 0);
    }, wanted);

    for (const pt of points) {
      console.log(`[ODOO] Mouse click on tab "${pt.text}" at (${Math.round(pt.x)}, ${Math.round(pt.y)})`);
      await page.mouse.click(pt.x, pt.y);
      await sleep(1500);
      if (await isTimesheetTableVisible(page)) {
        console.log("[ODOO] Timesheets tab opened (mouse fallback)");
        return;
      }
    }
  }

  if (isTimesheets && (await isTimesheetTableVisible(page))) {
    return;
  }

  const tabs = await page.evaluate(() => window.__odooTabHelpers().listVisibleTabLabels());
  console.log("[ODOO] Visible tabs on page:", tabs.join(" | ") || "(none)");
  throw new Error(
    `Could not activate notebook tab "${label}". Visible tabs: ${tabs.join(" | ") || "(none)"}`
  );
}

async function waitForTimesheetWidget(page, fieldName) {
  const root = scopeSelector(fieldName);
  await page.waitForSelector(root, { timeout: 120_000 });
  await page.waitForSelector(`${root} table`, { timeout: 120_000 });
  await page.$eval(root, (el) => el.scrollIntoView({ block: "center" }));
}

/** Click the x2many "Add a line" control (language-agnostic). */
async function clickAddLine(page, fieldName) {
  const clicked = await page.evaluate((fname) => {
    const root = document.querySelector(`div[name="${fname}"]`);
    if (!root) return { ok: false, reason: "no_root" };

    const selectors = [
      ".o_field_x2many_list_row_add a",
      ".o_field_x2many_list_row_add button",
      "a.o_list_button_add",
      "button.o_list_button_add",
      ".o_list_button_add",
    ];
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.click();
        return { ok: true };
      }
    }

    const labels = ["add a line", "add line", "إضافة بند", "أضف بنداً", "أضف سطراً", "إضافة سطر"];
    const match = Array.from(root.querySelectorAll("a, button, span, td")).find((el) => {
      const t = (el.textContent || "").trim().toLowerCase();
      return labels.some((lbl) => t === lbl || t.startsWith(lbl));
    });
    if (match) {
      match.scrollIntoView({ block: "center" });
      /** @type {HTMLElement} */ (match).click();
      return { ok: true };
    }
    return { ok: false, reason: "not_found" };
  }, fieldName);

  if (!clicked.ok) {
    throw new Error(`Could not find "Add a line" inside "${fieldName}" (${clicked.reason}).`);
  }
}

const EDITABLE_INPUT_SEL =
  "input.o_input, textarea.o_input, input:not([type='hidden']):not([type='checkbox']), textarea, [contenteditable='true'], [contenteditable], [role='textbox']";

/** Data cells in an Odoo list row (excludes delete/selector columns). */
async function getRowDataCells(row) {
  const indices = await row.evaluate((tr) =>
    Array.from(tr.querySelectorAll("td"))
      .map((td, index) => ({ td, index }))
      .filter(
        ({ td }) =>
          !td.classList.contains("o_list_record_remove") &&
          !td.classList.contains("o_list_button") &&
          !td.classList.contains("o_list_record_selector") &&
          !td.querySelector(".o_list_record_remove, button[name='delete']")
      )
      .map(({ index }) => index)
  );
  const allTds = await row.$$("td");
  return indices.map((i) => allTds[i]).filter(Boolean);
}

/** Activate a list cell using real mouse coordinates (more reliable in Odoo OWL). */
async function clickCellForEdit(page, cell) {
  await cell.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  await sleep(120);

  const box = await cell.boundingBox();
  if (box && box.width > 0 && box.height > 0) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await sleep(180);
    await page.mouse.click(x, y, { clickCount: 2 });
    await sleep(350);
    return;
  }

  await cell.click({ clickCount: 2 });
  await sleep(350);
}

/** Type into the cell after mouse activation when Odoo keeps display mode without a visible input. */
async function typeIntoActivatedCell(page, cell, text) {
  await clickCellForEdit(page, cell);

  const value = String(text);
  const applied = await cell.evaluate((td, v) => {
    const isEditable = (el) => {
      if (!el) return false;
      if (el instanceof HTMLInputElement) return el.type !== "hidden" && el.type !== "checkbox";
      return el instanceof HTMLTextAreaElement || el.matches("[contenteditable], [role='textbox']");
    };

    const pick = () => {
      for (const sel of ["textarea", "input:not([type='hidden'])", "[contenteditable]", "[role='textbox']"]) {
        const inCell = td.querySelector(sel);
        if (isEditable(inCell)) return inCell;
      }
      const ae = document.activeElement;
      if (ae && td.contains(ae) && isEditable(ae)) return ae;

      const cellRect = td.getBoundingClientRect();
      for (const el of document.querySelectorAll(
        "input.o_input, textarea.o_input, textarea, [contenteditable], [role='textbox']"
      )) {
        if (!isEditable(el) || el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        if (
          r.top >= cellRect.top - 30 &&
          r.bottom <= cellRect.bottom + 30 &&
          r.left >= cellRect.left - 12 &&
          r.right <= cellRect.right + 12
        ) {
          return el;
        }
      }
      return null;
    };

    const target = pick();
    if (!target) return false;
    return window.__odooNativeSetValue(target, v, true);
  }, value);

  if (!applied) return false;

  await page.keyboard.press("Tab");
  await sleep(250);
  return true;
}

/** Try one strategy to activate Odoo list cell edit mode. */
async function tryActivateCellEdit(page, cell, attempt) {
  await cell.evaluate((el) => {
    el.scrollIntoView({ block: "center", inline: "center" });
  });

  if (attempt === 0) {
    await cell.evaluate((td) => {
      const widget = td.querySelector(".o_field_widget");
      if (widget && typeof widget.click === "function") widget.click();
      else if (typeof td.click === "function") td.click();
    });
  } else if (attempt === 1) {
    await cell.click({ clickCount: 2 });
  } else if (attempt === 2) {
    await cell.evaluate((td) => {
      td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      const widget = td.querySelector(".o_field_widget");
      if (widget) {
        widget.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      }
    });
  } else if (attempt === 3) {
    await cell.click();
    await page.keyboard.press("F2");
  } else if (attempt === 4) {
    await cell.click({ clickCount: 3 });
  } else {
    await cell.click({ clickCount: 2 });
    await sleep(120);
    await page.keyboard.press("Enter");
  }
  await sleep(350);
}

/**
 * Find editable input for a specific cell only.
 * Uses in-cell DOM first, then geometry overlap (Odoo floating editors).
 */
async function findEditableInput(page, cell) {
  const fromCell = await cell.$(EDITABLE_INPUT_SEL);
  if (fromCell) return fromCell;

  const handle = await cell.evaluateHandle((td) => {
    const isEditable = (el) => {
      if (!el || !(el instanceof Element)) return false;
      if (el instanceof HTMLInputElement) {
        return el.type !== "hidden" && el.type !== "checkbox";
      }
      return (
        el instanceof HTMLTextAreaElement ||
        el.matches("[contenteditable], [role='textbox']") ||
        el.classList.contains("o_input")
      );
    };

    const queryIn = (root) => {
      const selectors = [
        "input.o_input",
        "textarea.o_input",
        "input:not([type='hidden']):not([type='checkbox'])",
        "textarea",
        "[contenteditable='true']",
        "[contenteditable]",
        "[role='textbox']",
      ];
      for (const sel of selectors) {
        const el = root.querySelector(sel);
        if (isEditable(el)) return el;
      }
      return null;
    };

    let found = queryIn(td);
    if (found) return found;

    const widget = td.querySelector(".o_field_widget");
    if (widget) {
      found = queryIn(widget);
      if (found) return found;
    }

    const ae = document.activeElement;
    if (ae && td.contains(ae) && isEditable(ae)) return ae;

    const cellRect = td.getBoundingClientRect();
    const candidates = Array.from(
      document.querySelectorAll(
        "input.o_input, textarea.o_input, textarea, [contenteditable='true'], [contenteditable], [role='textbox']"
      )
    );
    for (const el of candidates) {
      if (!isEditable(el) || el.offsetParent === null) continue;
      if (td.contains(el)) return el;
      const r = el.getBoundingClientRect();
      if (
        r.width > 0 &&
        r.height > 0 &&
        r.top >= cellRect.top - 24 &&
        r.bottom <= cellRect.bottom + 24 &&
        r.left >= cellRect.left - 8 &&
        r.right <= cellRect.right + 8
      ) {
        return el;
      }
    }

    if (ae && isEditable(ae) && ae.offsetParent !== null) {
      const r = ae.getBoundingClientRect();
      if (
        r.width > 0 &&
        r.top >= cellRect.top - 24 &&
        r.bottom <= cellRect.bottom + 24 &&
        r.left >= cellRect.left - 8 &&
        r.right <= cellRect.right + 8
      ) {
        return ae;
      }
    }

    return null;
  });
  return handle.asElement();
}

async function waitForEditableInput(page, cell, timeoutMs = 12000) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    await tryActivateCellEdit(page, cell, attempt);
    const input = await findEditableInput(page, cell);
    if (input) return input;
    attempt += 1;
    await sleep(250);
  }
  return null;
}

/** Last-resort: set value inside the target cell via DOM APIs (still cell-scoped). */
async function setCellValueDirect(cell, text, { treatAsUrl = false } = {}) {
  return cell.evaluate(
    (td, value, asUrl) => {
      const isEditable = (el) => {
        if (!el) return false;
        if (el instanceof HTMLInputElement) return el.type !== "hidden" && el.type !== "checkbox";
        return el instanceof HTMLTextAreaElement || el.matches("[contenteditable], [role='textbox']");
      };

      const pick = () => {
        const selectors = [
          "textarea",
          "input:not([type='hidden']):not([type='checkbox'])",
          "[contenteditable='true']",
          "[contenteditable]",
          "[role='textbox']",
        ];
        for (const sel of selectors) {
          const el = td.querySelector(sel);
          if (isEditable(el)) return el;
        }
        const widget = td.querySelector(".o_field_widget");
        if (widget) {
          for (const sel of selectors) {
            const el = widget.querySelector(sel);
            if (isEditable(el)) return el;
          }
        }

        const cellRect = td.getBoundingClientRect();
        for (const el of document.querySelectorAll(
          "input.o_input, textarea.o_input, textarea, [contenteditable='true'], [contenteditable], [role='textbox']"
        )) {
          if (!isEditable(el) || el.offsetParent === null) continue;
          const r = el.getBoundingClientRect();
          if (
            r.width > 0 &&
            r.top >= cellRect.top - 30 &&
            r.bottom <= cellRect.bottom + 30 &&
            r.left >= cellRect.left - 12 &&
            r.right <= cellRect.right + 12
          ) {
            return el;
          }
        }

        td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        if (widget) {
          widget.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        }
        for (const sel of selectors) {
          const el = td.querySelector(sel) || widget?.querySelector(sel);
          if (isEditable(el)) return el;
        }
        return null;
      };

      const el = pick();
      if (!el) return false;

      return window.__odooNativeSetValue(el, value, asUrl);
    },
    String(text),
    treatAsUrl
  );
}

/**
 * Set Odoo field value. For http(s) URLs uses the native value setter + change
 * so OWL/URL widgets persist; other fields use keyboard typing (input only).
 */
async function setInputInCell(page, cell, text, { fireChange = false, treatAsUrl = false } = {}) {
  // Clear focus from any other cell before editing this one
  await page.evaluate(() => {
    const ae = document.activeElement;
    if (ae && typeof ae.blur === "function") ae.blur();
  });
  await sleep(100);

  await clickCellForEdit(page, cell);

  const wasReadonly = await cell.evaluate((td) => td.classList.contains("o_readonly_modifier"));
  if (wasReadonly) {
    await cell.click({ clickCount: 2 });
    await page.keyboard.press("F2");
    await sleep(400);
  }

  let input = await findEditableInput(page, cell);
  if (!input) {
    for (let i = 0; i < 6; i++) {
      await tryActivateCellEdit(page, cell, i);
      input = await findEditableInput(page, cell);
      if (input) break;
    }
  }

  if (!input) {
    const direct = await setCellValueDirect(cell, text, { treatAsUrl });
    if (direct) {
      console.log("[ODOO] Cell value set via direct DOM fallback");
      await page.evaluate(() => {
        const ae = document.activeElement;
        if (ae && typeof ae.blur === "function") ae.blur();
      });
      await sleep(200);
      return;
    }

    console.log("[ODOO] Using mouse+keyboard fallback for cell");
    const typed = await typeIntoActivatedCell(page, cell, text);
    if (typed) {
      await page.evaluate(() => {
        const ae = document.activeElement;
        if (ae && typeof ae.blur === "function") ae.blur();
      });
      await sleep(200);
      return;
    }

    const debug = await cell.evaluate((td) => ({
      name: td.getAttribute("name") || td.getAttribute("data-name") || "",
      cls: td.className,
      preview: (td.textContent || "").trim().slice(0, 80),
    }));
    throw new Error(
      `No input/textarea found in cell (${debug.name || "unknown"}): ${JSON.stringify(debug)}`
    );
  }

  if (treatAsUrl) {
    await input.evaluate(
      (el, value, withChange) => {
        window.__odooNativeSetValue(el, value, withChange);
      },
      String(text).trim(),
      fireChange
    );
    return;
  }

  await input.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Delete");

  const value = String(text);
  const preferNativeSet = await input.evaluate(
    (el, v) =>
      el.isContentEditable ||
      el instanceof HTMLTextAreaElement ||
      v.includes("\n") ||
      v.length > 60,
    value
  );

  if (preferNativeSet) {
    await input.evaluate(
      (el, v, withChange) => {
        if (typeof window.__odooNativeSetValue === "function") {
          window.__odooNativeSetValue(el, v, withChange);
          return;
        }
        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc?.set) desc.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        if (withChange) el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      value,
      true
    );
  } else {
    await input.type(value, { delay: 15 });
    await input.evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  if (fireChange) {
    await input.evaluate((el) => {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  // Blur to commit inline row without creating a new line via Tab on last cell
  await page.evaluate(() => {
    const stable =
      document.querySelector(".o_form_sheet") ||
      document.querySelector(".o_content") ||
      document.querySelector(".o_list_view") ||
      document.body;
    if (stable) {
      stable.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
      );
    }
    const ae = document.activeElement;
    if (ae && typeof ae.blur === "function") ae.blur();
  });
  await sleep(200);
}

/** Select employee (many2one) in timesheet row — Odoo portal Employee column. */
async function selectEmployeeInCell(page, cell, employeeName) {
  if (!employeeName) {
    console.log("[ODOO] Employee selection skipped (set ODOO_EMPLOYEE_NAME in env)");
    return;
  }

  const existing = await cell.evaluate((el) => (el.textContent || "").trim());
  if (existing && existing.length > 2) {
    console.log("[ODOO] Employee already set:", existing.slice(0, 40));
    return;
  }

  console.log("[ODOO] Selecting employee");
  await clickCellForEdit(page, cell);
  const input = await waitForEditableInput(page, cell, 8000);
  if (!input) {
    throw new Error("Could not open Employee field for selection");
  }

  await input.click({ clickCount: 3 });
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await input.type(employeeName, { delay: 20 });
  await sleep(1200);

  const picked = await page.evaluate((name) => {
    const wanted = String(name).trim().toLowerCase();
    const options = Array.from(
      document.querySelectorAll(
        ".o-autocomplete--dropdown-item, .ui-menu-item, .dropdown-item, .o_m2o_dropdown_option, [role='option'], .o-dropdown-item"
      )
    );
    for (const opt of options) {
      const t = (opt.textContent || "").trim().toLowerCase();
      if (!t) continue;
      if (t.includes(wanted) || wanted.includes(t)) {
        opt.click();
        return true;
      }
    }
    return false;
  }, employeeName);

  if (!picked) {
    await page.keyboard.press("ArrowDown");
    await sleep(150);
    await page.keyboard.press("Enter");
  }

  await page.evaluate(() => {
    const ae = document.activeElement;
    if (ae && typeof ae.blur === "function") ae.blur();
  });
  await sleep(500);
  console.log("[ODOO] Employee filled");
}

async function fillLastTimesheetRow(page, fieldName, commit, headerMap, hours, fields, options = {}) {
  const { strict = false } = options;
  const root = scopeSelector(fieldName);
  const rowsSel = `${root} tbody tr.o_data_row`;
  await page.waitForSelector(rowsSel, { timeout: 30_000 });

  // Lock onto the row we just added by its data-id. Odoo can auto-create a new
  // empty row after we commit a value, so re-querying "last row" is unsafe.
  const initialAll = await page.$$(rowsSel);
  const lockedRow = initialAll[initialAll.length - 1];
  const lockedId = await lockedRow.evaluate(
    (el) =>
      el.getAttribute("data-id") ||
      el.getAttribute("data-record-id") ||
      el.getAttribute("data-res-id") ||
      ""
  );
  const initialIndex = initialAll.length - 1;

  const getRow = async () => {
    if (lockedId) {
      const byId = await page.$(
        `${root} tbody tr.o_data_row[data-id="${lockedId}"], ` +
          `${root} tbody tr.o_data_row[data-record-id="${lockedId}"]`
      );
      if (byId) return byId;
    }
    const all = await page.$$(rowsSel);
    if (all[initialIndex]) return all[initialIndex];
    if (!all.length) throw new Error("Timesheet row vanished");
    return all[all.length - 1];
  };

  const pickCell = async (row, dataName, headerLabels = []) => {
    const selectors = [
      `td.o_data_cell[name="${dataName}"]`,
      `td.o_data_cell[data-name="${dataName}"]`,
      `td[name="${dataName}"]`,
      `td[data-name="${dataName}"]`,
    ];
    for (const sel of selectors) {
      const cell = await row.$(sel);
      if (cell) return cell;
    }
    for (const label of headerLabels) {
      const key = label.toLowerCase();
      const hit = Object.keys(headerMap || {}).find((h) => h.includes(key));
      if (hit) {
        const tds = await row.$$("td.o_data_cell");
        if (tds[headerMap[hit].index]) return tds[headerMap[hit].index];
      }
    }
    const available = await row.$$eval("td.o_data_cell", (cells) =>
      cells.map((c) => c.getAttribute("name") || c.getAttribute("data-name") || "?")
    );
    throw new Error(
      `Missing column "${dataName}". Available: [${available.join(", ")}]. ` +
        `Headers: [${Object.keys(headerMap || {}).join(", ")}].`
    );
  };

  const tryFill = async (label, logLabel, fn, { required = false } = {}) => {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 15_000)
        ),
      ]);
      console.log(`[ODOO] ${logLabel} filled`);
    } catch (e) {
      if (strict && required) throw e;
      console.warn(`[ODOO] ${logLabel} fill skipped: ${e.message}`);
    }
  };

  const employeeName = commit.employeeName || getEmployeeName();

  // Order: Employee → Description → Git Link → Hours → Date
  await tryFill(
    "employee",
    "Employee",
    async () => {
      const cell = await pickCell(await getRow(), fields.employeeField, [
        "employee",
        "موظف",
      ]);
      await selectEmployeeInCell(page, cell, employeeName);
    },
    { required: Boolean(employeeName) }
  );

  await tryFill(
    "description",
    "Description",
    async () => {
      const cell = await pickCell(await getRow(), fields.descField, ["description", "وصف"]);
      await setInputInCell(page, cell, commit.message);
    },
    { required: true }
  );

  if (commit.gitLink) {
    await tryFill("git link", "Git Link", async () => {
      const cell = await pickCell(await getRow(), fields.gitField, [
        "git link",
        "repository",
        "repo",
        "رابط",
      ]);
      await setInputInCell(page, cell, commit.gitLink, { fireChange: true, treatAsUrl: true });
    });
  }

  await tryFill(
    "hours",
    "Hours",
    async () => {
      const cell = await pickCell(await getRow(), fields.hoursField, [
        "time spent",
        "hours spent",
        "hours",
        "ساعات",
      ]);
      const hoursText = String(hours).includes(":") ? String(hours) : formatHoursForOdoo(hours);
      await setInputInCell(page, cell, hoursText);
    },
    { required: true }
  );

  if (commit.date) {
    await tryFill("date", "Date", async () => {
      const cell = await pickCell(await getRow(), fields.dateField, ["date", "تاريخ"]);
      await setInputInCell(page, cell, toOdooDateString(commit.date));
    });
  }

  // Commit the row WITHOUT pressing Tab (Tab on the last cell would create a
  // new empty row in Odoo). Click a stable area outside the table to blur.
  await page.evaluate(() => {
    const stable =
      document.querySelector(".o_form_sheet > div:first-child") ||
      document.querySelector(".o_form_sheet") ||
      document.querySelector(".o_form_view");
    if (stable && typeof stable.click === "function") stable.click();
    const a = document.activeElement;
    if (a && typeof a.blur === "function") a.blur();
  });
  await sleep(400);
}

function loginRedirectPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

async function isLoginFormVisible(page) {
  return page.evaluate(() => {
    const loginInput = document.querySelector('input[name="login"]');
    if (!loginInput) return false;
    const rect = loginInput.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && loginInput.offsetParent !== null;
  });
}

async function isLoggedIn(page) {
  const url = page.url();
  if (/\/login(?:\?|$)/i.test(url)) return false;

  const loginVisible = await isLoginFormVisible(page);
  if (loginVisible) return false;

  return page.evaluate(() => {
    const href = location.href;
    if (/\/odoo\/my-tasks\//i.test(href)) return true;
    if (/\/web#/i.test(href)) return true;
    return Boolean(
      document.querySelector(
        ".o_web_client, .o_action_manager, .o_main_navbar, .o_menu_sections, .o_portal"
      )
    );
  });
}

async function getLoginErrorMessage(page) {
  return page.evaluate(() => {
    const alert = document.querySelector(
      ".alert-danger, .o_login_error, .text-danger, .o_notification_content"
    );
    return alert ? (alert.textContent || "").trim().slice(0, 200) : "";
  });
}

async function waitForLogin(page) {
  if (await isLoggedIn(page)) return;
  console.log("Login screen detected. Waiting for you to log in in the browser…");
  await page.waitForFunction(
    () => {
      const loginForm = document.querySelector(".o_login_form, form.oe_login_form");
      const action = document.querySelector(".o_action_manager, .o_web_client");
      return Boolean(action && !loginForm);
    },
    { timeout: 0, polling: 1000 }
  );
  console.log("Login detected.");
}

async function performAutoLogin(page, redirectUrl, credentials = {}) {
  const login = trimEnvQuotes(credentials.login || process.env.ODOO_LOGIN);
  const password = trimEnvQuotes(credentials.password || process.env.ODOO_PASSWORD);
  if (!login || !password) {
    throw new Error("Odoo login and password are required for automated login");
  }

  const baseUrl = getOdooBaseUrl(credentials.odooUrl);
  const redirectPath = redirectUrl ? loginRedirectPath(redirectUrl) : "/web";
  const loginCandidates = [
    `${baseUrl}/web/login?redirect=${encodeURIComponent(redirectPath)}`,
    `${baseUrl}/web/login`,
    `${baseUrl}/odoo/login?redirect=${encodeURIComponent(redirectPath)}`,
  ];

  let opened = false;
  for (const loginUrl of loginCandidates) {
    console.log("[ODOO] Login page opened");
    try {
      await page.goto(loginUrl, { waitUntil: "networkidle2", timeout: 45_000 });
    } catch {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    if (await page.$('input[name="login"]')) {
      opened = true;
      break;
    }
  }
  if (!opened) throw new Error("Could not open Odoo login page");

  await page.waitForSelector('input[name="login"]', { timeout: 30_000 });
  await sleep(800);

  const filled = await page.evaluate(
    (user, pass) => {
      const loginEl = document.querySelector('input[name="login"]');
      const passEl = document.querySelector('input[name="password"]');
      if (!loginEl || !passEl) return false;

      const setNativeValue = (el, value) => {
        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc?.set) desc.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      setNativeValue(loginEl, user);
      setNativeValue(passEl, pass);
      return true;
    },
    login,
    password
  );
  if (!filled) throw new Error("Could not fill Odoo login form");

  const navPromise = page
    .waitForNavigation({ waitUntil: "networkidle2", timeout: 60_000 })
    .catch(() => null);

  const submitted = await page.evaluate(() => {
    const form = document.querySelector(".o_login_form, form.oe_login_form, form");
    const btn =
      document.querySelector(".o_login_form button[type='submit']") ||
      document.querySelector("form.oe_login_form button[type='submit']") ||
      document.querySelector("button.btn-primary[type='submit']") ||
      document.querySelector("button[type='submit']");
    if (btn) {
      /** @type {HTMLElement} */ (btn).click();
      return "button";
    }
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return "requestSubmit";
    }
    if (form) {
      form.submit();
      return "submit";
    }
    return "";
  });
  if (!submitted) throw new Error("Could not submit Odoo login form");

  await navPromise;
  await sleep(2000);

  const loginError = await getLoginErrorMessage(page);
  if (loginError) {
    throw new Error(`Odoo login rejected: ${loginError}`);
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    if (await isLoggedIn(page)) {
      console.log("[ODOO] Login successful");
      return;
    }
    await sleep(1000);
  }

  throw new Error("Odoo login failed — still on login page");
}

async function ensureLoggedIn(page, { auto = false, redirectUrl = "", credentials = {} } = {}) {
  if (await isLoggedIn(page)) return;
  if (auto) {
    await performAutoLogin(page, redirectUrl, credentials);
    return;
  }
  await waitForLogin(page);
}

/** Enable portal task edit mode if the form is read-only. */
async function ensurePortalTaskEditable(page) {
  const needsEdit = await page.evaluate(() => {
    if (document.querySelector(".o_form_editable, .o_list_editable")) return false;
    if (document.querySelector(".o_form_readonly, .o_readonly_modifier")) return true;
    return false;
  });
  if (!needsEdit) return;

  console.log("[ODOO] Switching portal task to edit mode");
  await page.evaluate(() => {
    const labels = ["edit", "تعديل"];
    const btn = Array.from(document.querySelectorAll("button, a")).find((el) => {
      const t = (el.textContent || "").trim().toLowerCase();
      return labels.some((lbl) => t === lbl || t.startsWith(lbl));
    });
    if (btn) /** @type {HTMLElement} */ (btn).click();
  });
  await sleep(1200);
}

/** Click "Add a line" on portal / my-tasks timesheet (no div[name] scope). */
async function clickPortalAddLine(page) {
  await ensurePortalTaskEditable(page);

  const point = await page.evaluate(() => {
    const labels = [
      "add a line",
      "add line",
      "إضافة بند",
      "أضف بنداً",
      "أضف سطراً",
      "إضافة سطر",
    ];
    const match = (el) => {
      const t = (el.textContent || "").trim().toLowerCase();
      return labels.some((lbl) => t === lbl || t.startsWith(lbl));
    };

    const preferred =
      document.querySelector("tr.o_field_x2many_list_row_add a") ||
      document.querySelector(".o_field_x2many_list_row_add a") ||
      Array.from(document.querySelectorAll("a, button")).find(match);

    if (!preferred) return null;
    preferred.scrollIntoView({ block: "center", inline: "center" });
    const rect = preferred.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });

  if (!point) throw new Error('Could not find "Add a line" on Timesheets tab');

  await page.mouse.click(point.x, point.y);
  await sleep(400);
  await page.mouse.click(point.x, point.y);
  await sleep(600);

  await page
    .waitForFunction(
      () => {
        const tables = Array.from(
          document.querySelectorAll(".o_list_view table, table.o_list_table, table")
        );
        for (const table of tables) {
          const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
            (th.textContent || "").trim().toLowerCase()
          );
          if (
            !headers.some(
              (h) =>
                h.includes("time spent") ||
                h.includes("description") ||
                h.includes("date") ||
                h.includes("وصف") ||
                h.includes("تاريخ") ||
                h.includes("وقت") ||
                h.includes("موظف")
            )
          ) {
            continue;
          }
          const rows = Array.from(table.querySelectorAll("tbody tr.o_data_row, tbody tr")).filter(
            (r) => !r.classList.contains("o_field_x2many_list_row_add")
          );
          const last = rows[rows.length - 1];
          if (!last) return false;
          const hasInput = Boolean(last.querySelector("input, textarea, [contenteditable='true']"));
          const isEmpty = !(last.textContent || "").trim();
          return hasInput || isEmpty || rows.length > 0;
        }
        return false;
      },
      { timeout: 15_000 }
    )
    .catch(() => {});
  await sleep(500);
}

async function waitForPortalTimesheetTable(page) {
  await page.waitForFunction(
    () => {
      const tables = Array.from(
        document.querySelectorAll(".o_list_view table, table.o_list_table, .o_field_x2many_list table")
      );
      return tables.some((table) => {
        const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
          (th.textContent || "").trim().toLowerCase()
        );
        return headers.some(
          (h) =>
            h.includes("time spent") ||
            h.includes("description") ||
            h.includes("date") ||
            h.includes("وصف") ||
            h.includes("تاريخ") ||
            h.includes("وقت") ||
            h.includes("موظف")
        );
      });
    },
    { timeout: 60_000 }
  );
}

/** Portal flow: /odoo/my-tasks/{id} with Timesheets tab + HH:MM time column. */
async function runPortalTimesheetFlow(page, { report, date, hours, gitLink, fields, employeeName }) {
  console.log("[ODOO] Opening timesheet (portal UI)");
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector(".o_web_client, .o_action_manager, main, [role='main']")
      ),
    { timeout: 120_000 }
  );
  await page
    .waitForFunction(
      () => {
        const body = (document.body.innerText || "").toLowerCase();
        return (
          body.length > 400 &&
          (document.querySelector(".o_notebook, [role='tablist'], .nav-tabs") ||
            body.includes("timesheet") ||
            body.includes("جداول") ||
            body.includes("description") ||
            body.includes("وصف"))
        );
      },
      { timeout: 90_000 }
    )
    .catch(() => console.warn("[ODOO] Task body slow to render — continuing"));
  await sleep(2500);
  await page.evaluate(() => window.scrollTo(0, 400));

  console.log("[ODOO] Opening Timesheets tab");
  await openNotebookTab(page, NOTEBOOK_TAB);
  await sleep(800);
  try {
    await waitForPortalTimesheetTable(page);
  } catch (err) {
    await logVisibleTabs(page);
    throw err;
  }

  await ensurePortalTaskEditable(page);
  const rowsBefore = await countPortalTimesheetDataRows(page);
  console.log("[ODOO] Timesheet rows before add:", rowsBefore);
  await clickPortalAddLine(page);
  console.log("[ODOO] Add line clicked");
  await sleep(800);
  await waitForPortalTimesheetTable(page);

  try {
    await waitForPortalRowReady(page, 1, rowsBefore + 1);
  } catch {
    const rowsAfter = await countPortalTimesheetDataRows(page);
    console.warn(
      `[ODOO] New row wait timed out (before=${rowsBefore}, after=${rowsAfter}) — continuing`
    );
  }
  await sleep(500);
  await fillPortalTimesheetRow(page, {
    date: toOdooDateString(date),
    description: report,
    gitLink,
    hours: formatHoursAsTimeSpent(hours),
    employeeName: employeeName || getEmployeeName(),
  });

  for (let i = 0; i < 3; i++) {
    if (!(await dismissDialog(page))) break;
    await sleep(300);
  }

  await clickSave(page);
  await verifyTimesheetSaved(page, report);
}

function portalRowDataCellCount(row) {
  return Array.from(row.querySelectorAll("td")).filter(
    (td) =>
      !td.classList.contains("o_list_record_remove") &&
      !td.classList.contains("o_list_button") &&
      !td.classList.contains("o_list_record_selector") &&
      !td.querySelector(".o_list_record_remove, button[name='delete']")
  ).length;
}

function isPortalAddLineFooterRow(row) {
  if (row.classList.contains("o_field_x2many_list_row_add")) return true;
  const text = (row.textContent || "").trim().toLowerCase();
  if (
    text === "add a line" ||
    text.startsWith("add a line") ||
    text.includes("add line") ||
    text.includes("إضافة سطر") ||
    text.includes("إضافة بند")
  ) {
    return true;
  }
  const tds = row.querySelectorAll("td");
  if (tds.length === 1) {
    const colspan = Number(tds[0].getAttribute("colspan") || "1");
    if (colspan > 1) return true;
  }
  return false;
}

/** Count editable timesheet data rows (excludes Add-a-line footer). */
async function countPortalTimesheetDataRows(page) {
  return page.evaluate(() => {
    const isHeader = (text) => {
      const h = String(text || "").toLowerCase();
      return (
        h.includes("time spent") ||
        h.includes("description") ||
        h.includes("date") ||
        h.includes("git") ||
        h.includes("وصف") ||
        h.includes("تاريخ") ||
        h.includes("وقت") ||
        h.includes("موظف")
      );
    };
    const isAddFooter = (row) => {
      if (row.classList.contains("o_field_x2many_list_row_add")) return true;
      const text = (row.textContent || "").trim().toLowerCase();
      if (text.includes("add a line") || text.includes("add line") || text.includes("إضافة")) {
        return true;
      }
      const tds = row.querySelectorAll("td");
      return tds.length === 1 && Number(tds[0].getAttribute("colspan") || "1") > 1;
    };
    const countCells = (row) =>
      Array.from(row.querySelectorAll("td")).filter(
        (td) =>
          !td.classList.contains("o_list_record_remove") &&
          !td.classList.contains("o_list_button") &&
          !td.classList.contains("o_list_record_selector")
      ).length;

    for (const table of document.querySelectorAll(".o_list_view table, table.o_list_table, table")) {
      const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
        (th.textContent || "").trim().toLowerCase()
      );
      if (!headers.some(isHeader)) continue;
      return Array.from(
        table.querySelectorAll("tbody tr.o_data_row, tbody tr:not(.o_list_table_grouped)")
      ).filter((r) => r.querySelector("td") && !isAddFooter(r)).length;
    }
    return 0;
  });
}

/** After "Add a line", wait until a new data row appears (not the footer). */
async function waitForPortalRowReady(page, minCells = 4, minRowCount = 0) {
  await page.waitForFunction(
    (neededRows) => {
      const isHeader = (text) => {
        const h = String(text || "").toLowerCase();
        return (
          h.includes("time spent") ||
          h.includes("description") ||
          h.includes("date") ||
          h.includes("git") ||
          h.includes("وصف") ||
          h.includes("تاريخ") ||
          h.includes("وقت") ||
          h.includes("موظف")
        );
      };

      const isAddFooter = (row) => {
        if (row.classList.contains("o_field_x2many_list_row_add")) return true;
        const text = (row.textContent || "").trim().toLowerCase();
        if (text.includes("add a line") || text.includes("add line") || text.includes("إضافة")) {
          return true;
        }
        const tds = row.querySelectorAll("td");
        if (tds.length === 1 && Number(tds[0].getAttribute("colspan") || "1") > 1) return true;
        return false;
      };

      const countCells = (row) =>
        Array.from(row.querySelectorAll("td")).filter(
          (td) =>
            !td.classList.contains("o_list_record_remove") &&
            !td.classList.contains("o_list_button") &&
            !td.classList.contains("o_list_record_selector")
        ).length;

      const tables = Array.from(
        document.querySelectorAll(".o_list_view table, table.o_list_table, table")
      );
      for (const table of tables) {
        const ths = Array.from(table.querySelectorAll("thead th")).filter(
          (th) => !th.classList.contains("o_list_record_selector")
        );
        if (!ths.map((th) => (th.textContent || "").trim().toLowerCase()).some(isHeader)) {
          continue;
        }

        const rows = Array.from(
          table.querySelectorAll("tbody tr.o_data_row, tbody tr:not(.o_list_table_grouped)")
        ).filter((r) => r.querySelector("td") && r.getBoundingClientRect().height > 0);

        const dataRows = rows.filter((r) => !isAddFooter(r));
        if (neededRows > 0) {
          if (dataRows.length >= neededRows) return true;
        } else if (dataRows.length > 0) {
          return true;
        }
      }
      return false;
    },
    { timeout: 30_000 },
    minRowCount
  );
}

/** Fill a compact/new portal row (single cell or inline editor) via Tab navigation. */
async function fillPortalCompactRow(page, row, { description, hours, date, gitLink }) {
  const cell = await row.$("td");
  if (!cell) throw new Error("Compact timesheet row has no cell");

  await clickCellForEdit(page, cell);
  await sleep(400);

  const inputs = await row.$$("input:not([type='hidden']):not([type='checkbox']), textarea");
  if (inputs.length >= 3) {
    const descInput = inputs[2];
    await descInput.click({ clickCount: 3 });
    await descInput.evaluate((el, v) => {
      window.__odooNativeSetValue(el, v, true);
    }, String(description));
    if (gitLink && inputs[3]) {
      await inputs[3].evaluate((el, v) => {
        window.__odooNativeSetValue(el, v, true);
      }, String(gitLink));
    }
    const hoursInput = inputs[4] || inputs[inputs.length - 1];
    if (hoursInput) {
      await hoursInput.evaluate((el, v) => {
        window.__odooNativeSetValue(el, v, true);
      }, String(hours));
    }
    return;
  }

  // Tab order fallback: Date -> Employee -> Description -> Git Link -> Hours
  await page.keyboard.press("Tab");
  await sleep(150);
  await page.keyboard.press("Tab");
  await sleep(150);
  await page.keyboard.type(String(description), { delay: 10 });
  if (gitLink) {
    await page.keyboard.press("Tab");
    await sleep(150);
    await page.keyboard.type(String(gitLink), { delay: 10 });
  }
  await page.keyboard.press("Tab");
  await sleep(150);
  await page.keyboard.type(String(hours), { delay: 10 });
  if (date) {
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await sleep(150);
    await page.keyboard.type(String(date), { delay: 10 });
  }
  await page.keyboard.press("Tab");
  await sleep(200);
}

/** Wait until portal task page has rendered (not blank "Odoo" shell). */
async function waitForPortalTaskReady(page) {
  await page
    .waitForFunction(
      () => {
        const title = (document.title || "").trim();
        const bodyLen = (document.body.innerText || "").length;
        return (
          (title.length > 3 && title.toLowerCase() !== "odoo") ||
          bodyLen > 900 ||
          Boolean(
            document.querySelector(
              ".o_notebook, [role='tablist'], .nav-tabs, h1, .o_portal_wrap, .breadcrumb"
            )
          )
        );
      },
      { timeout: 90_000 }
    )
    .catch(() => console.warn("[ODOO] Portal task shell slow to render"));
  await sleep(2000);
}

/** Mark the new/editable timesheet row to fill (empty description, not read-only). */
async function markPortalTargetRow(page) {
  return page.evaluate(() => {
    const isHeader = (text) => {
      const h = String(text || "").toLowerCase();
      return (
        h.includes("time spent") ||
        h.includes("description") ||
        h.includes("date") ||
        h.includes("git") ||
        h.includes("وصف") ||
        h.includes("تاريخ") ||
        h.includes("وقت") ||
        h.includes("موظف")
      );
    };
    const isAddFooter = (row) => {
      if (row.classList.contains("o_field_x2many_list_row_add")) return true;
      const text = (row.textContent || "").trim().toLowerCase();
      if (text.includes("add a line") || text.includes("add line") || text.includes("إضافة")) {
        return true;
      }
      const tds = row.querySelectorAll("td");
      return tds.length === 1 && Number(tds[0].getAttribute("colspan") || "1") > 1;
    };

    document.querySelectorAll("[data-puppeteer-ts-row]").forEach((el) => {
      el.removeAttribute("data-puppeteer-ts-row");
    });

    for (const table of document.querySelectorAll(".o_list_view table, table.o_list_table, table")) {
      const headers = Array.from(table.querySelectorAll("thead th")).map((th) =>
        (th.textContent || "").trim().toLowerCase()
      );
      if (!headers.some(isHeader)) continue;

      const rows = Array.from(
        table.querySelectorAll("tbody tr.o_data_row, tbody tr:not(.o_list_table_grouped)")
      ).filter((r) => r.querySelector("td") && !isAddFooter(r));

      const pickRow = (predicate) => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (predicate(rows[i], i)) return i;
        }
        return -1;
      };

      let idx = pickRow((row) => row.classList.contains("o_selected_row"));
      if (idx < 0) {
        idx = pickRow((row) => {
          const desc =
            row.querySelector('td[name="name"], td[data-name="name"], td.o_list_char') ||
            row.querySelectorAll("td.o_data_cell, td")[2];
          if (!desc || desc.classList.contains("o_readonly_modifier")) return false;
          return (desc.textContent || "").trim().length < 2;
        });
      }
      if (idx < 0) {
        idx = pickRow((row) => {
          const desc =
            row.querySelector('td[name="name"], td[data-name="name"], td.o_list_char') ||
            row.querySelectorAll("td.o_data_cell, td")[2];
          return Boolean(desc && !desc.classList.contains("o_readonly_modifier"));
        });
      }
      if (idx < 0) idx = rows.length - 1;

      rows[idx].setAttribute("data-puppeteer-ts-row", "1");
      return { index: idx, total: rows.length };
    }
    return null;
  });
}

/** Locate the visible portal timesheet table, mark target row, return header map. */
async function locatePortalTimesheetRow(page) {
  const marked = await markPortalTargetRow(page);
  if (!marked) throw new Error("Could not find timesheet row after Add a line");

  const info = await page.evaluate((targetIndex) => {
    const isHeader = (text) => {
      const h = String(text || "").toLowerCase();
      return (
        h.includes("time spent") ||
        h.includes("description") ||
        h.includes("date") ||
        h.includes("git") ||
        h.includes("وصف") ||
        h.includes("تاريخ") ||
        h.includes("وقت") ||
        h.includes("موظف") ||
        h.includes("رابط")
      );
    };

    const isAddFooter = (row) => {
      if (row.classList.contains("o_field_x2many_list_row_add")) return true;
      const text = (row.textContent || "").trim().toLowerCase();
      if (
        text.includes("add a line") ||
        text.includes("add line") ||
        text.includes("إضافة سطر") ||
        text.includes("إضافة بند")
      ) {
        return true;
      }
      const tds = row.querySelectorAll("td");
      if (tds.length === 1 && Number(tds[0].getAttribute("colspan") || "1") > 1) return true;
      return false;
    };

    const countDataCells = (row) =>
      Array.from(row.querySelectorAll("td")).filter(
        (td) =>
          !td.classList.contains("o_list_record_remove") &&
          !td.classList.contains("o_list_button") &&
          !td.classList.contains("o_list_record_selector") &&
          !td.querySelector(".o_list_record_remove, button[name='delete']")
      ).length;

    const isRowEditable = (row) => {
      if (row.classList.contains("o_selected_row")) return true;
      const cells = row.querySelectorAll("td.o_data_cell, td");
      for (const td of cells) {
        if (td.classList.contains("o_readonly_modifier")) continue;
        if (
          td.matches('[name="name"], [data-name="name"], .o_list_char, .o_field_cell') &&
          !td.classList.contains("o_readonly_modifier")
        ) {
          return true;
        }
      }
      return Array.from(cells).some((td) => !td.classList.contains("o_readonly_modifier"));
    };

    const tables = Array.from(
      document.querySelectorAll(".o_list_view table, table.o_list_table, .o_field_x2many_list table, table")
    );

    let best = null;
    let bestScore = -1;

    for (const table of tables) {
      const ths = Array.from(table.querySelectorAll("thead th")).filter(
        (th) => !th.classList.contains("o_list_record_selector")
      );
      const headerTexts = ths.map((th) => (th.textContent || "").trim().toLowerCase());
      if (!headerTexts.some(isHeader)) continue;

      const rect = table.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 40) continue;

      const rows = Array.from(
        table.querySelectorAll("tbody tr.o_data_row, tbody tr:not(.o_list_table_grouped)")
      ).filter((r) => r.querySelector("td") && r.getBoundingClientRect().height > 0);

      const dataRows = rows.filter((r) => !isAddFooter(r));

      const score = dataRows.length * 100 + rect.width;
      if (score > bestScore) {
        bestScore = score;
        best = { ths, rows: dataRows, headerTexts };
      }
    }

    if (!best || !best.rows.length) return null;

    const markedRow = document.querySelector('tr[data-puppeteer-ts-row="1"]');
    const pickIndex = markedRow ? best.rows.indexOf(markedRow) : best.rows.length - 1;
    const lastRow = pickIndex >= 0 ? best.rows[pickIndex] : best.rows[best.rows.length - 1];

    const headerMap = {};
    let dataIdx = 0;
    best.ths.forEach((th) => {
      const text = (th.textContent || "").trim().toLowerCase();
      const fieldName = th.getAttribute("name") || th.getAttribute("data-name") || "";
      const entry = { dataIndex: dataIdx, fieldName, text };
      if (text) headerMap[text] = entry;
      if (fieldName) headerMap[`$field:${fieldName}`] = entry;
      dataIdx += 1;
    });

    const dataCells = Array.from(lastRow.querySelectorAll("td"))
      .filter(
        (td) =>
          !td.classList.contains("o_list_record_remove") &&
          !td.classList.contains("o_list_button") &&
          !td.classList.contains("o_list_record_selector") &&
          !td.querySelector(".o_list_record_remove, button[name='delete']")
      )
      .map((td, index) => ({
        index,
        name: td.getAttribute("name") || td.getAttribute("data-name") || "",
        preview: (td.textContent || "").trim().slice(0, 40),
      }));

    return {
      headerMap,
      dataCells,
      headerKeys: Object.keys(headerMap),
      rowIndex: pickIndex >= 0 ? pickIndex : best.rows.length - 1,
      rowCount: best.rows.length,
    };
  }, marked.index);

  if (!info) throw new Error("Could not find timesheet row after Add a line");

  const row = await page.$('tr[data-puppeteer-ts-row="1"]');
  if (!row) throw new Error("Could not locate marked timesheet row");

  console.log("[ODOO] Timesheet columns:", info.headerKeys.join(" | "));
  console.log(
    `[ODOO] Target row ${info.rowIndex + 1}/${info.rowCount}, cells: ${info.dataCells.length}`
  );

  return { row, headerMap: info.headerMap, dataCellsInfo: info.dataCells };
}

/** Fill the last row in a portal timesheet table (no div[name] wrapper). */
async function fillPortalTimesheetRow(page, { date, description, gitLink, hours, employeeName }) {
  const { row, headerMap, dataCellsInfo } = await locatePortalTimesheetRow(page);

  if (dataCellsInfo.length < 4) {
    console.log("[ODOO] Compact row detected — using Tab/input fill");
    await fillPortalCompactRow(page, row, { description, hours, date, gitLink });
    return;
  }

  const resolveColumnIndex = (headerLabels, fieldNames = [], { excludeHeaders = [] } = {}) => {
    for (const fname of fieldNames) {
      const fieldKey = `$field:${fname}`;
      if (headerMap[fieldKey]) return headerMap[fieldKey].dataIndex;
    }
    for (const label of headerLabels) {
      const key = Object.keys(headerMap).find(
        (h) =>
          h.includes(label.toLowerCase()) &&
          !excludeHeaders.some((ex) => h.includes(ex.toLowerCase()))
      );
      if (key != null) return headerMap[key].dataIndex;
    }
    return -1;
  };

  const pickCellByLabel = async (headerLabels, fieldNames = [], { excludeHeaders = [], fallbackIndex = -1 } = {}) => {
    const dataCells = await getRowDataCells(row);

    for (const fname of fieldNames) {
      const byName = await row.$(
        `td.o_data_cell[name="${fname}"], td[name="${fname}"], td[data-name="${fname}"], td.o_data_cell[data-name="${fname}"]`
      );
      if (byName) return byName;
    }

    const idx = resolveColumnIndex(headerLabels, fieldNames, { excludeHeaders });
    if (idx >= 0 && dataCells[idx]) return dataCells[idx];

    if (fallbackIndex >= 0 && dataCells[fallbackIndex]) return dataCells[fallbackIndex];

    throw new Error(
      `Missing column [${headerLabels.join(", ")}] — headers: [${Object.keys(headerMap).join(", ")}], cells: ${dataCells.length}, row: ${JSON.stringify(dataCellsInfo)}`
    );
  };

  const fillField = async (logLabel, headerLabels, fieldNames, value, opts = {}) => {
    if (!value && !opts.required) return;
    const { pickOpts, required: _required, ...inputOpts } = opts;
    const cell = await pickCellByLabel(headerLabels, fieldNames, pickOpts || {});
    try {
      await setInputInCell(page, cell, value, inputOpts);
      console.log(`[ODOO] ${logLabel} filled`);
    } catch (err) {
      throw new Error(`${logLabel}: ${err.message}`);
    }
  };

  // Description first — avoids typing report text into Employee column
  await fillField(
    "Description",
    ["description", "وصف"],
    ["name"],
    description,
    { required: true, pickOpts: { excludeHeaders: ["employee", "موظف"], fallbackIndex: 2 } }
  );

  if (gitLink) {
    try {
      await fillField(
        "Git Link",
        ["git link", "repository", "repo", "رابط"],
        ["x_git_link"],
        gitLink,
        { fireChange: true, treatAsUrl: true }
      );
    } catch (e) {
      console.warn(`[ODOO] Git Link fill skipped: ${e.message}`);
    }
  }

  await fillField(
    "Hours",
    ["time spent", "hours spent", "hours", "ساعات", "الوقت", "مستغرق"],
    ["unit_amount"],
    hours,
    { required: true }
  );

  try {
    await fillField("Date", ["date", "تاريخ"], ["date"], date);
  } catch (e) {
    console.warn(`[ODOO] Date fill skipped: ${e.message}`);
  }

  try {
    const employeeCell = await pickCellByLabel(["employee", "موظف"], ["employee_id"]);
    const employeeAlreadySet = await employeeCell.evaluate((el) => {
      const hasAvatar = Boolean(el.querySelector("img, .o_m2o_avatar, .rounded-circle"));
      const text = (el.textContent || "").trim();
      return hasAvatar || text.length > 2;
    });
    if (employeeAlreadySet) {
      console.log("[ODOO] Employee already set — skipping");
    } else {
      await selectEmployeeInCell(page, employeeCell, employeeName);
    }
  } catch (e) {
    if (employeeName) console.warn(`[ODOO] Employee fill skipped: ${e.message}`);
  }

  await sleep(400);
}

/** Backend form flow: /web#id=...&model=project.task */
async function runBackendTimesheetFlow(page, { report, date, hours, gitLink, fields, employeeName }) {
  console.log("[ODOO] Opening timesheet (backend form)");
  await page.waitForSelector(".o_form_view", { timeout: 120_000 });
  await openNotebookTab(page, NOTEBOOK_TAB);
  await waitForTimesheetWidget(page, fields.timesheetField);

  const rowData = { date, message: report, gitLink, employeeName };
  const before = await countDataRows(page, fields.timesheetField);
  await clickAddLine(page, fields.timesheetField);
  console.log("[ODOO] Add line clicked");
  await page.waitForFunction(
    (field, prev) =>
      document.querySelectorAll(`div[name="${field}"] tbody tr.o_data_row`).length > prev,
    { timeout: 30_000 },
    fields.timesheetField,
    before
  );

  const headerMap = await getHeaderMap(page, fields.timesheetField);
  await fillLastTimesheetRow(
    page,
    fields.timesheetField,
    rowData,
    headerMap,
    formatHoursForOdoo(hours),
    fields,
    { strict: true }
  );

  for (let i = 0; i < 3; i++) {
    if (!(await dismissDialog(page))) break;
    await sleep(300);
  }

  await removeEmptyRows(page, fields.timesheetField, {
    descField: fields.descField,
    hoursField: fields.hoursField,
  });

  await clickSave(page);
  await verifyTimesheetSaved(page, report);
}

async function captureErrorScreenshot(page) {
  if (!page) return;
  try {
    await page.screenshot({ path: "error-screenshot.png", fullPage: true });
    console.error("[ODOO] Screenshot saved to error-screenshot.png");
  } catch (err) {
    console.warn("[ODOO] Could not save screenshot:", err.message);
  }
}

/**
 * Remove phantom rows in the timesheet whose Description is empty and Hours
 * is zero. Odoo can auto-create such rows; saving with one triggers an error.
 */
async function removeEmptyRows(page, fieldName, { descField, hoursField }) {
  const root = scopeSelector(fieldName);
  for (let pass = 0; pass < 20; pass++) {
    const removed = await page.evaluate(
      (sel, descName, hoursName) => {
        const rows = Array.from(document.querySelectorAll(`${sel} tbody tr.o_data_row`));
        const cellText = (row, name) => {
          const c =
            row.querySelector(`td.o_data_cell[name="${name}"]`) ||
            row.querySelector(`td.o_data_cell[data-name="${name}"]`);
          return c ? (c.textContent || "").trim() : "";
        };
        const isZero = (txt) =>
          !txt || /^0+[:.,]0+$/.test(txt) || txt === "0" || txt === "0.00" || txt === "0.0";

        const headerIdx = (label) => {
          const ths = Array.from(document.querySelectorAll(`${sel} thead th`));
          return ths.findIndex((th) =>
            (th.textContent || "").trim().toLowerCase().includes(label)
          );
        };
        const descIdx = headerIdx("description");
        const hoursIdx = headerIdx("hours");
        const cellByIdx = (row, idx) => {
          if (idx < 0) return "";
          const tds = row.querySelectorAll("td");
          return tds[idx] ? (tds[idx].textContent || "").trim() : "";
        };

        const isEmpty = (row) => {
          const desc = cellText(row, descName) || (descIdx >= 0 ? cellByIdx(row, descIdx) : "");
          const hours = cellText(row, hoursName) || (hoursIdx >= 0 ? cellByIdx(row, hoursIdx) : "");
          return !desc && isZero(hours);
        };

        const trashSelectors = [
          ".o_list_record_remove",
          ".o_list_record_delete",
          "button.o_list_record_remove",
          "button.fa-trash-o",
          "button.fa-trash",
          ".fa-trash",
          ".fa-trash-o",
          "button[name='delete']",
          "button[aria-label*='Delete' i]",
          "button[title*='Delete' i]",
        ];

        for (const row of rows) {
          if (!isEmpty(row)) continue;
          for (const ts of trashSelectors) {
            const t = row.querySelector(ts);
            if (t) {
              /** @type {HTMLElement} */ (t).click();
              return true;
            }
          }
          const lastTd = row.lastElementChild;
          const anyBtn = lastTd && lastTd.querySelector("button, a, i");
          if (anyBtn) {
            /** @type {HTMLElement} */ (anyBtn).click();
            return true;
          }
        }
        return false;
      },
      root,
      descField,
      hoursField
    );

    if (!removed) return;
    console.log("Removed an empty row.");
    await sleep(250);
  }
}

/** Dismiss any blocking modal (validation/info dialog) by clicking OK/Close. */
async function dismissDialog(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector(".modal.show, .o_dialog, .modal-dialog");
    if (!dialog) return false;
    const buttons = Array.from(dialog.querySelectorAll("button, .btn"));
    const labels = ["ok", "close", "discard", "حسناً", "موافق", "إغلاق"];
    const target =
      buttons.find((b) => {
        const t = (b.textContent || "").trim().toLowerCase();
        return labels.some((l) => t === l || t.includes(l));
      }) ||
      buttons.find((b) => b.classList.contains("btn-primary")) ||
      buttons[0];
    if (target) {
      /** @type {HTMLElement} */ (target).click();
      return true;
    }
    return false;
  });
}

/** Click Odoo's Save (cloud) button and wait for the dirty state to clear. */
async function clickSave(page) {
  console.log("[ODOO] Save clicked");
  const ok = await page.evaluate(() => {
    const candidates = [
      "button.o_form_button_save",
      ".o_form_button_save",
      ".o_form_status_indicator_buttons button.fa-cloud-upload",
      "button[name='save']",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        /** @type {HTMLElement} */ (el).click();
        return true;
      }
    }
    const cloud = Array.from(
      document.querySelectorAll(
        ".o_form_status_indicator button, .o_form_status_indicator_buttons button"
      )
    ).find((b) =>
      b.querySelector(".fa-cloud-upload, .fa-cloud-upload-alt, .oi-cloud-upload, .oi-save")
    );
    if (cloud) {
      /** @type {HTMLElement} */ (cloud).click();
      return true;
    }
    return false;
  });
  if (!ok) throw new Error("Could not find the Save (cloud) button");

  const cleared = await page
    .waitForFunction(() => !document.querySelector(".o_form_editable.o_form_dirty"), {
      timeout: 30_000,
    })
    .then(() => true)
    .catch(() => false);

  if (!cleared) {
    console.warn("[ODOO] Form may still be dirty after save — verification will confirm");
  }
}

const MS_HOUR = 1000 * 60 * 60;

function clockHHMM(d) {
  return d.toTimeString().slice(0, 5);
}

/**
 * Split **billable** hours (e.g. 7 = 8h window − BREAK) across PROJECTS using a
 * timeline of commits today inside [WORK_START, WORK_END].
 *
 * By default **no tail** to WORK_END: only time up to each commit counts as raw
 * work, so one commit at 13:48 yields raw ≈ 3.8h and Odoo hours ≈ 7×(3.8/8) ≈ 3.35,
 * not 7. Set `TIMESHEET_TAIL_TO_WORK_END=1` to add [lastCommit, WORK_END] to the
 * last project (fills the window → solo project gets full billable again).
 *
 * Scale: `hours_i = billable × (raw_i / workWindowHours)` so the day cap is the
 * configured window (e.g. 8h), not “always 100% of billable for one line”.
 */
async function computeProjectHours(config) {
  if (!config.projects.length) return null;

  const today = toOdooDateString(new Date());
  const workStart = parseClockToday(config.workStart);
  const workEnd = parseClockToday(config.workEnd);
  const ws = workStart.getTime();
  const we = workEnd.getTime();
  const workDuration = (we - ws) / MS_HOUR;
  const includeTail = process.env.TIMESHEET_TAIL_TO_WORK_END === "1";

  console.log(
    `\nComputing time split across [${config.projects.join(", ")}] ` +
      `(timeline ${config.workStart}–${config.workEnd}; tail to end of day: ${includeTail ? "yes" : "no"})…`
  );

  /** @type {{ name: string, time: Date, message: string }[]} */
  const events = [];
  /** @type {{ name: string, time: Date, message: string }[]} */
  const latestFallback = [];

  for (const name of config.projects) {
    const cfg = resolveProjectConfig(name);
    if (!cfg.gitlabProjectId || !cfg.token) continue;
    const key = name.toLowerCase();
    try {
      const commits = await getCommits({
        token: cfg.token,
        projectId: cfg.gitlabProjectId,
        projectUrl: cfg.gitlabProjectUrl,
        authorName: cfg.authorName,
        authorEmail: cfg.authorEmail,
        limit: COMMIT_LIMIT,
      });
      const todays = commits.filter((c) => toOdooDateString(c.date) === today);
      if (!todays.length) {
        console.log(`  ${key}: no commits today`);
        continue;
      }
      for (const c of todays) {
        events.push({
          name: key,
          time: new Date(c.date),
          message: c.message,
        });
      }
      const latest = todays.reduce((a, b) =>
        new Date(a.date) > new Date(b.date) ? a : b
      );
      latestFallback.push({
        name: key,
        time: new Date(latest.date),
        message: latest.message,
      });
      console.log(`  ${key}: ${todays.length} commit(s) today`);
    } catch (e) {
      console.warn(`  ${name}: failed to fetch (${e.message})`);
    }
  }

  events.sort((a, b) => a.time - b.time);

  if (!events.length) {
    console.log("No commits today across configured projects; skipping split.");
    return null;
  }

  const inWindow = events.filter((e) => {
    const t = e.time.getTime();
    return t >= ws && t <= we;
  });

  /** @type {Record<string, number>} */
  const rawMap = {};

  if (inWindow.length) {
    let prev = ws;
    for (const e of inWindow) {
      const t = e.time.getTime();
      const h = Math.max(0, (t - prev) / MS_HOUR);
      if (h > 0) {
        rawMap[e.name] = (rawMap[e.name] || 0) + h;
        console.log(
          `  ${clockHHMM(new Date(prev))}–${clockHHMM(e.time)} → ${e.name}: ${h.toFixed(2)}h raw`
        );
      }
      prev = t;
    }
    const last = inWindow[inWindow.length - 1];
    if (includeTail && prev < we) {
      const h = (we - prev) / MS_HOUR;
      rawMap[last.name] = (rawMap[last.name] || 0) + Math.max(0, h);
      console.log(
        `  ${clockHHMM(new Date(prev))}–${clockHHMM(workEnd)} → ${last.name} (tail): ${h.toFixed(2)}h raw`
      );
    }
  } else {
    console.log(
      "  No commits inside work window; fallback = latest commit per project (clipped to window)."
    );
    latestFallback.sort((a, b) => a.time - b.time);
    const pts = latestFallback.map((p) => {
      let t = p.time;
      if (t < workStart) t = workStart;
      if (t > workEnd) t = workEnd;
      return { name: p.name, time: t };
    });
    let prev = workStart;
    for (const p of pts) {
      rawMap[p.name] = (rawMap[p.name] || 0) + Math.max(0, (p.time - prev) / MS_HOUR);
      prev = p.time;
    }
    const lastP = pts[pts.length - 1];
    if (includeTail && prev < workEnd) {
      rawMap[lastP.name] = (rawMap[lastP.name] || 0) + Math.max(0, (workEnd - prev) / MS_HOUR);
    }
  }

  const rawSum = Object.values(rawMap).reduce((a, b) => a + b, 0);
  const billable = billableHoursForConfig(config);

  const hoursMap = {};
  for (const k of Object.keys(rawMap)) {
    const h = workDuration > 0 ? (billable * rawMap[k]) / workDuration : 0;
    hoursMap[k] = Math.round(h * 100) / 100;
  }

  const sumOdoo = Object.values(hoursMap).reduce((a, b) => a + b, 0);

  console.log(
    `Work window: ${workDuration.toFixed(2)}h; raw work (segments${includeTail ? "+tail" : ""}): ${rawSum.toFixed(2)}h; break: ${config.breakHours}h → billable cap: ${billable.toFixed(2)}h`
  );
  console.log(`Formula: hours = billable × (raw / ${workDuration.toFixed(2)}h window)`);
  Object.entries(hoursMap).forEach(([k, v]) =>
    console.log(`  ${k}: ${v}h  (raw ${(rawMap[k] || 0).toFixed(2)}h)`)
  );
  console.log(`  → Sum written across projects (this run’s split): ${sumOdoo.toFixed(2)}h`);
  return hoursMap;
}

/** Fetch today's commits for the active project (fallback to last N). */
async function loadCommits(config) {
  console.log(
    `\nFetching commits from GitLab project ${config.gitlabProjectId}…`
  );
  console.log(`Git repo URL on Odoo (from .env): ${config.gitlabProjectUrl}`);
  const all = (
    await getCommits({
      token: config.token,
      projectId: config.gitlabProjectId,
      projectUrl: config.gitlabProjectUrl,
      authorName: config.authorName,
      authorEmail: config.authorEmail,
      limit: COMMIT_LIMIT,
    })
  ).map((c) => ({
    date: c.date,
    message: c.message,
    gitLink: config.gitlabProjectUrl,
  }));

  const today = toOdooDateString(new Date());
  let rows = all.filter((r) => toOdooDateString(r.date) === today);
  console.log(`Today (${today}): ${rows.length}/${all.length} commits.`);

  if (rows.length === 0 && FALLBACK_COUNT > 0) {
    rows = all.slice(0, FALLBACK_COUNT);
    console.log(`No commits today. Using last ${rows.length} commit(s) as fallback.`);
  }

  rows.forEach((r, i) =>
    console.log(`  ${i + 1}. ${toOdooDateString(r.date)} — ${r.message}`)
  );
  return rows;
}

/** Force-navigate to the exact task URL (must match task id, not any my-tasks page). */
async function ensureOnTask(page, taskUrl) {
  const expectedId = getExpectedTaskId(taskUrl);
  const isMyTasksUrl = /\/odoo\/my-tasks\/\d+/i.test(taskUrl);
  const targetHash = taskUrl.split("#")[1] || "";

  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(800);
    const currentUrl = page.url();

    if (isMyTasksUrl && expectedId) {
      if (currentUrl.includes(`my-tasks/${expectedId}`)) {
        console.log("[ODOO] Task opened:", expectedId);
        return;
      }
    } else if (!isMyTasksUrl) {
      const onTaskForm =
        currentUrl.includes("model=project.task") &&
        currentUrl.includes("view_type=form");
      if (onTaskForm && (!expectedId || currentUrl.includes(`id=${expectedId}`))) {
        console.log("[ODOO] Task opened:", expectedId || "backend form");
        return;
      }
    }

    console.log(
      `[ODOO] Wrong or missing task (attempt ${attempt + 1}/5). Expected ${expectedId || taskUrl}. Current: ${currentUrl}`
    );

    try {
      await page.goto(taskUrl, { waitUntil: "networkidle2", timeout: 60_000 });
    } catch {
      if (targetHash && taskUrl.includes("/web")) {
        await page.evaluate(
          ({ url, hash }) => {
            if (location.pathname.startsWith("/web")) location.hash = hash;
            else location.href = url;
          },
          { url: taskUrl, hash: targetHash }
        );
      } else {
        await page.goto(taskUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      }
    }

    try {
      await page.waitForFunction(
        (id, portal) => {
          const href = location.href;
          if (portal && id) return href.includes(`my-tasks/${id}`);
          return (
            href.includes("model=project.task") &&
            href.includes("view_type=form") &&
            (!id || href.includes(`id=${id}`))
          );
        },
        { timeout: 15_000 },
        expectedId,
        isMyTasksUrl
      );
      await assertCorrectTaskOpen(page, taskUrl);
      return;
    } catch {
      // retry
    }
  }

  await assertCorrectTaskOpen(page, taskUrl);
  throw new Error(`Could not open the task form. Current URL: ${page.url()}.`);
}

/**
 * Run the Odoo timesheet automation for API / n8n requests.
 * API mode must pass odooUrl/login/password from DB. Env credentials are CLI fallback only.
 * @param {{
 *   report: string,
 *   date: string,
 *   hours: number,
 *   taskUrl: string,
 *   odooUrl?: string,
 *   login?: string,
 *   password?: string,
 *   employeeName?: string,
 *   gitLink?: string
 * }} params
 */
async function submitTimesheet({
  report,
  date,
  hours,
  taskUrl,
  odooUrl,
  login,
  password,
  employeeName,
  gitLink,
}) {
  let browser;
  let page;

  const normalizedReport = normalizeReport(report);
  const normalizedHours = Number(hours || 7);
  const finalTaskUrl = trimEnvQuotes(String(taskUrl || "").trim());

  if (!finalTaskUrl) throw new Error("taskUrl is required");
  if (!normalizedReport.trim()) throw new Error("report is required");
  if (!date) throw new Error("date is required");
  if (Number.isNaN(normalizedHours) || normalizedHours <= 0) {
    throw new Error("hours must be a positive number");
  }

  const fields = getOdooFieldConfig();
  const resolvedGitLink = trimEnvQuotes(gitLink || process.env.ODOO_GIT_LINK || "");
  const usePortal = isPortalMyTasksUrl(finalTaskUrl);
  const credentials = { odooUrl, login, password };

  console.log("[ODOO] taskUrl received:", finalTaskUrl);
  console.log("[ODOO] expected task id:", getExpectedTaskId(finalTaskUrl) || "n/a");

  try {
    console.log("[ODOO] Launching browser");
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1360, height: 900 },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1360,900",
        "--hide-crash-restore-bubble",
        "--disable-session-crashed-bubble",
        "--no-default-browser-check",
        "--no-first-run",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    page = await browser.newPage();
    await installBrowserTabHelpers(page);
    for (const p of await browser.pages()) {
      if (p !== page) await p.close().catch(() => {});
    }
    page.setDefaultTimeout(120_000);

    console.log("[ODOO] navigating to task...");
    try {
      await page.goto(finalTaskUrl, { waitUntil: "networkidle2", timeout: 60_000 });
    } catch {
      await page.goto(finalTaskUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    console.log("[ODOO] current URL after navigation:", page.url());

    console.log("[ODOO] Logging in");
    await ensureLoggedIn(page, { auto: true, redirectUrl: finalTaskUrl, credentials });

    await navigateToTask(page, finalTaskUrl);
    await ensureOnTask(page, finalTaskUrl);
    if (usePortal) await waitForPortalTaskReady(page);

    // TODO: Prevent duplicate timesheet rows for the same date by scanning existing
    // rows before clickAddLine. Needs stable per-row date selectors in this Odoo build.

    const payload = {
      report: normalizedReport,
      date,
      hours: normalizedHours,
      gitLink: resolvedGitLink,
      fields,
      employeeName: employeeName || getEmployeeName(),
    };

    if (usePortal) {
      await runPortalTimesheetFlow(page, payload);
    } else {
      await runBackendTimesheetFlow(page, payload);
    }
  } catch (err) {
    await logPageContextOnError(page);
    await captureErrorScreenshot(page);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function main() {
  const projectArg = process.argv[2] || process.env.PROJECT || "";
  const config = resolveProjectConfig(projectArg);
  console.log(`>> Project: ${config.projectName}`);

  if (!config.authorName && !config.authorEmail) {
    console.error(
      `Missing author filter. Set ${
        config.projectName.toUpperCase() || "YOURPROJECT"
      }_AUTHOR_NAME (or GITLAB_AUTHOR_NAME) in .env.`
    );
    process.exit(1);
  }

  if (!config.taskUrl) {
    console.error(
      `Missing task URL. Set ${config.projectName.toUpperCase()}_TASK_URL (or ODOO_TASK_URL) in .env.`
    );
    process.exit(1);
  }

  if (!config.gitlabProjectUrl) {
    console.error(
      `Missing GitLab repo URL. Set ${config.projectName.toUpperCase()}_PROJECT_URL (or GITLAB_PROJECT_URL) in .env.`
    );
    process.exit(1);
  }

  if (!config.gitlabProjectId) {
    console.error(
      `Missing GitLab project id. Set ${config.projectName.toUpperCase()}_PROJECT_ID or a valid *_PROJECT_URL to derive it.`
    );
    process.exit(1);
  }

  const commits = await loadCommits(config);
  if (!commits.length) {
    console.log("No commits to add. Exiting.");
    process.exit(0);
  }

  // Hours for this run: split across PROJECTS when we have data, else full billable day.
  let hours = billableHoursForConfig(config);
  const splitMap = await computeProjectHours(config);
  if (splitMap) {
    const myKey = config.projectName.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(splitMap, myKey)) {
      hours = splitMap[myKey];
      console.log(
        `Using ${formatHoursForOdoo(hours)}h for "${config.projectName}" (split key "${myKey}").`
      );
    } else {
      console.log(
        `"${config.projectName}" not in split (no commits today); using full billable ${hours}h.`
      );
    }
  } else {
    console.log(`No PROJECTS split; using billable ${hours}h for "${config.projectName}".`);
  }

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1360, height: 900 },
    args: [
      "--window-size=1360,900",
      "--start-maximized",
      "--hide-crash-restore-bubble",
      "--disable-session-crashed-bubble",
      "--no-default-browser-check",
      "--no-first-run",
      "--restore-last-session=false",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    slowMo: config.slowMoMs,
    userDataDir: USER_DATA_DIR,
  });

  // Always start in a fresh tab; close any tabs Odoo restored from a previous
  // session (e.g. the Discuss/chat tab).
  const page = await browser.newPage();
  await installBrowserTabHelpers(page);
  for (const p of await browser.pages()) {
    if (p !== page) await p.close().catch(() => {});
  }
  page.setDefaultTimeout(120_000);

  console.log("Opening Odoo task page…");
  await page.goto(config.taskUrl, { waitUntil: "domcontentloaded" });

  await waitForLogin(page);
  await ensureOnTask(page, config.taskUrl);

  console.log("Waiting for the form to render…");
  await page.waitForSelector(".o_form_view", { timeout: 120_000 });

  console.log(`Opening notebook tab "${NOTEBOOK_TAB}"…`);
  await openNotebookTab(page, NOTEBOOK_TAB);

  console.log(`Waiting for timesheet widget div[name="${config.timesheetField}"]…`);
  await waitForTimesheetWidget(page, config.timesheetField);

  // Merge all of today's commits into a single timesheet row.
  const merged = {
    date: commits[0].date,
    message: commits.map((c) => `- ${c.message}`).join("\n"),
    gitLink: config.gitlabProjectUrl,
  };
  console.log(`\nAdding 1 timesheet row containing ${commits.length} commit(s).`);

  const before = await countDataRows(page, config.timesheetField);
  await clickAddLine(page, config.timesheetField);
  await page.waitForFunction(
    (field, prev) =>
      document.querySelectorAll(`div[name="${field}"] tbody tr.o_data_row`).length > prev,
    { timeout: 30_000 },
    config.timesheetField,
    before
  );

  const headerMap = await getHeaderMap(page, config.timesheetField);
  const fields = {
    timesheetField: config.timesheetField,
    descField: config.descField,
    hoursField: config.hoursField,
    gitField: config.gitField,
    dateField: process.env.ODOO_DATE_FIELD || "date",
  };
  await fillLastTimesheetRow(page, config.timesheetField, merged, headerMap, hours, fields);

  // Dismiss any blocking dialog before saving.
  for (let i = 0; i < 3; i++) {
    if (!(await dismissDialog(page))) break;
    console.log("Dismissed an open dialog.");
    await sleep(300);
  }

  // Strip phantom empty rows Odoo may have auto-created.
  await removeEmptyRows(page, config.timesheetField, {
    descField: config.descField,
    hoursField: config.hoursField,
  });

  console.log("\nClicking Save…");
  try {
    await clickSave(page);
    console.log("Saved.");
  } catch (e) {
    console.warn(`Auto-save failed: ${e.message}. Save manually in the browser.`);
  }

  if (!config.headless) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter to close the browser…\n");
    rl.close();
  }
  await browser.close();
}

module.exports = {
  submitTimesheet,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

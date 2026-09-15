# Add Info Report

Multi-user GitLab → n8n → Railway API → Puppeteer → Odoo timesheet automation.

The working browser flow is unchanged. Configuration now lives in MongoDB and is managed from an admin dashboard instead of hardcoded env/n8n values.

## Architecture

```
Frontend Admin Dashboard
        ↓
Express API
        ↓
MongoDB
        ↓
n8n POST /api/automations/resolve  (repo + author)
        ↓
n8n stores commits with automationId
        ↓
Schedule (default 17:40 Africa/Cairo)
        ↓
Group commits by automationId
        ↓
POST /submit-report { automationId, report, date }
        ↓
API loads automation + encrypted Odoo profile
        ↓
Puppeteer logs into the correct Odoo account
        ↓
Opens the correct Odoo task
        ↓
Writes timesheet
```

Each **automation rule** is an independent mapping:

`GitLab repo + git author → Odoo profile + Odoo task + hours`

That means:

- One employee can have many repos
- One repo can have many employees
- The same employee can have a different Odoo task per repo
- Each employee can use a different Odoo account

## Database

Mongoose + MongoDB.

| Collection | Purpose |
|---|---|
| `users` | Employees |
| `odoo_profiles` | Encrypted Odoo logins per user |
| `automation_rules` | Repo/author → task/profile mapping |
| `timesheet_runs` | Duplicate protection per automation + date |

IDs are MongoDB ObjectIds (returned as `id` strings). n8n should store and send that `automation.id` as `automationId`.

Odoo passwords are stored with AES-256-GCM using `CREDENTIALS_ENCRYPTION_KEY`. GET APIs never return `password` or `encryptedPassword`.

## Frontend

React + Vite admin UI, served by Express from `frontend/dist` in production.

Routes:

- `/login`
- `/users`
- `/odoo-profiles`
- `/odoo-profiles/new`
- `/odoo-profiles/:id/edit`
- `/automations`
- `/automations/new`
- `/automations/:id/edit`

The login screen asks for `API_SECRET`. It stays in `sessionStorage` only.

## How to add a new employee without changing code

1. Open `/users` and create the employee, or use **Add user** inside the automation form.
2. Open `/odoo-profiles/new` and add that employee's Odoo login. The password is saved encrypted.
3. Open `/automations/new` and create one rule per repo:
   - GitLab project path, for example `a5945/mohamed-emad/haki`
   - Git author name/email used on commits
   - Odoo profile + task URL
   - Hours / timezone / report time
4. Point GitLab webhooks for that repo at the existing n8n webhook.
5. n8n calls `/api/automations/resolve`. If the author matches, the commit is stored. If not, it is ignored.

No n8n author allow-list and no task URL hardcoding is required after this.

## API endpoints

Protected with header `X-API-SECRET` except `GET /health`.

CRUD:

- `GET/POST /api/users`
- `PUT/DELETE /api/users/:id`
- `GET/POST /api/odoo-profiles`
- `PUT/DELETE /api/odoo-profiles/:id`
- `GET/POST /api/automations`
- `GET/PUT/DELETE /api/automations/:id`

Resolve for n8n:

```http
POST /api/automations/resolve
{
  "gitlabProjectPath": "a5945/mohamed-emad/haki",
  "authorName": "Ahmed Mekawy",
  "authorEmail": "ahmedmekawyxa@gmail.com"
}
```

Match order: enabled rules, exact GitLab path, then author email, then author name. Values are trimmed and lowercased for author matching.

Submit:

```http
POST /submit-report
{
  "automationId": 17,
  "report": "1. Fix email\n2. Update validation",
  "date": "2026-09-15"
}
```

Deprecated compatibility body still works:

```json
{ "report": "...", "date": "2026-09-15", "hours": 7, "taskUrl": "https://e.aait.sa/odoo/my-tasks/23524" }
```

Do not send Odoo passwords from n8n.

Duplicate protection: unique `(automationId, date)` in `timesheet_runs`. A successful run returns `409`. A failed run can be retried.

## n8n changes

Keep the current webhook and Data Table. Change the hardcoded author/task logic.

### After Extract Commit Info

Read `body.project.path_with_namespace` (fallback: parse repository homepage) and `commit.author.name` / `commit.author.email`.

Call:

```http
POST {{RAILWAY_URL}}/api/automations/resolve
Header: X-API-SECRET = {{API_SECRET}}
{
  "gitlabProjectPath": "{{ $json.repo_path }}",
  "authorName": "{{ $json.author_name }}",
  "authorEmail": "{{ $json.author_email }}"
}
```

If `matched=false`, stop. If `matched=true`, save the commit with:

- existing commit fields
- `automation_id`
- `user_id`
- `project_name`
- `odoo_task_url`
- `hours`
- `processed=false`

Do not keep a hardcoded author allow-list.

### 17:40 report builder

Get `processed=false`, then group by `automation_id`. Build one report per automation. Never merge Ahmed/Haki with Ahmed/Zafirra or Mohamed/Haki.

Submit:

```json
{
  "automationId": "{{ $json.automation_id }}",
  "report": "{{ $json.report }}",
  "date": "{{ $json.date }}"
}
```

See `docs/n8n-dynamic-workflow.md` and import `n8n/dynamic-auto-report-workflow.json`.

## Railway variables

```
MONGODB_URI=
API_SECRET=
CREDENTIALS_ENCRYPTION_KEY=
PORT=3000
```

Optional CLI fallback only:

```
ODOO_URL=
ODOO_LOGIN=
ODOO_PASSWORD=
ODOO_EMPLOYEE_NAME=
```

Do not put Odoo passwords in n8n. Attach a Railway MongoDB plugin (or Atlas) and use its connection string as `MONGODB_URI`.

`CREDENTIALS_ENCRYPTION_KEY` should be a 64-character hex string (32 bytes). Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Seed

```bash
npm run seed
```

Creates example users/rules for Ahmed/Haki, Ahmed/Zafirra, and Mohamed/Haki. The Odoo password is a placeholder. Update it from `/odoo-profiles` before a real run.

## Local run

```bash
cp .env.example .env
# fill MONGODB_URI, API_SECRET, CREDENTIALS_ENCRYPTION_KEY

npm install
npm run seed
npm run frontend:build
npm start
```

Dashboard: http://localhost:3000  
API health: http://localhost:3000/health

Frontend dev (optional):

```bash
npm run dev
npm run frontend:dev
```

Then open http://localhost:5173 with `VITE_API_URL=http://localhost:3000`.

## Tests

```bash
npm test
```

## Security

- `.env` is gitignored
- Odoo passwords are encrypted at rest
- API responses never include passwords
- Logs never print passwords
- n8n only receives automation metadata, not Odoo credentials
- `API_SECRET` protects resolve/submit/CRUD
- Duplicate timesheet writes are blocked in MongoDB, so a Railway restart cannot replay a successful day

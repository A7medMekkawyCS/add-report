# Dynamic n8n workflow

Import file: `n8n/dynamic-auto-report-workflow.json`

The workflow keeps the same webhook, Data Table, Gmail credential. Railway host is `https://add-report-production.up.railway.app`. Authors, repos, Odoo tasks, hours, and report times come from the dashboard via `automationId`.

Backend duplicate protection is `timesheet_runs` unique on `automationId + date`. n8n no longer uses `report_key`.

`automation_id` and `user_id` are **text** because the current backend uses MongoDB ObjectIds.

## Final diagram

```
Branch A
Collect GitLab Commits
  → Extract Commit Info
  → Resolve Automation
  → Automation Found?
        false → stop
        true  → Attach Automation
              → Ignore Merge + Dedupe
              → Commit Not Saved Yet
              → Save processed=false

Branch B
Schedule Trigger (every 5 minutes, Africa/Cairo)
  → Get processed=false
  → Build Dynamic Reports
  → If has_commits
        false → stop
        true  → Load Automation
              → Apply Dashboard Config (enabled + reportTime)
              → Prepare Submit Payload
              → Submit to Railway
              → If success (or duplicate)
                    true  → Prepare processed rows
                          → Mark processed=true
                          → Prepare success email
                          → Send a message
                    false → Prepare failure email
                          → Send failure message
```

## Nodes

### Kept / renamed

| Node | Change |
|---|---|
| Collect GitLab Commits | Unchanged webhook `/webhook/gitlab-commits` |
| Extract Commit Info | Renamed from Extract Ahmed Commits. No author allow-list |
| Ignore Merge + Dedupe | Uses `ignore_merge_commits` + full `commit_id` / URL |
| Commit Not Saved Yet | Matches `commit_id` |
| Save processed=false | Saves automation fields |
| Schedule Trigger | Still 17:40 |
| Get processed=false | Only `processed is false` |
| Build Dynamic Reports | Renamed from Build Today's Report. Groups by `automation_id` |
| If has_commits | Unchanged condition |
| Submit to Railway | Body is `automationId`, `report`, `date` only |
| If success | True if `success` or `duplicate` |
| Prepare processed rows | Uses `row_ids` from Prepare Submit Payload |
| Mark processed=true | Updates only those row ids |
| Prepare success email | Reads payload node, not HTTP response |
| Send a message | `sendTo` is `notificationEmail` from dashboard user |

### New

- Resolve Automation
- Automation Found?
- Attach Automation
- Prepare Submit Payload
- Prepare failure email
- Send failure message

### Removed

- Check report_key duplicate
- If new report_key

## Expressions

Resolve body:

```json
{
  "gitlabProjectPath": "{{ $json.repo_path }}",
  "authorName": "{{ $json.author_name }}",
  "authorEmail": "{{ $json.author_email }}"
}
```

Submit body:

```json
{
  "automationId": "{{ $json.automationId }}",
  "report": "{{ $json.report }}",
  "date": "{{ $json.date }}"
}
```

Do not send `taskUrl`, Odoo login, or Odoo password.

HTTP headers:

```
X-API-SECRET = {{ $vars.API_SECRET }}
```

## Data Table `daily_commits`

Add missing columns in n8n before activating:

| Column | Type |
|---|---|
| commit_id | Text |
| title | Text |
| timestamp | Text |
| url | Text |
| author_name | Text |
| author_email | Text |
| branch | Text |
| repo_path | Text |
| automation_id | Text |
| user_id | Text |
| user_name | Text |
| project_name | Text |
| hours | Number |
| notification_email | Text |
| processed | Boolean |
| project | Text (legacy, filled from project_name) |

`report_key` can stay unused.

## GitLab webhook

Every repo (Haki, Zafirra, others) uses the same Production webhook:

- URL: n8n Production URL for `Collect GitLab Commits`
- Push events
- All branches

`repo_path` + author decide the automation.

## Railway API

```
POST /api/automations/resolve
POST /submit-report
```

`submit-report` loads Odoo URL, login, decrypted password, task URL, and hours from MongoDB.

## Manual steps after import

1. Import `n8n/dynamic-auto-report-workflow.json` into the existing auto-report workflow (same id) or as a new workflow.
2. In n8n **Variables**, create `API_SECRET`. Do not paste it into a node.
3. Re-select the Gmail credential on both email nodes if import drops it.
4. Add the new Data Table columns listed above.
5. Confirm Data Table nodes still point to `daily_commits`.
6. Deploy the backend that includes `userEmail` on resolve.
7. In the dashboard, set the employee **Email** to the Gmail inbox that should receive confirmations. Seed already maps Ahmed to that confirmation inbox.
8. Activate the workflow.

## Testing

1. Ahmed + Haki → one stored commit + one Railway submit + one Odoo task.
2. Ahmed + Zafirra → different `automationId` and different report.
3. Mohamed + Haki → third report on the same repo.
4. Unknown author → `matched=false` → nothing saved.
5. Same commit twice → `Commit Not Saved Yet` skips the second.
6. Success → only that report's `row_ids` become `processed=true`.
7. Failure → those rows stay `processed=false`, failure email sent.
8. Three groups same day → three HTTP submits.

## Credentials

- n8n variable: `API_SECRET`
- Existing Gmail OAuth credential
- No Odoo passwords in n8n

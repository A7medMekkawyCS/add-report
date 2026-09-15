import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

function taskLabel(url) {
  const match = String(url || "").match(/my-tasks\/(\d+)/i);
  return match ? `Task ${match[1]}` : url;
}

export default function Automations() {
  const [rules, setRules] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    const res = await api("/api/automations");
    setRules(res.data || []);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function toggle(rule) {
    await api(`/api/automations/${rule.id}`, {
      method: "PUT",
      body: { enabled: !rule.enabled },
    });
    await load();
  }

  async function remove(rule) {
    if (!confirm(`Delete automation ${rule.name}?`)) return;
    try {
      await api(`/api/automations/${rule.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Automations</h1>
          <p>Each rule maps one GitLab repo + git author to one Odoo profile and task.</p>
        </div>
        <Link className="button" to="/automations/new">
          Add automation
        </Link>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="card">
        {rules.length === 0 ? (
          <div className="empty">No automations yet. Add the first mapping from the button above.</div>
        ) : (
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Project</th>
                <th>GitLab Repo</th>
                <th>GitLab Author</th>
                <th>Odoo Profile</th>
                <th>Odoo Task</th>
                <th>Hours</th>
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.user?.name || rule.userName}</td>
                  <td>{rule.projectName}</td>
                  <td className="mono">{rule.gitlabProjectPath}</td>
                  <td>
                    {rule.gitlabAuthorEmail || rule.gitlabAuthorName}
                  </td>
                  <td>{rule.odooProfile?.profileKey || rule.odooProfileId}</td>
                  <td>{taskLabel(rule.odooTaskUrl)}</td>
                  <td>{rule.hours}h</td>
                  <td>
                    <span className={`badge ${rule.enabled ? "on" : "off"}`}>
                      {rule.enabled ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="row-actions">
                    <Link className="button secondary" to={`/automations/${rule.id}/edit`}>
                      Edit
                    </Link>
                    <button className="secondary" type="button" onClick={() => toggle(rule)}>
                      {rule.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="danger" type="button" onClick={() => remove(rule)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

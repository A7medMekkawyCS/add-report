import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

const empty = {
  userId: "",
  enabled: true,
  name: "",
  projectName: "",
  gitlabProjectPath: "",
  gitlabAuthorName: "",
  gitlabAuthorEmail: "",
  ignoreMergeCommits: true,
  odooProfileId: "",
  odooTaskUrl: "",
  hours: 7,
  timezone: "Africa/Cairo",
  reportTime: "17:40",
};

export default function AutomationForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const [users, setUsers] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [form, setForm] = useState(empty);
  const [userDraft, setUserDraft] = useState({ name: "", email: "" });
  const [showUserForm, setShowUserForm] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api("/api/users"), api("/api/odoo-profiles"), editing ? api(`/api/automations/${id}`) : null])
      .then(([usersRes, profilesRes, ruleRes]) => {
        setUsers(usersRes.data || []);
        setProfiles(profilesRes.data || []);
        if (ruleRes?.data) {
          const rule = ruleRes.data;
          setForm({
            userId: rule.userId,
            enabled: rule.enabled,
            name: rule.name,
            projectName: rule.projectName,
            gitlabProjectPath: rule.gitlabProjectPath,
            gitlabAuthorName: rule.gitlabAuthorName,
            gitlabAuthorEmail: rule.gitlabAuthorEmail,
            ignoreMergeCommits: rule.ignoreMergeCommits,
            odooProfileId: rule.odooProfileId,
            odooTaskUrl: rule.odooTaskUrl,
            hours: rule.hours,
            timezone: rule.timezone,
            reportTime: rule.reportTime,
          });
        }
      })
      .catch((err) => setError(err.message));
  }, [id, editing]);

  const filteredProfiles = useMemo(
    () => profiles.filter((profile) => String(profile.userId) === String(form.userId)),
    [profiles, form.userId]
  );

  function set(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function addUser(event) {
    event.preventDefault();
    setError("");
    try {
      const res = await api("/api/users", { method: "POST", body: userDraft });
      setUsers((current) => [res.data, ...current]);
      set("userId", res.data.id);
      setShowUserForm(false);
      setUserDraft({ name: "", email: "" });
    } catch (err) {
      setError(err.message);
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    setError("");
    const body = {
      ...form,
            userId: form.userId,
            odooProfileId: form.odooProfileId,
            hours: Number(form.hours),
    };
    try {
      if (editing) {
        await api(`/api/automations/${id}`, { method: "PUT", body });
      } else {
        await api("/api/automations", { method: "POST", body });
      }
      navigate("/automations");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{editing ? "Edit automation" : "Add automation"}</h1>
          <p>Map a GitLab repo and git author to an Odoo account and task.</p>
        </div>
      </div>
      <form className="form" onSubmit={onSubmit}>
        <section className="section">
          <h2>Employee</h2>
          <div className="grid">
            <label className="field">
              <span>User</span>
              <select value={form.userId} onChange={(e) => set("userId", e.target.value)} required>
                <option value="">Select user</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
              Enabled
            </label>
          </div>
          <button className="secondary" type="button" onClick={() => setShowUserForm((v) => !v)} style={{ marginTop: 12 }}>
            {showUserForm ? "Cancel add user" : "Add user"}
          </button>
          {showUserForm ? (
            <div className="grid" style={{ marginTop: 16 }}>
              <label className="field">
                <span>Name</span>
                <input
                  value={userDraft.name}
                  onChange={(e) => setUserDraft({ ...userDraft, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={userDraft.email}
                  onChange={(e) => setUserDraft({ ...userDraft, email: e.target.value })}
                />
              </label>
              <button type="button" onClick={addUser}>
                Save user
              </button>
            </div>
          ) : null}
        </section>

        <section className="section">
          <h2>GitLab</h2>
          <div className="grid">
            <label className="field">
              <span>Project name</span>
              <input
                value={form.projectName}
                onChange={(e) => set("projectName", e.target.value)}
                placeholder="Haki"
                required
              />
            </label>
            <label className="field">
              <span>Rule name</span>
              <input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Ahmed - Haki"
                required
              />
            </label>
            <label className="field full">
              <span>GitLab project path</span>
              <input
                value={form.gitlabProjectPath}
                onChange={(e) => set("gitlabProjectPath", e.target.value)}
                placeholder="a5945/waled-hossam/zafirra"
                required
              />
              <small className="hint">Same value as GitLab path_with_namespace. Case does not matter.</small>
            </label>
            <label className="field">
              <span>GitLab author name</span>
              <input
                value={form.gitlabAuthorName}
                onChange={(e) => set("gitlabAuthorName", e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>GitLab author email</span>
              <input
                type="email"
                value={form.gitlabAuthorEmail}
                onChange={(e) => set("gitlabAuthorEmail", e.target.value)}
                required
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.ignoreMergeCommits}
                onChange={(e) => set("ignoreMergeCommits", e.target.checked)}
              />
              Ignore merge commits
            </label>
          </div>
        </section>

        <section className="section">
          <h2>Odoo</h2>
          <div className="grid">
            <label className="field">
              <span>Odoo profile</span>
              <select
                value={form.odooProfileId}
                onChange={(e) => set("odooProfileId", e.target.value)}
                required
              >
                <option value="">Select profile</option>
                {filteredProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.profileKey}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Hours</span>
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={form.hours}
                onChange={(e) => set("hours", e.target.value)}
                required
              />
            </label>
            <label className="field full">
              <span>Odoo task URL</span>
              <input
                value={form.odooTaskUrl}
                onChange={(e) => set("odooTaskUrl", e.target.value)}
                placeholder="https://e.aait.sa/odoo/my-tasks/23524"
                required
              />
            </label>
          </div>
        </section>

        <section className="section">
          <h2>Schedule</h2>
          <div className="grid">
            <label className="field">
              <span>Timezone</span>
              <input
                value={form.timezone}
                onChange={(e) => set("timezone", e.target.value)}
                placeholder="Africa/Cairo"
                required
              />
            </label>
            <label className="field">
              <span>Report time</span>
              <input
                type="time"
                value={form.reportTime}
                onChange={(e) => set("reportTime", e.target.value)}
                required
              />
              <small className="hint">n8n checks this from the dashboard every 5 minutes. You do not change the workflow clock.</small>
            </label>
          </div>
        </section>

        {error ? <p className="error">{error}</p> : null}
        <button type="submit">{editing ? "Save automation" : "Create automation"}</button>
      </form>
    </div>
  );
}

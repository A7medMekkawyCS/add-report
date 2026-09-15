import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

export default function OdooProfiles() {
  const [profiles, setProfiles] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    const res = await api("/api/odoo-profiles");
    setProfiles(res.data || []);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function toggle(profile) {
    await api(`/api/odoo-profiles/${profile.id}`, {
      method: "PUT",
      body: { enabled: !profile.enabled },
    });
    await load();
  }

  async function remove(profile) {
    if (!confirm(`Delete profile ${profile.profileKey}?`)) return;
    try {
      await api(`/api/odoo-profiles/${profile.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Odoo profiles</h1>
          <p>Encrypted logins. Passwords are never shown after save.</p>
        </div>
        <Link className="button" to="/odoo-profiles/new">
          Add profile
        </Link>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="card">
        {profiles.length === 0 ? (
          <div className="empty">No Odoo profiles yet.</div>
        ) : (
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Profile</th>
                <th>Employee</th>
                <th>Odoo URL</th>
                <th>Login</th>
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => (
                <tr key={profile.id}>
                  <td>{profile.profileKey}</td>
                  <td>{profile.user?.name || profile.userId}</td>
                  <td className="mono">{profile.odooUrl}</td>
                  <td>{profile.login}</td>
                  <td>
                    <span className={`badge ${profile.enabled ? "on" : "off"}`}>
                      {profile.enabled ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="row-actions">
                    <Link className="button secondary" to={`/odoo-profiles/${profile.id}/edit`}>
                      Edit
                    </Link>
                    <button className="secondary" type="button" onClick={() => toggle(profile)}>
                      {profile.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="danger" type="button" onClick={() => remove(profile)}>
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

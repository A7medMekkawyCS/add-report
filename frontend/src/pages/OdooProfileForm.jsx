import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

const empty = {
  userId: "",
  profileKey: "",
  odooUrl: "https://e.aait.sa",
  login: "",
  password: "",
  enabled: true,
};

export default function OdooProfileForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState("");
  const editing = Boolean(id);

  useEffect(() => {
    api("/api/users")
      .then((res) => setUsers(res.data || []))
      .catch((err) => setError(err.message));
    if (id) {
      api("/api/odoo-profiles")
        .then((res) => {
          const found = (res.data || []).find((item) => String(item.id) === String(id));
          if (!found) throw new Error("Profile not found");
          setForm({
            userId: found.userId,
            profileKey: found.profileKey,
            odooUrl: found.odooUrl,
            login: found.login,
            password: "",
            enabled: found.enabled,
          });
        })
        .catch((err) => setError(err.message));
    }
  }, [id]);

  function set(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event) {
    event.preventDefault();
    setError("");
    const body = { ...form, userId: form.userId };
    try {
      if (editing) {
        await api(`/api/odoo-profiles/${id}`, { method: "PUT", body });
      } else {
        await api("/api/odoo-profiles", { method: "POST", body });
      }
      navigate("/odoo-profiles");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{editing ? "Edit Odoo profile" : "Add Odoo profile"}</h1>
          <p>
            {editing
              ? "Leave password blank to keep the current encrypted password."
              : "The password is encrypted at rest and never returned by the API."}
          </p>
        </div>
      </div>
      <form className="form" onSubmit={onSubmit}>
        <section className="section">
          <h2>Profile</h2>
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
            <label className="field">
              <span>Profile name / key</span>
              <input
                value={form.profileKey}
                onChange={(e) => set("profileKey", e.target.value)}
                placeholder="ahmed-main"
                required
              />
            </label>
            <label className="field full">
              <span>Odoo URL</span>
              <input
                value={form.odooUrl}
                onChange={(e) => set("odooUrl", e.target.value)}
                placeholder="https://e.aait.sa"
                required
              />
            </label>
            <label className="field">
              <span>Login</span>
              <input value={form.login} onChange={(e) => set("login", e.target.value)} required />
            </label>
            <label className="field">
              <span>{editing ? "Password (leave blank to keep current password)" : "Password"}</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                required={!editing}
                autoComplete="new-password"
              />
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
        </section>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">{editing ? "Save profile" : "Create profile"}</button>
      </form>
    </div>
  );
}

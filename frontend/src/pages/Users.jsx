import { useEffect, useState } from "react";
import { api } from "../api";

export default function Users() {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", enabled: true });
  const [error, setError] = useState("");

  async function load() {
    const res = await api("/api/users");
    setUsers(res.data || []);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function createUser(event) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/users", { method: "POST", body: form });
      setForm({ name: "", email: "", enabled: true });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggle(user) {
    await api(`/api/users/${user.id}`, {
      method: "PUT",
      body: { enabled: !user.enabled },
    });
    await load();
  }

  async function remove(user) {
    if (!confirm(`Delete ${user.name}?`)) return;
    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>Employees who own GitLab author mappings and Odoo profiles.</p>
        </div>
      </div>
      <form className="section form" onSubmit={createUser} style={{ marginBottom: 20 }}>
        <h2>Add user</h2>
        <div className="grid">
          <label className="field">
            <span>Name</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </label>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Save user</button>
      </form>
      <div className="card">
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Email</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.name}</td>
                <td>{user.email}</td>
                <td>
                  <span className={`badge ${user.enabled ? "on" : "off"}`}>
                    {user.enabled ? "Active" : "Disabled"}
                  </span>
                </td>
                <td className="row-actions">
                  <button className="secondary" type="button" onClick={() => toggle(user)}>
                    {user.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="danger" type="button" onClick={() => remove(user)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

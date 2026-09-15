import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setSecret } from "../api";

export default function Login() {
  const navigate = useNavigate();
  const [secret, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSecret(secret.trim());
    try {
      await api("/api/users");
      navigate("/automations");
    } catch (err) {
      setError(err.message || "Invalid API secret");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>Admin access</h1>
        <p className="hint">
          Enter the same <code>API_SECRET</code> used by n8n. It is kept in this browser
          session only and is never stored in the database.
        </p>
        <label className="field">
          <span>API secret</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setValue(e.target.value)}
            required
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={busy} style={{ marginTop: 16 }}>
          {busy ? "Checking..." : "Continue"}
        </button>
      </form>
    </div>
  );
}

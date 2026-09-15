import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { clearSecret, getSecret } from "./api";
import Login from "./pages/Login.jsx";
import Users from "./pages/Users.jsx";
import OdooProfiles from "./pages/OdooProfiles.jsx";
import OdooProfileForm from "./pages/OdooProfileForm.jsx";
import Automations from "./pages/Automations.jsx";
import AutomationForm from "./pages/AutomationForm.jsx";

function RequireAuth({ children }) {
  if (!getSecret()) return <Navigate to="/login" replace />;
  return children;
}

function Shell({ children }) {
  const navigate = useNavigate();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">TS</span>
          <div>
            <strong>Timesheet Admin</strong>
            <p>GitLab → Odoo</p>
          </div>
        </div>
        <nav>
          <NavLink to="/automations">Automations</NavLink>
          <NavLink to="/users">Users</NavLink>
          <NavLink to="/odoo-profiles">Odoo Profiles</NavLink>
        </nav>
        <button
          className="ghost logout"
          onClick={() => {
            clearSecret();
            navigate("/login");
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Shell>
              <Routes>
                <Route path="/" element={<Navigate to="/automations" replace />} />
                <Route path="/users" element={<Users />} />
                <Route path="/odoo-profiles" element={<OdooProfiles />} />
                <Route path="/odoo-profiles/new" element={<OdooProfileForm />} />
                <Route path="/odoo-profiles/:id/edit" element={<OdooProfileForm />} />
                <Route path="/automations" element={<Automations />} />
                <Route path="/automations/new" element={<AutomationForm />} />
                <Route path="/automations/:id/edit" element={<AutomationForm />} />
              </Routes>
            </Shell>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

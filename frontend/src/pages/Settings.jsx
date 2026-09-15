import { useEffect, useState } from "react";
import { api } from "../api";

const DAYS = [
  { id: 0, label: "Sunday" },
  { id: 1, label: "Monday" },
  { id: 2, label: "Tuesday" },
  { id: 3, label: "Wednesday" },
  { id: 4, label: "Thursday" },
  { id: 5, label: "Friday" },
  { id: 6, label: "Saturday" },
];

const empty = {
  reportTime: "17:40",
  timezone: "Africa/Cairo",
  weeklyOffDays: [5, 6],
  holidays: [],
};

export default function Settings() {
  const [form, setForm] = useState(empty);
  const [holidayDate, setHolidayDate] = useState("");
  const [holidayName, setHolidayName] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function load() {
    const res = await api("/api/settings");
    setForm({ ...empty, ...(res.data || {}) });
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  function toggleDay(id) {
    setForm((current) => {
      const has = current.weeklyOffDays.includes(id);
      return {
        ...current,
        weeklyOffDays: has
          ? current.weeklyOffDays.filter((day) => day !== id)
          : [...current.weeklyOffDays, id].sort(),
      };
    });
  }

  function addHoliday(event) {
    event.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate)) return;
    setForm((current) => ({
      ...current,
      holidays: [
        ...current.holidays.filter((item) => item.date !== holidayDate),
        { date: holidayDate, name: holidayName.trim() },
      ].sort((a, b) => a.date.localeCompare(b.date)),
    }));
    setHolidayDate("");
    setHolidayName("");
  }

  function removeHoliday(date) {
    setForm((current) => ({
      ...current,
      holidays: current.holidays.filter((item) => item.date !== date),
    }));
  }

  async function save(event) {
    event.preventDefault();
    setError("");
    setSaved("");
    try {
      const res = await api("/api/settings", { method: "PUT", body: form });
      setForm({ ...empty, ...(res.data || {}) });
      setSaved("Saved. n8n will use this time and skip holidays.");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Schedule</h1>
          <p>One run time for every automation. Holidays and weekends are skipped.</p>
        </div>
      </div>
      <form className="form" onSubmit={save}>
        <section className="section">
          <h2>Run time</h2>
          <p className="hint">Leave the n8n trigger on every 5 minutes. That only checks this clock.</p>
          <div className="grid">
            <label className="field">
              <span>Report time</span>
              <input
                type="time"
                value={form.reportTime}
                onChange={(e) => setForm({ ...form, reportTime: e.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>Timezone</span>
              <input
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                required
              />
            </label>
          </div>
        </section>

        <section className="section">
          <h2>Weekly off days</h2>
          <div className="day-pills">
            {DAYS.map((day) => (
              <label key={day.id} className={`day-pill ${form.weeklyOffDays.includes(day.id) ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={form.weeklyOffDays.includes(day.id)}
                  onChange={() => toggleDay(day.id)}
                />
                {day.label}
              </label>
            ))}
          </div>
        </section>

        <section className="section">
          <h2>Holidays</h2>
          <div className="grid">
            <label className="field">
              <span>Date</span>
              <input type="date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} />
            </label>
            <label className="field">
              <span>Name (optional)</span>
              <input
                value={holidayName}
                onChange={(e) => setHolidayName(e.target.value)}
                placeholder="Eid"
              />
            </label>
          </div>
          <button className="secondary" type="button" onClick={addHoliday} style={{ marginTop: 12 }}>
            Add holiday
          </button>
          {form.holidays.length === 0 ? (
            <p className="hint" style={{ marginTop: 16 }}>No extra holidays yet. Friday and Saturday are already off if checked above.</p>
          ) : (
            <ul className="holiday-list">
              {form.holidays.map((item) => (
                <li key={item.date}>
                  <span>
                    {item.date}
                    {item.name ? ` — ${item.name}` : ""}
                  </span>
                  <button className="danger" type="button" onClick={() => removeHoliday(item.date)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error ? <p className="error">{error}</p> : null}
        {saved ? <p className="hint">{saved}</p> : null}
        <button type="submit">Save schedule</button>
      </form>
    </div>
  );
}

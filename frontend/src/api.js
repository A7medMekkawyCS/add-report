const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

export function getSecret() {
  return sessionStorage.getItem("apiSecret") || "";
}

export function setSecret(value) {
  sessionStorage.setItem("apiSecret", value);
}

export function clearSecret() {
  sessionStorage.removeItem("apiSecret");
}

export async function api(path, { method = "GET", body } = {}) {
  const headers = { "X-API-SECRET": getSecret() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const err = new Error(data.message || "Unauthorized");
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.message || data.error || "Request failed");
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function extractTaskId(taskUrl) {
  const fromPortal = String(taskUrl || "").match(/my-tasks\/(\d+)/i);
  if (fromPortal) return fromPortal[1];
  const fromBackend = String(taskUrl || "").match(/[?&#]id=(\d+)/i);
  return fromBackend ? fromBackend[1] : null;
}

module.exports = { extractTaskId };

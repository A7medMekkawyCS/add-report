const crypto = require("crypto");

function reportHash(report) {
  return crypto.createHash("sha256").update(String(report || "")).digest("hex");
}

module.exports = { reportHash };

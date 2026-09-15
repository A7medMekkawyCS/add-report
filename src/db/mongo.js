const dns = require("dns");
const mongoose = require("mongoose");

function mongoUri() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL || "";
  return String(uri).trim();
}

function usePublicDnsIfLocalResolverBroken() {
  const servers = dns.getServers();
  const onlyLoopback = servers.every((server) =>
    server === "127.0.0.1" || server === "::1" || server.startsWith("127.0.0.1%") || server.startsWith("::1%")
  );
  if (onlyLoopback && servers.length) {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  }
}

async function connectDb() {
  const uri = mongoUri();
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }
  if (!uri.startsWith("mongodb")) {
    throw new Error("MONGODB_URI must be a mongodb:// or mongodb+srv:// connection string");
  }
  usePublicDnsIfLocalResolverBroken();
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  console.log("MongoDB connected");
}

module.exports = { connectDb, mongoUri };

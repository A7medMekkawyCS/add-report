const mongoose = require("mongoose");

function mongoUri() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL || "";
  return String(uri).trim();
}

async function connectDb() {
  const uri = mongoUri();
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }
  if (!uri.startsWith("mongodb")) {
    throw new Error("MONGODB_URI must be a mongodb:// or mongodb+srv:// connection string");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  console.log("MongoDB connected");
}

module.exports = { connectDb, mongoUri };

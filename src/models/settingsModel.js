const mongoose = require("mongoose");

const holidaySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, trim: true },
    name: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true },
    timezone: { type: String, default: "Africa/Cairo", trim: true },
    reportTime: { type: String, default: "17:40", trim: true },
    weeklyOffDays: { type: [Number], default: [5, 6] },
    holidays: { type: [holidaySchema], default: [] },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Settings || mongoose.model("Settings", settingsSchema, "settings");

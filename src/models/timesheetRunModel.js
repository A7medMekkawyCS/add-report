const mongoose = require("mongoose");

const timesheetRunSchema = new mongoose.Schema(
  {
    automationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationRule",
      required: true,
      index: true,
    },
    date: { type: String, required: true },
    status: { type: String, required: true },
    reportHash: { type: String, default: null },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true }
);

timesheetRunSchema.index({ automationId: 1, date: 1 }, { unique: true });

module.exports =
  mongoose.models.TimesheetRun || mongoose.model("TimesheetRun", timesheetRunSchema, "timesheet_runs");

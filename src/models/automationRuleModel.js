const mongoose = require("mongoose");

const automationRuleSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    odooProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OdooProfile",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    projectName: { type: String, required: true, trim: true },
    gitlabProjectPath: { type: String, required: true, trim: true },
    gitlabAuthorName: { type: String, required: true, trim: true },
    gitlabAuthorEmail: { type: String, required: true, trim: true },
    odooTaskUrl: { type: String, required: true, trim: true },
    hours: { type: Number, default: 7 },
    timezone: { type: String, default: "Africa/Cairo" },
    reportTime: { type: String, default: "17:40" },
    ignoreMergeCommits: { type: Boolean, default: true },
  },
  { timestamps: true }
);

automationRuleSchema.index({ gitlabProjectPath: 1, enabled: 1 });

module.exports =
  mongoose.models.AutomationRule ||
  mongoose.model("AutomationRule", automationRuleSchema, "automation_rules");

const mongoose = require("mongoose");

const odooProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    profileKey: { type: String, required: true, trim: true },
    odooUrl: { type: String, required: true, trim: true },
    login: { type: String, required: true, trim: true },
    encryptedPassword: { type: String, required: true },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

odooProfileSchema.index({ userId: 1, profileKey: 1 }, { unique: true });

module.exports =
  mongoose.models.OdooProfile || mongoose.model("OdooProfile", odooProfileSchema, "odoo_profiles");

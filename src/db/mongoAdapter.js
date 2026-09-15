const User = require("../models/userModel");
const OdooProfile = require("../models/odooProfileModel");
const AutomationRule = require("../models/automationRuleModel");
const TimesheetRun = require("../models/timesheetRunModel");
const Settings = require("../models/settingsModel");
const { defaultSettings } = require("../lib/schedule");

function prismaError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function wrapMongoError(err) {
  if (err.code === 11000) throw prismaError("P2002", "Already exists");
  if (err.name === "CastError") throw prismaError("P2025", "Record not found");
  throw err;
}

function jsonDoc(doc) {
  if (!doc) return null;
  const raw = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  const out = { ...raw };
  if (out._id) {
    out.id = String(out._id);
    delete out._id;
  }
  delete out.__v;

  if (out.userId && typeof out.userId === "object" && out.userId._id) {
    out.user = jsonDoc(out.userId);
    out.userId = out.user.id;
  } else if (out.userId) {
    out.userId = String(out.userId);
  }

  if (out.odooProfileId && typeof out.odooProfileId === "object" && out.odooProfileId._id) {
    out.odooProfile = jsonDoc(out.odooProfileId);
    out.odooProfileId = out.odooProfile.id;
  } else if (out.odooProfileId) {
    out.odooProfileId = String(out.odooProfileId);
  }

  if (out.automationId) out.automationId = String(out.automationId);
  if (out.user) out.userName = out.user.name;
  return out;
}

const automationInclude = [
  { path: "userId" },
  { path: "odooProfileId", populate: { path: "userId" } },
];

const mongoAdapter = {
  user: {
    async findMany() {
      const rows = await User.find().sort({ _id: -1 });
      return rows.map(jsonDoc);
    },
    async findUnique({ where }) {
      try {
        const row = where.email
          ? await User.findOne({ email: where.email })
          : await User.findById(where.id);
        return jsonDoc(row);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async create({ data }) {
      try {
        const row = await User.create(data);
        return jsonDoc(row);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async update({ where, data }) {
      try {
        const row = await User.findByIdAndUpdate(where.id, data, { new: true });
        if (!row) throw prismaError("P2025", "Record not found");
        return jsonDoc(row);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async delete({ where }) {
      const profileCount = await OdooProfile.countDocuments({ userId: where.id });
      const ruleCount = await AutomationRule.countDocuments({ userId: where.id });
      if (profileCount || ruleCount) {
        throw prismaError("P2003", "Cannot delete because related records exist");
      }
      const row = await User.findByIdAndDelete(where.id);
      if (!row) throw prismaError("P2025", "Record not found");
      return jsonDoc(row);
    },
  },
  odooProfile: {
    async findMany({ include } = {}) {
      let query = OdooProfile.find().sort({ _id: -1 });
      if (include?.user) query = query.populate("userId");
      const rows = await query;
      return rows.map(jsonDoc);
    },
    async findUnique({ where, include }) {
      try {
        let query = OdooProfile.findById(where.id);
        if (include?.user) query = query.populate("userId");
        return jsonDoc(await query);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async create({ data, include }) {
      try {
        const created = await OdooProfile.create(data);
        let query = OdooProfile.findById(created._id);
        if (include?.user) query = query.populate("userId");
        return jsonDoc(await query);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async update({ where, data, include }) {
      try {
        const row = await OdooProfile.findByIdAndUpdate(where.id, data, { new: true });
        if (!row) throw prismaError("P2025", "Record not found");
        let query = OdooProfile.findById(row._id);
        if (include?.user) query = query.populate("userId");
        return jsonDoc(await query);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async delete({ where }) {
      const ruleCount = await AutomationRule.countDocuments({ odooProfileId: where.id });
      if (ruleCount) {
        throw prismaError("P2003", "Cannot delete because related records exist");
      }
      const row = await OdooProfile.findByIdAndDelete(where.id);
      if (!row) throw prismaError("P2025", "Record not found");
      return jsonDoc(row);
    },
  },
  automationRule: {
    async findMany({ include, where } = {}) {
      let query = AutomationRule.find(where || {}).sort({ _id: -1 });
      if (include) query = query.populate(automationInclude);
      const rows = await query;
      return rows.map(jsonDoc);
    },
    async findUnique({ where, include }) {
      try {
        let query = AutomationRule.findById(where.id);
        if (include) query = query.populate(automationInclude);
        return jsonDoc(await query);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async findFirst({ where, include } = {}) {
      let query = AutomationRule.findOne(where || {});
      if (include) query = query.populate(automationInclude);
      return jsonDoc(await query);
    },
    async create({ data, include }) {
      try {
        const created = await AutomationRule.create(data);
        let query = AutomationRule.findById(created._id);
        if (include) query = query.populate(automationInclude);
        return jsonDoc(await query);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async update({ where, data, include }) {
      try {
        const row = await AutomationRule.findByIdAndUpdate(where.id, data, { new: true });
        if (!row) throw prismaError("P2025", "Record not found");
        let query = AutomationRule.findById(row._id);
        if (include) query = query.populate(automationInclude);
        return jsonDoc(await query);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async delete({ where }) {
      await TimesheetRun.deleteMany({ automationId: where.id });
      const row = await AutomationRule.findByIdAndDelete(where.id);
      if (!row) throw prismaError("P2025", "Record not found");
      return jsonDoc(row);
    },
  },
  timesheetRun: {
    async findUnique({ where }) {
      const pair = where.automationId_date;
      const row = pair
        ? await TimesheetRun.findOne({ automationId: pair.automationId, date: pair.date })
        : await TimesheetRun.findById(where.id);
      return jsonDoc(row);
    },
    async create({ data }) {
      try {
        const row = await TimesheetRun.create(data);
        return jsonDoc(row);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async update({ where, data }) {
      try {
        const pair = where.automationId_date;
        const row = pair
          ? await TimesheetRun.findOneAndUpdate(
              { automationId: pair.automationId, date: pair.date },
              data,
              { new: true }
            )
          : await TimesheetRun.findByIdAndUpdate(where.id, data, { new: true });
        if (!row) throw prismaError("P2025", "Record not found");
        return jsonDoc(row);
      } catch (err) {
        wrapMongoError(err);
      }
    },
    async upsert({ where, create, update }) {
      const existing = await this.findUnique({ where });
      if (existing) return this.update({ where, data: update });
      return this.create({ data: create });
    },
  },
  settings: {
    async findFirst() {
      let row = await Settings.findOne({ key: "global" });
      if (!row) {
        row = await Settings.create({ key: "global", ...defaultSettings() });
      }
      return jsonDoc(row);
    },
    async update({ data }) {
      const row = await Settings.findOneAndUpdate(
        { key: "global" },
        { $set: { key: "global", ...data } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      return jsonDoc(row);
    },
  },
};

module.exports = mongoAdapter;

require("dotenv").config();

const mongoose = require("mongoose");
const { connectDb } = require("./db/mongo");
const User = require("./models/userModel");
const OdooProfile = require("./models/odooProfileModel");
const AutomationRule = require("./models/automationRuleModel");
const { encryptSecret } = require("./crypto/secrets");

async function upsertUser({ name, email }) {
  return User.findOneAndUpdate(
    { email },
    { name, email, enabled: true },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

async function upsertAhmed() {
  const notificationEmail = "ahmedmekawyxa@gmail.com";
  const existingGmail = await User.findOne({ email: notificationEmail });
  const legacy = await User.findOne({ email: "ahmed@example.com" });
  if (legacy && !existingGmail) {
    legacy.name = "Ahmed Mekawy";
    legacy.email = notificationEmail;
    legacy.enabled = true;
    return legacy.save();
  }
  if (existingGmail) {
    existingGmail.name = "Ahmed Mekawy";
    existingGmail.enabled = true;
    return existingGmail.save();
  }
  return upsertUser({ name: "Ahmed Mekawy", email: notificationEmail });
}

async function upsertProfile({ userId, profileKey, login }) {
  return OdooProfile.findOneAndUpdate(
    { userId, profileKey },
    {
      $set: {
        odooUrl: "https://e.aait.sa",
        login,
        enabled: true,
      },
      $setOnInsert: {
        userId,
        profileKey,
        encryptedPassword: encryptSecret("change-me-odoo-password"),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

async function upsertAutomation(item) {
  const existing = await AutomationRule.findOne({
    userId: item.userId,
    gitlabProjectPath: item.gitlabProjectPath,
    gitlabAuthorEmail: item.gitlabAuthorEmail,
  });
  const data = {
    ...item,
    enabled: true,
    hours: 7,
    timezone: "Africa/Cairo",
    reportTime: "17:40",
    ignoreMergeCommits: true,
  };
  if (existing) {
    Object.assign(existing, data);
    return existing.save();
  }
  return AutomationRule.create(data);
}

async function main() {
  await connectDb();

  const ahmed = await upsertAhmed();
  const mohamed = await upsertUser({ name: "Mohamed Emad", email: "mohamed@example.com" });

  const ahmedProfile = await upsertProfile({
    userId: ahmed._id,
    profileKey: "ahmed-main",
    login: "ahmed@example.com",
  });
  const mohamedProfile = await upsertProfile({
    userId: mohamed._id,
    profileKey: "mohamed-main",
    login: "mohamed@example.com",
  });

  await upsertAutomation({
    name: "Ahmed - Haki",
    userId: ahmed._id,
    odooProfileId: ahmedProfile._id,
    projectName: "Haki",
    gitlabProjectPath: "a5945/mohamed-emad/haki",
    gitlabAuthorName: "Ahmed Mekawy",
    gitlabAuthorEmail: "ahmedmekawyxa@gmail.com",
    odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/23524",
  });
  await upsertAutomation({
    name: "Ahmed - Zafirra",
    userId: ahmed._id,
    odooProfileId: ahmedProfile._id,
    projectName: "Zafirra",
    gitlabProjectPath: "a5945/waled-hossam/zafirra",
    gitlabAuthorName: "Ahmed Mekawy",
    gitlabAuthorEmail: "ahmedmekawyxa@gmail.com",
    odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/217398",
  });
  await upsertAutomation({
    name: "Mohamed - Haki",
    userId: mohamed._id,
    odooProfileId: mohamedProfile._id,
    projectName: "Haki",
    gitlabProjectPath: "a5945/mohamed-emad/haki",
    gitlabAuthorName: "Mohamed Emad",
    gitlabAuthorEmail: "mohamed@example.com",
    odooTaskUrl: "https://e.aait.sa/odoo/my-tasks/28218",
  });

  console.log("Seed complete. Replace placeholder Odoo passwords from the dashboard.");
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });

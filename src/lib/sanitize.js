const SECRET_KEYS = new Set([
  "password",
  "encryptedPassword",
  "encrypted_password",
]);

function omitSecrets(record) {
  if (!record || typeof record !== "object") return record;
  const cleaned = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_KEYS.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function publicOdooProfile(profile) {
  if (!profile) return null;
  const { user, ...rest } = profile;
  return {
    ...omitSecrets(rest),
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          enabled: user.enabled,
        }
      : undefined,
  };
}

function publicAutomation(rule) {
  if (!rule) return null;
  const { user, odooProfile, ...rest } = rule;
  return {
    ...omitSecrets(rest),
    userName: rest.userName || user?.name,
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          enabled: user.enabled,
        }
      : undefined,
    odooProfile: odooProfile ? publicOdooProfile(odooProfile) : undefined,
  };
}

module.exports = {
  omitSecrets,
  publicOdooProfile,
  publicAutomation,
};

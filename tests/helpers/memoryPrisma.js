function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("equals" in expected) return row[key] === expected.equals;
    }
    if (key === "id" || key.endsWith("Id")) return sameId(row[key], expected);
    return row[key] === expected;
  });
}

function createMemoryPrisma(seed = {}) {
  const state = {
    users: seed.users ? clone(seed.users) : [],
    odooProfiles: seed.odooProfiles ? clone(seed.odooProfiles) : [],
    automationRules: seed.automationRules ? clone(seed.automationRules) : [],
    timesheetRuns: seed.timesheetRuns ? clone(seed.timesheetRuns) : [],
  };
  let ids = {
    users: Math.max(0, ...state.users.map((r) => r.id)),
    odooProfiles: Math.max(0, ...state.odooProfiles.map((r) => r.id)),
    automationRules: Math.max(0, ...state.automationRules.map((r) => r.id)),
    timesheetRuns: Math.max(0, ...state.timesheetRuns.map((r) => r.id)),
  };

  function nextId(collection) {
    ids[collection] += 1;
    return ids[collection];
  }

  function stamp(row) {
    const now = new Date().toISOString();
    return { ...row, createdAt: row.createdAt || now, updatedAt: now };
  }

  function withUser(profile) {
    return {
      ...profile,
      user: state.users.find((u) => u.id === profile.userId) || null,
    };
  }

  function withAutomationRelations(rule) {
    const user = state.users.find((u) => u.id === rule.userId) || null;
    const odooProfile = state.odooProfiles.find((p) => p.id === rule.odooProfileId) || null;
    return {
      ...rule,
      user,
      userName: user?.name,
      odooProfile: odooProfile ? withUser(odooProfile) : null,
    };
  }

  return {
    user: {
      async findMany() {
        return clone(state.users).sort((a, b) => b.id - a.id);
      },
      async findUnique({ where }) {
        const row = state.users.find((u) => sameId(u.id, where.id) || u.email === where.email);
        return row ? clone(row) : null;
      },
      async create({ data }) {
        if (state.users.some((u) => u.email === data.email)) {
          const err = new Error("Unique constraint failed on email");
          err.code = "P2002";
          throw err;
        }
        const row = stamp({ id: nextId("users"), enabled: true, ...data });
        state.users.push(row);
        return clone(row);
      },
      async update({ where, data }) {
        const row = state.users.find((u) => sameId(u.id, where.id));
        if (!row) {
          const err = new Error("Record not found");
          err.code = "P2025";
          throw err;
        }
        Object.assign(row, data, { updatedAt: new Date().toISOString() });
        return clone(row);
      },
      async delete({ where }) {
        const hasChildren =
          state.odooProfiles.some((p) => sameId(p.userId, where.id)) ||
          state.automationRules.some((r) => sameId(r.userId, where.id));
        if (hasChildren) {
          const err = new Error("Foreign key constraint failed");
          err.code = "P2003";
          throw err;
        }
        const idx = state.users.findIndex((u) => sameId(u.id, where.id));
        if (idx < 0) {
          const err = new Error("Record not found");
          err.code = "P2025";
          throw err;
        }
        const [removed] = state.users.splice(idx, 1);
        return clone(removed);
      },
    },
    odooProfile: {
      async findMany({ include } = {}) {
        const rows = clone(state.odooProfiles).sort((a, b) => b.id - a.id);
        if (include?.user) return rows.map(withUser);
        return rows;
      },
      async findUnique({ where, include }) {
        const row = state.odooProfiles.find((p) => sameId(p.id, where.id));
        if (!row) return null;
        const cloned = clone(row);
        return include?.user ? withUser(cloned) : cloned;
      },
      async create({ data, include }) {
        const row = stamp({ id: nextId("odooProfiles"), enabled: true, ...data });
        state.odooProfiles.push(row);
        const cloned = clone(row);
        return include?.user ? withUser(cloned) : cloned;
      },
      async update({ where, data, include }) {
        const row = state.odooProfiles.find((p) => sameId(p.id, where.id));
        if (!row) {
          const err = new Error("Record not found");
          err.code = "P2025";
          throw err;
        }
        Object.assign(row, data, { updatedAt: new Date().toISOString() });
        const cloned = clone(row);
        return include?.user ? withUser(cloned) : cloned;
      },
      async delete({ where }) {
        if (state.automationRules.some((r) => sameId(r.odooProfileId, where.id))) {
          const err = new Error("Foreign key constraint failed");
          err.code = "P2003";
          throw err;
        }
        const idx = state.odooProfiles.findIndex((p) => sameId(p.id, where.id));
        if (idx < 0) {
          const err = new Error("Record not found");
          err.code = "P2025";
          throw err;
        }
        const [removed] = state.odooProfiles.splice(idx, 1);
        return clone(removed);
      },
    },
    automationRule: {
      async findMany({ include, where } = {}) {
        let rows = state.automationRules.filter((row) => matchesWhere(row, where));
        rows = clone(rows).sort((a, b) => b.id - a.id);
        if (include) return rows.map(withAutomationRelations);
        return rows;
      },
      async findUnique({ where, include }) {
        const row = state.automationRules.find((r) => sameId(r.id, where.id));
        if (!row) return null;
        const cloned = clone(row);
        return include ? withAutomationRelations(cloned) : cloned;
      },
      async findFirst({ where, include } = {}) {
        const row = state.automationRules.find((r) => matchesWhere(r, where));
        if (!row) return null;
        const cloned = clone(row);
        return include ? withAutomationRelations(cloned) : cloned;
      },
      async create({ data, include }) {
        const row = stamp({
          id: nextId("automationRules"),
          enabled: true,
          hours: 7,
          timezone: "Africa/Cairo",
          reportTime: "17:40",
          ignoreMergeCommits: true,
          ...data,
        });
        state.automationRules.push(row);
        const cloned = clone(row);
        return include ? withAutomationRelations(cloned) : cloned;
      },
      async update({ where, data, include }) {
        const row = state.automationRules.find((r) => sameId(r.id, where.id));
        if (!row) {
          const err = new Error("Record not found");
          err.code = "P2025";
          throw err;
        }
        Object.assign(row, data, { updatedAt: new Date().toISOString() });
        const cloned = clone(row);
        return include ? withAutomationRelations(cloned) : cloned;
      },
      async delete({ where }) {
        const idx = state.automationRules.findIndex((r) => sameId(r.id, where.id));
        if (idx < 0) {
          const err = new Error("Record not found");
          err.code = "P2025";
          throw err;
        }
        state.timesheetRuns = state.timesheetRuns.filter((run) => !sameId(run.automationId, where.id));
        const [removed] = state.automationRules.splice(idx, 1);
        return clone(removed);
      },
    },
    timesheetRun: {
      async findUnique({ where }) {
        const pair = where.automationId_date;
        const row = pair
          ? state.timesheetRuns.find(
              (r) => sameId(r.automationId, pair.automationId) && r.date === pair.date
            )
          : state.timesheetRuns.find((r) => sameId(r.id, where.id));
        return row ? clone(row) : null;
      },
      async create({ data }) {
        const exists = state.timesheetRuns.find(
          (r) => sameId(r.automationId, data.automationId) && r.date === data.date
        );
        if (exists) {
          const err = new Error("Unique constraint failed on automationId_date");
          err.code = "P2002";
          throw err;
        }
        const row = stamp({ id: nextId("timesheetRuns"), ...data });
        state.timesheetRuns.push(row);
        return clone(row);
      },
      async update({ where, data }) {
        const row = where.automationId_date
          ? state.timesheetRuns.find(
              (r) =>
                sameId(r.automationId, where.automationId_date.automationId) &&
                r.date === where.automationId_date.date
            )
          : state.timesheetRuns.find((r) => sameId(r.id, where.id));
        if (!row) {
          const err = new Error("Record not found");
          err.code = "P2025";
          throw err;
        }
        Object.assign(row, data, { updatedAt: new Date().toISOString() });
        return clone(row);
      },
      async upsert({ where, create, update }) {
        const existing = await this.findUnique({ where });
        if (existing) {
          return this.update({ where, data: update });
        }
        return this.create({ data: create });
      },
    },
    _state: state,
  };
}

module.exports = { createMemoryPrisma };

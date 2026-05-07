const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function createFileStore({ dataDir }) {
  const dbPath = path.join(dataDir, "admin-db.json");

  async function load() {
    ensureDirSync(dataDir);
    const raw = await fsp.readFile(dbPath, "utf8").catch(() => "");
    if (!raw) {
      return {
        contractors: [],
        packages: [],
        offers: [],
        projects: [],
        settings: { createdAt: new Date().toISOString() },
      };
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        contractors: Array.isArray(parsed.contractors) ? parsed.contractors : [],
        packages: Array.isArray(parsed.packages) ? parsed.packages : [],
        offers: Array.isArray(parsed.offers) ? parsed.offers : [],
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
      };
    } catch {
      return {
        contractors: [],
        packages: [],
        offers: [],
        projects: [],
        settings: { createdAt: new Date().toISOString() },
      };
    }
  }

  async function save(db) {
    ensureDirSync(dataDir);
    const tmp = `${dbPath}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fsp.rename(tmp, dbPath);
  }

  async function update(mutator) {
    const db = await load();
    const updated = (await mutator(db)) || db;
    await save(updated);
    return updated;
  }

  return { load, save, update, dbPath };
}

module.exports = { createFileStore };


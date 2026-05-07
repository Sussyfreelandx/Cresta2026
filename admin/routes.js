const fs = require("node:fs/promises");
const path = require("node:path");

const express = require("express");

const { createFileStore } = require("./store");
const {
  computeApprovalScore,
  computeProjectRating,
  performanceTierFromAverage,
  evaluateProbation,
  isExpiringWithinDays,
  isExpired,
  scoreAllocation,
} = require("./logic");

function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(403).send("Admin access disabled.");

  const cookieHeader = String(req.headers.cookie || "");
  const cookieToken = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("adminToken="));
  const fromCookie = cookieToken ? decodeURIComponent(cookieToken.slice("adminToken=".length)) : "";

  const provided = String(req.get("x-admin-token") || "") || String(req.query.t || "") || fromCookie;
  if (provided !== token) return res.status(401).send("Unauthorized");

  if (req.query.t && req.query.t === token) {
    res.setHeader("Set-Cookie", `adminToken=${encodeURIComponent(token)}; Path=/; Max-Age=${2 * 60 * 60}; SameSite=Lax`);
  }
  return next();
}

function makeId(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readApplicationsLog(applicationsLogPath) {
  const raw = await fs.readFile(applicationsLogPath, "utf8").catch(() => "");
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeContractorFromApplication(app) {
  const score = computeApprovalScore(app);
  const regions = String(app.regionsCovered || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const c = {
    id: makeId("ctr"),
    createdAt: new Date().toISOString(),
    contractorName: app.applicantName || app.companyName || "Contractor",
    companyName: app.companyName || "",
    tradeCategory: app.tradeCategory || "",
    tierLevel: score.tierLevel,
    approvalScore: score.total,
    approvalBreakdown: score.breakdown,
    status: score.decision === "Rejected" ? "Suspended" : "Active",
    regionsCovered: regions,
    crewSize: app.workforceSize || "",
    equipmentCapabilities: String(app.equipmentCapabilities || ""),
    yearsExperience: Number(app.yearsOfExperience || 0),
    compliance: {
      insuranceExpiryDate: app.insuranceExpiryDate || "",
      licenseExpiryDate: app.licenseExpiryDate || "",
      w9Submitted: String(app.w9Status || "").toLowerCase().includes("provided"),
      oshaConfirmed: String(app.oshaCompliance || "").toLowerCase() === "yes",
      licenseVerified: String(app.stateLicense || "").toLowerCase() === "licensed",
      lastVerifiedAt: new Date().toISOString(),
    },
    performance: {
      averageScore: 0,
      totalScore: 0,
      projectsCompleted: 0,
      recentProjectScores: [],
      tier: "Standard Allocation",
    },
    responseHistory: { offersSent: 0, offersAccepted: 0, offersDeclined: 0, offersNoResponse: 0, noResponseStreak: 0, responseRate: 1 },
    availability: "Available",
    flags: { safetyViolations: 0, verifiedComplaints: 0 },
    probation: null,
    notes: [],
    documents: (app.uploads || []).map((u) => ({ field: u.field, filename: u.filename, link: u.link || "" })),
    applicationId: app.applicationId || "",
  };

  return evaluateProbation(c);
}

function registerAdminRoutes(app, { dataDir, applicationsLogPath, publicDir }) {
  const store = createFileStore({ dataDir });

  // Admin UI (internal)
  app.use("/admin", requireAdmin, express.static(path.join(publicDir, "admin"), { extensions: ["html"] }));

  // Admin APIs
  const adminJson = express.json({ limit: "250kb" });
  app.use("/api/admin", requireAdmin, adminJson);

  app.get("/api/admin/summary", async (_req, res) => {
    const db = await store.load();
    const contractors = db.contractors;
    const approved = contractors.filter((c) => c.tierLevel === "Tier 1" || c.tierLevel === "Tier 2").length;
    const tier1 = contractors.filter((c) => c.tierLevel === "Tier 1").length;
    const tier2 = contractors.filter((c) => c.tierLevel === "Tier 2").length;
    const probation = contractors.filter((c) => String(c.status || "").startsWith("Probation")).length;
    const expiringInsurance = contractors.filter((c) => isExpiringWithinDays(c.compliance?.insuranceExpiryDate, 30)).length;
    const activeProjects = db.projects.filter((p) => p.status === "Active").length;
    const pendingApplications = (await readApplicationsLog(applicationsLogPath)).length;
    const avgPerformance = contractors.length
      ? Math.round(contractors.reduce((sum, c) => sum + (Number(c.performance?.averageScore) || 0), 0) / contractors.length)
      : 0;

    return res.json({
      ok: true,
      metrics: {
        totalApprovedContractors: approved,
        tier1Count: tier1,
        tier2Count: tier2,
        contractorsOnProbation: probation,
        expiringInsuranceAlerts: expiringInsurance,
        activeProjects,
        pendingApplications,
        averagePerformanceScore: avgPerformance,
      },
    });
  });

  app.get("/api/admin/applications", async (_req, res) => {
    const apps = await readApplicationsLog(applicationsLogPath);
    return res.json({ ok: true, applications: apps });
  });

  app.post("/api/admin/contractors/from-application", async (req, res) => {
    const appRecord = req.body || {};
    const contractor = normalizeContractorFromApplication(appRecord);
    await store.update((db) => {
      db.contractors.push(contractor);
      return db;
    });
    return res.json({ ok: true, contractor });
  });

  app.get("/api/admin/contractors", async (_req, res) => {
    const db = await store.load();
    return res.json({ ok: true, contractors: db.contractors });
  });

  app.get("/api/admin/projects", async (_req, res) => {
    const db = await store.load();
    return res.json({ ok: true, projects: db.projects });
  });

  app.get("/api/admin/packages", async (_req, res) => {
    const db = await store.load();
    return res.json({ ok: true, packages: db.packages });
  });

  app.get("/api/admin/offers", async (_req, res) => {
    const db = await store.load();
    return res.json({ ok: true, offers: db.offers });
  });

  app.get("/api/admin/contractors/:id", async (req, res) => {
    const db = await store.load();
    const c = db.contractors.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: "Not found" });

    const projects = db.projects.filter((p) => p.contractorId === c.id);
    const alerts = {
      insuranceExpiring: isExpiringWithinDays(c.compliance?.insuranceExpiryDate, 30),
      licenseExpiring: isExpiringWithinDays(c.compliance?.licenseExpiryDate, 30),
      insuranceExpired: isExpired(c.compliance?.insuranceExpiryDate),
      licenseExpired: isExpired(c.compliance?.licenseExpiryDate),
      performanceLow: (Number(c.performance?.averageScore) || 0) < 75,
    };

    return res.json({ ok: true, contractor: c, alerts, projects });
  });

  app.post("/api/admin/contractors/:id/notes", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Missing note text." });

    const note = { id: makeId("note"), createdAt: new Date().toISOString(), text };
    const db = await store.update((db) => {
      const c = db.contractors.find((x) => x.id === req.params.id);
      if (!c) return db;
      c.notes = Array.isArray(c.notes) ? c.notes : [];
      c.notes.unshift(note);
      return db;
    });
    const contractor = db.contractors.find((x) => x.id === req.params.id);
    if (!contractor) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, contractor });
  });

  app.patch("/api/admin/contractors/:id", async (req, res) => {
    const allowed = req.body && typeof req.body === "object" ? req.body : {};
    const db = await store.update((db) => {
      const c = db.contractors.find((x) => x.id === req.params.id);
      if (!c) return db;

      if (allowed.tierLevel) c.tierLevel = String(allowed.tierLevel);
      if (allowed.status) c.status = String(allowed.status);
      if (allowed.availability) c.availability = String(allowed.availability);

      c.compliance = c.compliance || {};
      if (Object.prototype.hasOwnProperty.call(allowed, "insuranceExpiryDate")) c.compliance.insuranceExpiryDate = String(allowed.insuranceExpiryDate || "");
      if (Object.prototype.hasOwnProperty.call(allowed, "licenseExpiryDate")) c.compliance.licenseExpiryDate = String(allowed.licenseExpiryDate || "");
      if (Object.prototype.hasOwnProperty.call(allowed, "w9Submitted")) c.compliance.w9Submitted = Boolean(allowed.w9Submitted);
      if (Object.prototype.hasOwnProperty.call(allowed, "oshaConfirmed")) c.compliance.oshaConfirmed = Boolean(allowed.oshaConfirmed);
      if (Object.prototype.hasOwnProperty.call(allowed, "licenseVerified")) c.compliance.licenseVerified = Boolean(allowed.licenseVerified);

      const evaluated = evaluateProbation(c);
      Object.assign(c, evaluated);
      return db;
    });

    const contractor = db.contractors.find((x) => x.id === req.params.id);
    if (!contractor) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, contractor });
  });

  app.post("/api/admin/projects/complete", async (req, res) => {
    const contractorId = String(req.body?.contractorId || "");
    const projectName = String(req.body?.projectName || "").trim();
    if (!contractorId || !projectName) return res.status(400).json({ ok: false, error: "Missing contractorId/projectName." });

    const rating = computeProjectRating(req.body || {});

    const db = await store.update((db) => {
      const c = db.contractors.find((x) => x.id === contractorId);
      if (!c) return db;

      c.performance = c.performance || { averageScore: 0, totalScore: 0, projectsCompleted: 0, recentProjectScores: [], tier: "Standard Allocation" };
      c.performance.totalScore = (Number(c.performance.totalScore) || 0) + rating.total;
      c.performance.projectsCompleted = (Number(c.performance.projectsCompleted) || 0) + 1;
      c.performance.averageScore = Math.round(c.performance.totalScore / c.performance.projectsCompleted);
      c.performance.recentProjectScores = Array.isArray(c.performance.recentProjectScores) ? c.performance.recentProjectScores : [];
      c.performance.recentProjectScores.push(rating.total);
      c.performance.tier = performanceTierFromAverage(c.performance.averageScore);

      c.status = c.status && c.status.startsWith("Suspended") ? c.status : "Active";
      const evaluated = evaluateProbation(c);
      Object.assign(c, evaluated);

      db.projects.push({
        id: makeId("prj"),
        contractorId,
        projectName,
        completedAt: new Date().toISOString(),
        rating: rating.total,
        parts: rating.parts,
        status: "Completed",
      });
      return db;
    });

    const contractor = db.contractors.find((x) => x.id === contractorId);
    if (!contractor) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, contractor, rating });
  });

  app.post("/api/admin/packages", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const tradeCategory = String(req.body?.tradeCategory || "").trim();
    const region = String(req.body?.region || "").trim();
    const allocationType = String(req.body?.allocationType || "").trim();
    if (!name || !tradeCategory || !region) return res.status(400).json({ ok: false, error: "Missing name/tradeCategory/region." });

    const pkg = {
      id: makeId("pkg"),
      createdAt: new Date().toISOString(),
      name,
      tradeCategory,
      region,
      allocationType: allocationType || "Competitive Bid",
      status: "Open",
    };

    const db = await store.update((db) => {
      db.packages.push(pkg);
      return db;
    });
    return res.json({ ok: true, package: pkg, dbVersion: db.packages.length });
  });

  function updateResponseStats(c) {
    c.responseHistory = c.responseHistory || { offersSent: 0, offersAccepted: 0, offersDeclined: 0, offersNoResponse: 0, noResponseStreak: 0, responseRate: 1 };
    const sent = Number(c.responseHistory.offersSent) || 0;
    const responded = (Number(c.responseHistory.offersAccepted) || 0) + (Number(c.responseHistory.offersDeclined) || 0);
    c.responseHistory.responseRate = sent ? responded / sent : 1;
  }

  app.get("/api/admin/packages/:id/rank", async (req, res) => {
    const db = await store.load();
    const pkg = db.packages.find((p) => p.id === req.params.id);
    if (!pkg) return res.status(404).json({ ok: false, error: "Not found" });

    const ranked = db.contractors
      .map((c) => {
        const r = scoreAllocation({ contractor: c, tradeCategory: pkg.tradeCategory, region: pkg.region });
        return { contractorId: c.id, contractorName: c.contractorName, tierLevel: c.tierLevel, status: c.status, score: r.score, reliabilityIndex: r.reliabilityIndex, eligible: r.eligible };
      })
      .filter((r) => r.eligible)
      .sort((a, b) => (b.reliabilityIndex || b.score) - (a.reliabilityIndex || a.score));

    return res.json({ ok: true, package: pkg, ranked });
  });

  app.post("/api/admin/packages/:id/send-offers", async (req, res) => {
    const mode = String(req.body?.mode || "top3"); // top3 | auto
    const db = await store.update((db) => {
      const pkg = db.packages.find((p) => p.id === req.params.id);
      if (!pkg) return db;

      const ranked = db.contractors
        .map((c) => ({ c, r: scoreAllocation({ contractor: c, tradeCategory: pkg.tradeCategory, region: pkg.region }) }))
        .filter((x) => x.r.eligible)
        .filter((x) => (pkg.allocationType === "Direct Award" ? x.c.tierLevel === "Tier 1" : true))
        .sort((a, b) => (b.r.reliabilityIndex || b.r.score) - (a.r.reliabilityIndex || a.r.score));

      const selected =
        pkg.allocationType === "Emergency Dispatch"
          ? ranked.slice().sort((a, b) => {
              const avA = a.c.availability === "Available" ? 2 : a.c.availability === "Limited" ? 1 : 0;
              const avB = b.c.availability === "Available" ? 2 : b.c.availability === "Limited" ? 1 : 0;
              if (avB !== avA) return avB - avA;
              return (Number(b.c.performance?.averageScore) || 0) - (Number(a.c.performance?.averageScore) || 0);
            }).slice(0, 1)
          : mode === "auto"
          ? ranked.slice(0, 1)
          : pkg.allocationType === "Competitive Bid"
          ? ranked.slice(0, 5)
          : ranked.slice(0, 3);

      const now = Date.now();
      const expiresAt = new Date(now + 36 * 60 * 60 * 1000).toISOString();

      for (const { c } of selected) {
        const offer = {
          id: makeId("offer"),
          packageId: pkg.id,
          contractorId: c.id,
          sentAt: new Date(now).toISOString(),
          expiresAt,
          status: "Sent",
        };
        db.offers.push(offer);
        c.responseHistory = c.responseHistory || {};
        c.responseHistory.offersSent = (Number(c.responseHistory.offersSent) || 0) + 1;
        updateResponseStats(c);
        Object.assign(c, evaluateProbation(c));
      }

      return db;
    });

    const pkg = db.packages.find((p) => p.id === req.params.id);
    if (!pkg) return res.status(404).json({ ok: false, error: "Not found" });
    const offers = db.offers.filter((o) => o.packageId === pkg.id);
    return res.json({ ok: true, package: pkg, offers });
  });

  app.post("/api/admin/offers/:id/respond", async (req, res) => {
    const action = String(req.body?.action || "").toLowerCase(); // accept | decline | no_response
    if (!["accept", "decline", "no_response"].includes(action)) return res.status(400).json({ ok: false, error: "Invalid action." });

    const db = await store.update((db) => {
      const offer = db.offers.find((o) => o.id === req.params.id);
      if (!offer) return db;
      if (offer.status !== "Sent") return db;
      const c = db.contractors.find((x) => x.id === offer.contractorId);
      if (!c) return db;

      if (action === "accept") {
        offer.status = "Accepted";
        c.responseHistory.offersAccepted = (Number(c.responseHistory.offersAccepted) || 0) + 1;
        c.responseHistory.noResponseStreak = 0;
      } else if (action === "decline") {
        offer.status = "Declined";
        c.responseHistory.offersDeclined = (Number(c.responseHistory.offersDeclined) || 0) + 1;
        c.responseHistory.noResponseStreak = 0;
      } else {
        offer.status = "No Response";
        c.responseHistory.offersNoResponse = (Number(c.responseHistory.offersNoResponse) || 0) + 1;
        c.responseHistory.noResponseStreak = (Number(c.responseHistory.noResponseStreak) || 0) + 1;
      }

      updateResponseStats(c);
      Object.assign(c, evaluateProbation(c));
      return db;
    });

    const offer = db.offers.find((o) => o.id === req.params.id);
    if (!offer) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, offer });
  });

  app.get("/api/admin/alerts", async (_req, res) => {
    const db = await store.load();
    const contractors = db.contractors.map((c) => {
      const insuranceExpiring = isExpiringWithinDays(c.compliance?.insuranceExpiryDate, 30);
      const licenseExpiring = isExpiringWithinDays(c.compliance?.licenseExpiryDate, 30);
      const performanceDropping = (Number(c.performance?.averageScore) || 0) < 75;
      const threeDeclines = (Number(c.responseHistory?.offersDeclined) || 0) >= 3;
      return { contractorId: c.id, contractorName: c.contractorName, insuranceExpiring, licenseExpiring, performanceDropping, threeDeclines };
    });
    return res.json({ ok: true, alerts: contractors.filter((a) => a.insuranceExpiring || a.licenseExpiring || a.performanceDropping || a.threeDeclines) });
  });

  app.get("/api/admin/reports/compliance-expiration", async (_req, res) => {
    const db = await store.load();
    const items = db.contractors
      .map((c) => ({
        contractorId: c.id,
        contractorName: c.contractorName,
        insuranceExpiryDate: c.compliance?.insuranceExpiryDate || "",
        licenseExpiryDate: c.compliance?.licenseExpiryDate || "",
      }))
      .filter((x) => isExpiringWithinDays(x.insuranceExpiryDate, 60) || isExpiringWithinDays(x.licenseExpiryDate, 60));
    return res.json({ ok: true, report: { type: "Compliance Expiration Report", items } });
  });

  app.get("/api/admin/reports/regional-coverage", async (_req, res) => {
    const db = await store.load();
    const map = new Map();
    for (const c of db.contractors) {
      const regions = Array.isArray(c.regionsCovered) ? c.regionsCovered : [];
      for (const r of regions) {
        map.set(r, (map.get(r) || 0) + 1);
      }
    }
    const items = Array.from(map.entries()).map(([region, contractorCount]) => ({ region, contractorCount })).sort((a, b) => b.contractorCount - a.contractorCount);
    return res.json({ ok: true, report: { type: "Regional Coverage Report", items } });
  });

  return { requireAdmin, store };
}

module.exports = { registerAdminRoutes };

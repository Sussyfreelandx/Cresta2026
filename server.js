const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const nodemailer = require("nodemailer");

const { registerAdminRoutes } = require("./admin/routes");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const APPLICATIONS_LOG = path.join(DATA_DIR, "applications.jsonl");
const SUBSCRIBERS_LOG = path.join(DATA_DIR, "email-subscribers.jsonl");

// Consent text shown next to the opt-in checkbox on /email-subscribe.html.
// Recorded verbatim with every subscription so it can be produced for an SMTP
// provider audit as proof of opt-in.
const SUBSCRIBE_CONSENT_TEXT =
  "I confirm I am authorised to subscribe the business email above and I expressly opt in to receive operational, compliance, and contracting emails from Crestara Construction Autority. I understand I can withdraw consent at any time using the unsubscribe link in every email or by contacting info@cresteraconstructionauthority.com. I have read the Privacy Policy.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeSegment(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return cleaned || "file";
}

function createApp() {
  ensureDirSync(PUBLIC_DIR);
  ensureDirSync(DATA_DIR);
  ensureDirSync(UPLOADS_DIR);

  const app = express();
  app.set("trust proxy", 1);
  const adminFilesLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const applicationLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: "Too many requests." }),
  });
  const subscribeLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ ok: false, error: "Too many requests." }),
  });

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
  });

  app.get("/config.js", (req, res) => {
    const config = {
      recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || "",
      smsWebhookEnabled: Boolean(process.env.SMS_WEBHOOK_URL),
    };
    res.type("application/javascript").send(`window.__CRESTARA_CONFIG__=${JSON.stringify(config)};`);
  });

  registerAdminRoutes(app, { dataDir: DATA_DIR, applicationsLogPath: APPLICATIONS_LOG, publicDir: PUBLIC_DIR });

  app.use("/assets", express.static(path.join(PUBLIC_DIR, "assets")));
  app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const applicationId = req.applicationId || "unknown";
      const dir = path.join(UPLOADS_DIR, safeSegment(applicationId));
      ensureDirSync(dir);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}-${safeSegment(path.basename(file.originalname || "upload"))}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: 15 * 1024 * 1024,
    },
  });

  function assignApplicationId(req, _res, next) {
    req.applicationId = crypto.randomUUID();
    next();
  }

  async function verifyRecaptchaIfEnabled(token, ip) {
    if (!process.env.RECAPTCHA_SECRET) return { ok: true };
    if (!token) return { ok: false, reason: "Missing reCAPTCHA token." };

    const body = new URLSearchParams();
    body.set("secret", process.env.RECAPTCHA_SECRET);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);

    const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!resp.ok) return { ok: false, reason: "reCAPTCHA verification failed." };
    const data = await resp.json().catch(() => ({}));
    return data && data.success ? { ok: true } : { ok: false, reason: "reCAPTCHA rejected." };
  }

  function buildFileLinks(applicationId, files) {
    const accessToken = process.env.FILE_ACCESS_TOKEN;
    const items = [];

    for (const file of files) {
      const filename = path.basename(file.filename);
      const link = accessToken
        ? `/admin/files/${encodeURIComponent(applicationId)}/${encodeURIComponent(filename)}?t=${encodeURIComponent(accessToken)}`
        : null;

      items.push({
        field: file.fieldname,
        filename,
        size: file.size,
        link,
      });
    }

    return items;
  }

  async function appendApplicationLog(record) {
    ensureDirSync(DATA_DIR);
    await fsp.appendFile(APPLICATIONS_LOG, `${JSON.stringify(record)}\n`, "utf8");
  }

  async function sendTelegramNotification(record) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const lines = [
      "🧾 New Contractor Application",
      "",
      `Application ID: ${record.applicationId}`,
      `Timestamp: ${record.timestamp}`,
      `IP: ${record.ipAddress}`,
      "",
      `Applicant Name: ${record.applicantName}`,
      `Company Name: ${record.companyName}`,
      `Trade Category: ${record.tradeCategory}`,
      `Phone Number: ${record.phoneNumber}`,
      `Email: ${record.email}`,
      `Region: ${record.regionsCovered}`,
      `Years of Experience: ${record.yearsOfExperience}`,
      `COI (General Liability) Status: ${record.coiStatus}`,
      `W-9 Status: ${record.w9Status}`,
      `State License (if required): ${record.stateLicense}`,
      `OSHA Compliance: ${record.oshaCompliance}`,
      `U.S. Work Authorization: ${record.workAuthorization}`,
    ];

    if (record.uploads?.length) {
      lines.push("", "Uploaded Documents:");
      for (const u of record.uploads) {
        lines.push(`- ${u.field}: ${u.link ? u.link : u.filename}`);
      }
    }

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        disable_web_page_preview: true,
      }),
    }).catch(() => undefined);
  }

  async function sendEmailNotification(record) {
    const {
      SMTP_HOST,
      SMTP_PORT,
      SMTP_USER,
      SMTP_PASS,
      SMTP_FROM,
      SMTP_TO,
    } = process.env;

    if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM || !SMTP_TO) return;

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });

    const subject = `New Contractor Application – ${record.tradeCategory}`;
    const uploadsSection = record.uploads?.length
      ? record.uploads.map((u) => `- ${u.field}: ${u.link ? u.link : u.filename}`).join("\n")
      : "None";

    const text = [
      "New contractor application received.",
      "",
      `Application ID: ${record.applicationId}`,
      `Timestamp: ${record.timestamp}`,
      `IP: ${record.ipAddress}`,
      "",
      `Applicant Name: ${record.applicantName}`,
      `Company Name: ${record.companyName}`,
      `Trade Category: ${record.tradeCategory}`,
      `Phone Number: ${record.phoneNumber}`,
      `Email: ${record.email}`,
      `Region: ${record.regionsCovered}`,
      `Years of Experience: ${record.yearsOfExperience}`,
      `COI (General Liability) Status: ${record.coiStatus}`,
      `W-9 Status: ${record.w9Status}`,
      `State License (if required): ${record.stateLicense}`,
      `State License Number: ${record.stateLicenseNumber || "N/A"}`,
      `OSHA Compliance: ${record.oshaCompliance}`,
      `U.S. Work Authorization: ${record.workAuthorization}`,
      `Workforce Size: ${record.workforceSize}`,
      `Emergency Availability: ${record.emergencyAvailability}`,
      "",
      "Uploaded Documents:",
      uploadsSection,
    ].join("\n");

    await transporter.sendMail({
      from: SMTP_FROM,
      to: SMTP_TO,
      subject,
      text,
    });
  }

  async function sendSmsWebhook(record) {
    const url = process.env.SMS_WEBHOOK_URL;
    if (!url) return;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        applicationId: record.applicationId,
        applicantName: record.applicantName,
        companyName: record.companyName,
        tradeCategory: record.tradeCategory,
        phoneNumber: record.phoneNumber,
        timestamp: record.timestamp,
      }),
    }).catch(() => undefined);
  }

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.get("/admin/files/:applicationId/:filename", adminFilesLimiter, (req, res) => {
    const token = String(req.query.t || "");
    if (!process.env.FILE_ACCESS_TOKEN || token !== process.env.FILE_ACCESS_TOKEN) {
      return res.status(403).send("Forbidden");
    }

    const applicationId = safeSegment(req.params.applicationId);
    const filename = safeSegment(req.params.filename);
    const filePath = path.join(UPLOADS_DIR, applicationId, filename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
      return res.status(400).send("Invalid file path");
    }
    return res.download(resolved, filename, (err) => {
      if (err && !res.headersSent) {
        if (err.code === "ENOENT") return res.status(404).send("File not found");
        return res.status(err.statusCode || 500).send("Download failed");
      }
    });
  });

  async function appendSubscriberLog(record) {
    ensureDirSync(DATA_DIR);
    await fsp.appendFile(SUBSCRIBERS_LOG, `${JSON.stringify(record)}\n`, "utf8");
  }

  async function sendSubscriberConfirmationEmail(record) {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_TO } = process.env;
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM || !SMTP_TO) return;

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });

    const text = [
      "New B2B email subscription opt-in.",
      "",
      `Subscription ID: ${record.subscriptionId}`,
      `Timestamp: ${record.timestamp}`,
      `Source URL: ${record.sourceUrl}`,
      `IP: ${record.ipAddress}`,
      `User-Agent: ${record.userAgent}`,
      "",
      `Company: ${record.companyName}`,
      `Contact: ${record.contactName}`,
      `Email: ${record.email}`,
      `Role: ${record.role || "N/A"}`,
      `Trade / business type: ${record.tradeCategory || "N/A"}`,
      `Region: ${record.region || "N/A"}`,
      `Referrer note: ${record.referrer || "N/A"}`,
      "",
      "Consent text agreed to:",
      record.consentText,
    ].join("\n");

    await transporter.sendMail({
      from: SMTP_FROM,
      to: SMTP_TO,
      subject: `B2B email opt-in – ${record.companyName}`,
      text,
    });
  }

  app.post(
    "/api/email-subscribe",
    subscribeLimiter,
    express.urlencoded({ extended: false, limit: "32kb" }),
    express.json({ limit: "32kb" }),
    multer().none(),
    async (req, res) => {
      const ipAddress = req.ip || req.connection?.remoteAddress || "";
      const userAgent = String(req.get("user-agent") || "").slice(0, 500);
      const body = req.body || {};

      // Honeypot: real users leave the hidden "website" field empty. Bots
      // typically fill every field, so a non-empty value is silently rejected.
      if (String(body.website || "").trim() !== "") {
        return res.status(400).json({ ok: false, error: "Submission rejected." });
      }

      const recaptcha = await verifyRecaptchaIfEnabled(body.recaptchaToken, ipAddress);
      if (!recaptcha.ok) return res.status(400).json({ ok: false, error: recaptcha.reason });

      const trim = (v, max) => String(v || "").trim().slice(0, max);
      const companyName = trim(body.companyName, 200);
      const contactName = trim(body.contactName, 200);
      const email = trim(body.email, 320).toLowerCase();
      const role = trim(body.role, 120);
      const tradeCategory = trim(body.tradeCategory, 160);
      const region = trim(body.region, 160);
      const referrer = trim(body.referrer, 200);
      const consent = String(body.consent || "").trim().toLowerCase();

      if (!companyName || !contactName || !email) {
        return res.status(400).json({ ok: false, error: "Missing required fields." });
      }
      if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ ok: false, error: "Please provide a valid business email address." });
      }
      if (!(consent === "yes" || consent === "on" || consent === "true")) {
        return res
          .status(400)
          .json({ ok: false, error: "You must tick the consent box to subscribe." });
      }

      const record = {
        subscriptionId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ipAddress,
        userAgent,
        sourceUrl: "/email-subscribe.html",
        companyName,
        contactName,
        email,
        role,
        tradeCategory,
        region,
        referrer,
        consent: true,
        consentText: SUBSCRIBE_CONSENT_TEXT,
      };

      await appendSubscriberLog(record);

      await Promise.allSettled([sendSubscriberConfirmationEmail(record)]);

      const wantsJson =
        String(req.get("accept") || "").includes("application/json") ||
        String(req.get("x-requested-with") || "").toLowerCase() === "xmlhttprequest";
      if (wantsJson) {
        return res.json({ ok: true, subscriptionId: record.subscriptionId });
      }

      // No-JS fallback: redirect to the page with a success flag.
      return res.redirect(303, "/email-subscribe.html?subscribed=1");
    }
  );

  app.post(
    "/api/contractor-application",
    applicationLimiter,
    assignApplicationId,
    upload.fields([
      { name: "certificateOfInsurance", maxCount: 1 },
      { name: "w9Form", maxCount: 1 },
      { name: "licenseDocument", maxCount: 1 },
      { name: "portfolio", maxCount: 5 },
    ]),
    async (req, res) => {
      const ipAddress = req.ip || req.connection?.remoteAddress || "";

      const body = req.body || {};
      const recaptcha = await verifyRecaptchaIfEnabled(body.recaptchaToken, ipAddress);
      if (!recaptcha.ok) return res.status(400).json({ ok: false, error: recaptcha.reason });

      const required = (key) => String(body[key] || "").trim();
      const applicantName = required("applicantName");
      const companyName = required("companyName");
      const tradeCategory = required("tradeCategory");
      const yearsOfExperience = required("yearsOfExperience");
      const phoneNumber = required("phoneNumber");
      const email = required("email");
      const regionsCovered = required("regionsCovered");
      const workforceSize = required("workforceSize");
      const emergencyAvailability = required("emergencyAvailability");
      const stateLicense = required("stateLicense");
      const stateLicenseNumber = String(body.stateLicenseNumber || "").trim();
      const oshaCompliance = required("oshaCompliance");
      const workAuthorization = required("workAuthorization");

      if (
        !applicantName ||
        !companyName ||
        !tradeCategory ||
        !yearsOfExperience ||
        !phoneNumber ||
        !email ||
        !regionsCovered ||
        !stateLicense ||
        !oshaCompliance ||
        !workAuthorization
      ) {
        return res.status(400).json({ ok: false, error: "Missing required fields." });
      }

      const files = Object.values(req.files || {}).flat();
      const coiStatus = files.some((f) => f.fieldname === "certificateOfInsurance") ? "Provided" : "Not Provided";
      const w9Status = files.some((f) => f.fieldname === "w9Form") ? "Provided" : "Not Provided";

      if (coiStatus !== "Provided") {
        return res.status(400).json({ ok: false, error: "Certificate of Insurance (COI) upload is required." });
      }
      if (w9Status !== "Provided") {
        return res.status(400).json({ ok: false, error: "W-9 upload is required." });
      }

      const applicationId = req.applicationId;
      const uploads = buildFileLinks(applicationId, files);

      const record = {
        applicationId,
        timestamp: new Date().toISOString(),
        ipAddress,
        applicantName,
        companyName,
        tradeCategory,
        yearsOfExperience,
        phoneNumber,
        email,
        regionsCovered,
        workforceSize,
        emergencyAvailability,
        stateLicense,
        stateLicenseNumber,
        oshaCompliance,
        workAuthorization,
        coiStatus,
        w9Status,
        uploads,
      };

      await appendApplicationLog(record);

      await Promise.allSettled([
        sendEmailNotification(record),
        sendTelegramNotification(record),
        sendSmsWebhook(record),
      ]);

      return res.json({ ok: true, applicationId });
    }
  );

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, () => {
    console.log(`Crestara website running on http://localhost:${port}`);
  });
}

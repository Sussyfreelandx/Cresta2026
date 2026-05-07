function qs(sel) {
  return document.querySelector(sel);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function token() {
  return new URLSearchParams(window.location.search).get("t") || "";
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, { "x-admin-token": token() });
  const resp = await fetch(path, Object.assign({}, opts, { headers }));
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) {
    const msg = data.error || resp.statusText || "Request failed";
    throw new Error(msg);
  }
  return data;
}

function setNavActive(hash) {
  document.querySelectorAll("[data-admin-nav]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (href === hash) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function setTitle(title, subtitle) {
  qs("#admin-title").textContent = title;
  qs("#admin-subtitle").textContent = subtitle || "";
}

function renderKpis(metrics) {
  const items = [
    ["Total Approved Contractors", metrics.totalApprovedContractors],
    ["Tier 1 / Tier 2 Counts", `${metrics.tier1Count} / ${metrics.tier2Count}`],
    ["Contractors on Probation", metrics.contractorsOnProbation],
    ["Expiring Insurance Alerts", metrics.expiringInsuranceAlerts],
    ["Active Projects", metrics.activeProjects],
    ["Pending Applications", metrics.pendingApplications],
    ["Average Performance Score", metrics.averagePerformanceScore],
  ];

  const grid = document.createElement("div");
  grid.className = "kpi-grid";
  for (const [label, value] of items) {
    const card = document.createElement("div");
    card.className = "kpi";
    card.innerHTML = `<div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>`;
    grid.appendChild(card);
  }
  return grid;
}

function barChart(values) {
  const w = 520;
  const h = 160;
  const max = Math.max(1, ...values);
  const barW = Math.floor(w / values.length);
  const gap = 6;
  const bars = values
    .map((v, i) => {
      const bh = Math.round((v / max) * (h - 30));
      const x = i * barW + gap;
      const y = h - bh - 20;
      const bw = barW - gap * 2;
      return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="6" fill="rgba(11,31,58,.22)" stroke="rgba(11,31,58,.35)"/>`;
    })
    .join("");

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Dashboard chart">${bars}<line x1="0" y1="${h - 20}" x2="${w}" y2="${h - 20}" stroke="rgba(17,24,39,.25)"/></svg>`;
}

async function viewDashboard() {
  setTitle("Dashboard", "Operational overview");
  const root = qs("#admin-view");
  root.innerHTML = "";
  const data = await api("/api/admin/summary");

  root.appendChild(renderKpis(data.metrics));

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `<h2>Performance Distribution (sample)</h2>${barChart([data.metrics.averagePerformanceScore, data.metrics.tier1Count * 10, data.metrics.tier2Count * 10, data.metrics.contractorsOnProbation * 10])}<div class="muted" style="margin-top:8px;">Charts use corporate navy/gray tones for internal operational visibility.</div>`;
  root.appendChild(panel);
}

function badgeForStatus(status) {
  const s = String(status || "");
  if (s.startsWith("Probation")) return `<span class="badge warn">${esc(s)}</span>`;
  if (s.startsWith("Suspended")) return `<span class="badge danger">${esc(s)}</span>`;
  return `<span class="badge navy">${esc(s || "Active")}</span>`;
}

async function viewContractors() {
  setTitle("Contractors", "Profiles, tiers, compliance, and performance");
  const root = qs("#admin-view");
  root.innerHTML = "";

  const data = await api("/api/admin/contractors");
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `<h2>Contractor List</h2>
    <table class="table">
      <thead><tr><th>Name</th><th>Trade</th><th>Tier</th><th>Performance</th><th>Status</th></tr></thead>
      <tbody>
        ${data.contractors
          .map(
            (c) => `<tr>
              <td><a href="#contractor:${esc(c.id)}">${esc(c.contractorName)}</a></td>
              <td>${esc(c.tradeCategory)}</td>
              <td><span class="badge">${esc(c.tierLevel)}</span></td>
              <td>${esc(c.performance?.averageScore ?? 0)}</td>
              <td>${badgeForStatus(c.status)}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>`;

  root.appendChild(panel);

  const appsPanel = document.createElement("div");
  appsPanel.className = "panel";
  appsPanel.innerHTML = `<h2>Pending Applications</h2><div class="muted">Approve applications to create contractor profiles and auto-calculate approval scores / tier levels.</div><div id="apps-table" style="margin-top:10px;" class="muted">Loading…</div>`;
  root.appendChild(appsPanel);

  try {
    const apps = await api("/api/admin/applications");
    const rows = (apps.applications || [])
      .slice()
      .reverse()
      .slice(0, 20)
      .map(
        (a) => `<tr>
          <td>${esc(a.companyName || "")}</td>
          <td>${esc(a.applicantName || "")}</td>
          <td>${esc(a.tradeCategory || "")}</td>
          <td>${esc(a.regionsCovered || "")}</td>
          <td><button class="submit" type="button" data-approve="${esc(a.applicationId || "")}">Approve &amp; Score</button></td>
        </tr>`
      )
      .join("");

    qs("#apps-table").innerHTML = `<table class="table">
      <thead><tr><th>Company</th><th>Applicant</th><th>Trade</th><th>Region(s)</th><th>Action</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted">No pending applications found.</td></tr>`}</tbody>
    </table>`;

    document.querySelectorAll("[data-approve]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-approve");
        const record = (apps.applications || []).find((x) => String(x.applicationId) === String(id));
        if (!record) return;
        await api("/api/admin/contractors/from-application", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });
        alert("Contractor created.");
        window.location.hash = "#contractors";
      });
    });
  } catch (err) {
    qs("#apps-table").textContent = err.message || String(err);
  }
}

function tabsList() {
  return ["Overview", "Compliance", "Performance History", "Project History", "Notes", "Documents"];
}

function spark(values) {
  const pts = values.slice(-12);
  const w = 520;
  const h = 120;
  const max = Math.max(1, ...pts);
  const min = Math.min(...pts, 0);
  const range = Math.max(1, max - min);
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  const d = pts
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * (h - 20) - 10;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Performance trend"><path d="${d}" fill="none" stroke="rgba(11,31,58,.55)" stroke-width="3"/><line x1="0" y1="${h - 10}" x2="${w}" y2="${h - 10}" stroke="rgba(17,24,39,.18)"/></svg>`;
}

function renderContractorTab(contractor, alerts, projects, tab) {
  if (tab === "Overview") {
    return `<div class="grid">
      <div class="card" style="grid-column:span 12;">
        <h3>Overview</h3>
        <ul>
          <li><strong>Approval Score:</strong> ${esc(contractor.approvalScore ?? 0)} (Tier: ${esc(contractor.tierLevel)})</li>
          <li><strong>Performance Rating:</strong> ${esc(contractor.performance?.tier || "Standard Allocation")}</li>
          <li><strong>Regions Covered:</strong> ${esc((contractor.regionsCovered || []).join(", "))}</li>
          <li><strong>Crew Size:</strong> ${esc(contractor.crewSize || "")}</li>
          <li><strong>Equipment Capabilities:</strong> ${esc(contractor.equipmentCapabilities || "Not specified")}</li>
          <li><strong>Years Experience:</strong> ${esc(contractor.yearsExperience ?? 0)}</li>
        </ul>
      </div>
    </div>`;
  }

  if (tab === "Compliance") {
    const ins = contractor.compliance?.insuranceExpiryDate || "";
    const lic = contractor.compliance?.licenseExpiryDate || "";
    const insBadge = alerts.insuranceExpired ? "danger" : alerts.insuranceExpiring ? "warn" : "navy";
    const licBadge = alerts.licenseExpired ? "danger" : alerts.licenseExpiring ? "warn" : "navy";
    return `<div class="grid">
      <div class="card" style="grid-column:span 12;">
        <h3>Compliance</h3>
        <ul>
          <li><strong>Insurance Expiry Date:</strong> <span class="badge ${insBadge}">${esc(ins || "Not set")}</span></li>
          <li><strong>License Expiry Date:</strong> <span class="badge ${licBadge}">${esc(lic || "Not set")}</span></li>
          <li><strong>W-9 Submitted:</strong> ${esc(contractor.compliance?.w9Submitted ? "Yes" : "No")}</li>
          <li><strong>OSHA Confirmed:</strong> ${esc(contractor.compliance?.oshaConfirmed ? "Yes" : "No")}</li>
        </ul>
        <div class="muted" style="margin-top:10px;">Auto-alerts are generated 30 days before expiration.</div>
      </div>
    </div>`;
  }

  if (tab === "Performance History") {
    const scores = contractor.performance?.recentProjectScores || [];
    const rows = (projects || [])
      .slice()
      .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")))
      .map((p) => {
        const parts = p.parts || {};
        return `<tr>
          <td>${esc(p.projectName)}</td>
          <td>${esc((p.completedAt || "").slice(0, 10))}</td>
          <td>${esc(parts.quality ?? "")}</td>
          <td>${esc(parts.timeliness ?? "")}</td>
          <td>${esc(parts.clientSatisfaction ?? "")}</td>
          <td><span class="badge navy">${esc(p.rating ?? 0)}</span></td>
        </tr>`;
      })
      .join("");
    return `<div class="grid">
      <div class="card" style="grid-column:span 12;">
        <h3>Performance History</h3>
        <div class="muted">Rolling average: <strong>${esc(contractor.performance?.averageScore ?? 0)}</strong></div>
        <div style="margin-top:10px;">${spark(scores.length ? scores : [0])}</div>
        <div style="margin-top:10px;overflow:auto;">
          <table class="table">
            <thead><tr><th>Project Name</th><th>Completion Date</th><th>Quality</th><th>Timeliness</th><th>Client Satisfaction</th><th>Overall</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6" class="muted">No completed projects recorded yet.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  }

  if (tab === "Project History") {
    const items = (projects || [])
      .slice()
      .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")))
      .map((p) => `<div class="notice" style="margin-top:8px;"><strong>${esc(p.projectName)}</strong><div class="muted">${esc(p.status)} · ${esc((p.completedAt || "").slice(0, 10))} · Rating: ${esc(p.rating ?? 0)}</div></div>`)
      .join("");
    return `<div class="panel"><h2>Project History</h2>${items || `<div class="muted">No project history yet.</div>`}</div>`;
  }

  if (tab === "Notes") {
    const notes = Array.isArray(contractor.notes) ? contractor.notes : [];
    return `<div class="panel">
      <h2>Internal Notes</h2>
      <form id="note-form" style="margin-top:10px;">
        <div class="field">
          <label for="note-text">Add note (internal only)</label>
          <textarea id="note-text" required></textarea>
        </div>
        <button class="submit" type="submit">Save Note</button>
      </form>
      <div style="margin-top:12px;">
        ${notes
          .map((n) => `<div class="notice" style="margin-top:8px;"><div class="muted">${esc(n.createdAt)}</div><div>${esc(n.text)}</div></div>`)
          .join("") || `<div class="muted">No notes yet.</div>`}
      </div>
    </div>`;
  }

  if (tab === "Documents") {
    const docs = Array.isArray(contractor.documents) ? contractor.documents : [];
    return `<div class="panel">
      <h2>Documents</h2>
      <div class="muted">Compliance documents submitted during application (download links require server token controls).</div>
      <ul style="margin:10px 0 0;padding-left:18px;">
        ${docs.map((d) => `<li>${esc(d.field)}: ${d.link ? `<a href="${esc(d.link)}">Download</a>` : esc(d.filename)}</li>`).join("") || `<li class="muted">No documents on file.</li>`}
      </ul>
    </div>`;
  }

  return `<div class="muted">Select a tab.</div>`;
}

async function viewContractorProfile(id) {
  setTitle("Contractor Profile", "Performance, compliance, and project governance");
  const root = qs("#admin-view");
  root.innerHTML = "";

  const data = await api(`/api/admin/contractors/${encodeURIComponent(id)}`);
  const c = data.contractor;
  const projects = data.projects || [];

  const header = document.createElement("div");
  header.className = "panel";
  header.innerHTML = `<div class="profile-header">
    <div>
      <h2 style="margin:0;">${esc(c.contractorName)}</h2>
      <div class="muted">${esc(c.tradeCategory)} · ${esc((c.regionsCovered || []).join(", "))}</div>
    </div>
    <div class="profile-meta">
      <span class="badge">${esc(c.tierLevel)}</span>
      <span class="badge navy">Score: ${esc(c.performance?.averageScore ?? 0)}</span>
      ${badgeForStatus(c.status)}
    </div>
  </div>`;
  root.appendChild(header);

  const tabs = document.createElement("div");
  tabs.className = "tabs";
  const tabNames = tabsList();
  const active = { name: "Overview" };

  const content = document.createElement("div");
  content.id = "profile-tab-content";
  content.innerHTML = renderContractorTab(c, data.alerts, projects, active.name);

  function select(tab) {
    active.name = tab;
    tabs.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"));
    content.innerHTML = renderContractorTab(c, data.alerts, projects, active.name);

    const form = qs("#note-form");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = qs("#note-text").value;
        await api(`/api/admin/contractors/${encodeURIComponent(id)}/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        window.location.hash = `#contractor:${id}`;
      });
    }
  }

  for (const name of tabNames) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab";
    b.dataset.tab = name;
    b.textContent = name;
    b.setAttribute("aria-selected", name === active.name ? "true" : "false");
    b.addEventListener("click", () => select(name));
    tabs.appendChild(b);
  }

  root.appendChild(tabs);
  root.appendChild(content);
}

async function viewPlaceholder(title, subtitle) {
  setTitle(title, subtitle);
  const root = qs("#admin-view");
  root.innerHTML = `<div class="panel"><h2>${esc(title)}</h2><div class="muted">${esc(subtitle)}</div></div>`;
}

async function viewCompliance() {
  setTitle("Compliance", "Insurance/license monitoring and verification");
  const root = qs("#admin-view");
  root.innerHTML = "";
  const data = await api("/api/admin/alerts");
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `<h2>Active Alerts</h2>
    <table class="table">
      <thead><tr><th>Contractor</th><th>Insurance</th><th>License</th><th>Performance</th><th>Offers</th></tr></thead>
      <tbody>
        ${data.alerts
          .map(
            (a) => `<tr>
              <td><a href="#contractor:${esc(a.contractorId)}">${esc(a.contractorName)}</a></td>
              <td>${a.insuranceExpiring ? `<span class="badge warn">Expiring</span>` : ""}</td>
              <td>${a.licenseExpiring ? `<span class="badge warn">Expiring</span>` : ""}</td>
              <td>${a.performanceDropping ? `<span class="badge danger">&lt; 75</span>` : ""}</td>
              <td>${a.threeDeclines ? `<span class="badge warn">3+ declines</span>` : ""}</td>
            </tr>`
          )
          .join("") || `<tr><td colspan="5" class="muted">No active alerts.</td></tr>`}
      </tbody>
    </table>`;
  root.appendChild(panel);
}

async function viewAllocation() {
  setTitle("Contract Allocation", "Weighted allocation engine (trade+region mandatory)");
  const root = qs("#admin-view");
  root.innerHTML = "";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `<h2>Create Subcontract Package</h2>
    <form id="pkg-form" style="margin-top:10px;">
      <div class="row">
        <div class="field col-6">
          <label for="pkg-name">Package Name</label>
          <input id="pkg-name" required placeholder="e.g., Commercial Fit-Out – Electrical Rough-In" />
        </div>
        <div class="field col-6">
          <label for="pkg-region">Region</label>
          <input id="pkg-region" required placeholder="e.g., Montana" />
        </div>
      </div>
      <div class="row">
        <div class="field col-6">
          <label for="pkg-trade">Trade Category</label>
          <input id="pkg-trade" required placeholder="e.g., Electrical" />
        </div>
        <div class="field col-6">
          <label for="pkg-type">Allocation Type</label>
          <select id="pkg-type">
            <option>Direct Award</option>
            <option selected>Competitive Bid</option>
            <option>Emergency Dispatch</option>
          </select>
        </div>
      </div>
      <button class="submit" type="submit">Create Package</button>
    </form>
    <div id="pkg-output" class="muted" style="margin-top:10px;"></div>
    <div id="rank-output" style="margin-top:10px;"></div>`;
  root.appendChild(panel);

  const form = qs("#pkg-form");
  const out = qs("#pkg-output");
  const rankOut = qs("#rank-output");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    out.textContent = "Creating…";
    rankOut.innerHTML = "";
    const created = await api("/api/admin/packages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: qs("#pkg-name").value,
        region: qs("#pkg-region").value,
        tradeCategory: qs("#pkg-trade").value,
        allocationType: qs("#pkg-type").value,
      }),
    });
    out.textContent = `Package created: ${created.package.id}`;

    const ranked = await api(`/api/admin/packages/${encodeURIComponent(created.package.id)}/rank`);
    const rows = ranked.ranked
      .slice(0, 10)
      .map(
        (r, i) => `<tr>
          <td>${i + 1}</td>
          <td>${esc(r.contractorName)}</td>
          <td>${esc(r.tierLevel)}</td>
          <td>${esc(Math.round(r.reliabilityIndex || r.score))}</td>
          <td>${badgeForStatus(r.status)}</td>
        </tr>`
      )
      .join("");

    rankOut.innerHTML = `<h2 style="margin-top:12px;">Ranked Contractors</h2>
      <table class="table"><thead><tr><th>#</th><th>Contractor</th><th>Tier</th><th>Master Score</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">No eligible contractors found.</td></tr>`}</tbody></table>
      <div class="hero-actions" style="margin-top:10px;">
        <button class="submit" type="button" id="send-top3">Send Offer to Top 3</button>
        <button class="submit" type="button" id="send-auto" style="background:var(--accent);color:var(--charcoal)">Auto-send to Highest Ranked</button>
      </div>`;

    qs("#send-top3").addEventListener("click", async () => {
      await api(`/api/admin/packages/${encodeURIComponent(created.package.id)}/send-offers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "top3" }) });
      alert("Offers sent.");
    });
    qs("#send-auto").addEventListener("click", async () => {
      await api(`/api/admin/packages/${encodeURIComponent(created.package.id)}/send-offers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "auto" }) });
      alert("Offer sent.");
    });
  });
}

async function viewProjects() {
  setTitle("Projects", "Completion scoring and performance updates");
  const root = qs("#admin-view");
  root.innerHTML = "";

  const contractors = (await api("/api/admin/contractors")).contractors || [];

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `<h2>Record Project Completion</h2>
    <div class="muted">Project Manager inputs quality/timeliness/etc. The system calculates project rating and updates rolling averages automatically.</div>
    <form id="project-form" style="margin-top:10px;">
      <div class="row">
        <div class="field col-6">
          <label for="prj-contractor">Contractor</label>
          <select id="prj-contractor" required>
            <option value="">Select…</option>
            ${contractors.map((c) => `<option value="${esc(c.id)}">${esc(c.contractorName)} (${esc(c.tradeCategory)})</option>`).join("")}
          </select>
        </div>
        <div class="field col-6">
          <label for="prj-name">Project Name</label>
          <input id="prj-name" required placeholder="e.g., Site Package – Rough-In" />
        </div>
      </div>
      <div class="row">
        <div class="field col-6"><label>Quality (0–30)</label><input id="s-quality" type="number" min="0" max="30" value="24" required /></div>
        <div class="field col-6"><label>Timeliness (0–20)</label><input id="s-time" type="number" min="0" max="20" value="16" required /></div>
      </div>
      <div class="row">
        <div class="field col-6"><label>Communication (0–15)</label><input id="s-comm" type="number" min="0" max="15" value="12" required /></div>
        <div class="field col-6"><label>Compliance (0–15)</label><input id="s-comp" type="number" min="0" max="15" value="12" required /></div>
      </div>
      <div class="row">
        <div class="field col-6"><label>Client Satisfaction (0–20)</label><input id="s-client" type="number" min="0" max="20" value="16" required /></div>
        <div class="field col-6"><label>&nbsp;</label><button class="submit" type="submit">Submit Completion</button></div>
      </div>
    </form>
    <div id="project-out" class="muted" style="margin-top:10px;"></div>`;
  root.appendChild(panel);

  qs("#project-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    qs("#project-out").textContent = "Submitting…";
    const payload = {
      contractorId: qs("#prj-contractor").value,
      projectName: qs("#prj-name").value,
      quality: Number(qs("#s-quality").value),
      timeliness: Number(qs("#s-time").value),
      communication: Number(qs("#s-comm").value),
      compliance: Number(qs("#s-comp").value),
      clientSatisfaction: Number(qs("#s-client").value),
    };
    const saved = await api("/api/admin/projects/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    qs("#project-out").textContent = `Project rating: ${saved.rating.total}. Updated rolling average: ${saved.contractor.performance.averageScore}. Status: ${saved.contractor.status}.`;
  });

  const history = await api("/api/admin/projects");
  const listPanel = document.createElement("div");
  listPanel.className = "panel";
  listPanel.innerHTML = `<h2>Recent Completed Projects</h2>
    <table class="table">
      <thead><tr><th>Project</th><th>Contractor</th><th>Date</th><th>Rating</th></tr></thead>
      <tbody>
        ${(history.projects || [])
          .slice()
          .reverse()
          .slice(0, 15)
          .map((p) => {
            const ctr = contractors.find((c) => c.id === p.contractorId);
            return `<tr><td>${esc(p.projectName)}</td><td>${ctr ? `<a href="#contractor:${esc(ctr.id)}">${esc(ctr.contractorName)}</a>` : ""}</td><td>${esc((p.completedAt || "").slice(0, 10))}</td><td><span class="badge navy">${esc(p.rating ?? 0)}</span></td></tr>`;
          })
          .join("") || `<tr><td colspan="4" class="muted">No completions recorded.</td></tr>`}
      </tbody>
    </table>`;
  root.appendChild(listPanel);
}

async function viewScoring() {
  setTitle("Scoring & Ratings", "Approval scoring, performance scoring, and tier rules");
  const root = qs("#admin-view");
  root.innerHTML = `<div class="panel">
    <h2>Approval Score Logic (100 points)</h2>
    <ul>
      <li>Compliance Score (25%)</li>
      <li>Experience Score (25%)</li>
      <li>Capacity Score (20%)</li>
      <li>Professionalism Score (15%)</li>
      <li>Financial Stability (15%)</li>
    </ul>
    <div class="muted" style="margin-top:10px;">Auto-tier assignment: ≥85 Tier 1 · 70–84 Tier 2 · 60–69 Conditional · &lt;60 Reject</div>
  </div>
  <div class="panel">
    <h2>Performance Score Logic (Per Project)</h2>
    <ul>
      <li>Quality (0–30)</li>
      <li>Timeliness (0–20)</li>
      <li>Communication (0–15)</li>
      <li>Compliance (0–15)</li>
      <li>Client Satisfaction (0–20)</li>
    </ul>
    <div class="muted" style="margin-top:10px;">Rolling average is updated automatically after each completion record.</div>
    <div class="muted" style="margin-top:10px;">Performance tier rules: ≥90 Priority · 80–89 Standard · 70–79 Limited · &lt;70 Flag for Review</div>
  </div>`;
}

async function viewProbation() {
  setTitle("Probation", "Automatic triggers and performance reviews");
  const root = qs("#admin-view");
  root.innerHTML = "";
  const data = await api("/api/admin/contractors");
  const list = (data.contractors || []).filter((c) => String(c.status || "").startsWith("Probation") || String(c.status || "").startsWith("Suspended"));
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `<h2>Probation / Suspended Contractors</h2>
    <div class="muted">Triggers include: 2 consecutive projects &lt;75, compliance expiry, safety violation, verified complaint, or 3 no-response offers.</div>
    <table class="table" style="margin-top:10px;">
      <thead><tr><th>Contractor</th><th>Trade</th><th>Tier</th><th>Avg Score</th><th>Status</th></tr></thead>
      <tbody>
        ${list
          .map(
            (c) => `<tr>
              <td><a href="#contractor:${esc(c.id)}">${esc(c.contractorName)}</a></td>
              <td>${esc(c.tradeCategory)}</td>
              <td>${esc(c.tierLevel)}</td>
              <td>${esc(c.performance?.averageScore ?? 0)}</td>
              <td>${badgeForStatus(c.status)}</td>
            </tr>`
          )
          .join("") || `<tr><td colspan="5" class="muted">No contractors currently on probation/suspended.</td></tr>`}
      </tbody>
    </table>`;
  root.appendChild(panel);
}

async function viewReports() {
  setTitle("Reports", "Operational reporting module");
  const root = qs("#admin-view");
  root.innerHTML = `<div class="panel">
    <h2>Generate Reports</h2>
    <div class="hero-actions" style="margin-top:10px;">
      <button class="submit" id="r-compliance" type="button">Compliance Expiration Report</button>
      <button class="submit" id="r-regions" type="button">Regional Coverage Report</button>
    </div>
    <pre id="report-out" class="notice" style="margin-top:12px;white-space:pre-wrap;overflow:auto;"></pre>
  </div>`;
  const out = qs("#report-out");
  out.textContent = "Select a report.";
  qs("#r-compliance").addEventListener("click", async () => {
    const r = await api("/api/admin/reports/compliance-expiration");
    out.textContent = JSON.stringify(r.report, null, 2);
  });
  qs("#r-regions").addEventListener("click", async () => {
    const r = await api("/api/admin/reports/regional-coverage");
    out.textContent = JSON.stringify(r.report, null, 2);
  });
}

async function router() {
  const hash = window.location.hash || "#dashboard";
  setNavActive(hash.startsWith("#contractor:") ? "#contractors" : hash);

  if (!token()) {
    setTitle("Unauthorized", "Missing admin token");
    qs("#admin-view").innerHTML = `<div class="panel"><h2>Admin token required</h2><div class="muted">Open /admin/index.html?t=YOUR_ADMIN_TOKEN</div></div>`;
    return;
  }

  if (hash === "#dashboard") return viewDashboard();
  if (hash === "#contractors") return viewContractors();
  if (hash.startsWith("#contractor:")) return viewContractorProfile(hash.split(":")[1]);
  if (hash === "#projects") return viewProjects();
  if (hash === "#compliance") return viewCompliance();
  if (hash === "#scoring") return viewScoring();
  if (hash === "#probation") return viewProbation();
  if (hash === "#allocation") return viewAllocation();
  if (hash === "#reports") return viewReports();
  if (hash === "#settings") return viewPlaceholder("Settings", "System controls and overrides");
  return viewDashboard();
}

window.addEventListener("hashchange", router);
router().catch((err) => {
  qs("#admin-view").innerHTML = `<div class="panel"><h2>Error</h2><div class="muted">${esc(err.message || err)}</div></div>`;
});

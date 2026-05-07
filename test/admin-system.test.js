const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fsp = require("node:fs/promises");

process.env.ADMIN_TOKEN = "test-admin-token";

const { createApp } = require("../server");

async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function adminHeaders() {
  return { "x-admin-token": process.env.ADMIN_TOKEN, "Content-Type": "application/json" };
}

test("admin approval scoring assigns tier and stores contractor", async () => {
  await fsp.rm(path.join(__dirname, "..", "data", "admin-db.json"), { force: true });
  const { server, baseUrl } = await startServer();
  try {
    const application = {
      applicantName: "Jane Foreman",
      companyName: "JF Electrical LLC",
      tradeCategory: "Electrical",
      yearsOfExperience: 12,
      regionsCovered: "Montana",
      workforceSize: "11–20",
      workAuthorization: "Yes",
      stateLicense: "Licensed",
      oshaCompliance: "Yes",
      w9Status: "Provided",
      coiStatus: "Provided",
    };

    const resp = await fetch(`${baseUrl}/api/admin/contractors/from-application`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(application),
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.equal(data.contractor.tierLevel, "Tier 1");
    assert.equal(data.contractor.status, "Active");
    assert.ok(data.contractor.approvalScore >= 85);
  } finally {
    server.close();
  }
});

test("probation triggers after two consecutive low project ratings", async () => {
  await fsp.rm(path.join(__dirname, "..", "data", "admin-db.json"), { force: true });
  const { server, baseUrl } = await startServer();
  try {
    const create = await fetch(`${baseUrl}/api/admin/contractors/from-application`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        applicantName: "Low Performer",
        companyName: "LP Co",
        tradeCategory: "Electrical",
        yearsOfExperience: 6,
        regionsCovered: "Montana",
        workforceSize: "2–5",
        workAuthorization: "Yes",
        stateLicense: "Licensed",
        oshaCompliance: "Yes",
        w9Status: "Provided",
        coiStatus: "Provided",
      }),
    });
    const created = await create.json();
    const id = created.contractor.id;

    const low = { contractorId: id, projectName: "Test A", quality: 18, timeliness: 12, communication: 8, compliance: 10, clientSatisfaction: 12 };
    const low2 = { contractorId: id, projectName: "Test B", quality: 18, timeliness: 12, communication: 8, compliance: 10, clientSatisfaction: 12 };

    await fetch(`${baseUrl}/api/admin/projects/complete`, { method: "POST", headers: adminHeaders(), body: JSON.stringify(low) });
    const second = await fetch(`${baseUrl}/api/admin/projects/complete`, { method: "POST", headers: adminHeaders(), body: JSON.stringify(low2) });
    const secondData = await second.json();
    assert.equal(secondData.ok, true);
    assert.ok(String(secondData.contractor.status).startsWith("Probation"));
  } finally {
    server.close();
  }
});

test("allocation ranking prefers higher performance/tier and direct award restricts to Tier 1", async () => {
  await fsp.rm(path.join(__dirname, "..", "data", "admin-db.json"), { force: true });
  const { server, baseUrl } = await startServer();
  try {
    async function makeContractor(name, years) {
      const resp = await fetch(`${baseUrl}/api/admin/contractors/from-application`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          applicantName: name,
          companyName: `${name} Co`,
          tradeCategory: "Electrical",
          yearsOfExperience: years,
          regionsCovered: "Montana",
          workforceSize: "11–20",
          workAuthorization: "Yes",
          stateLicense: "Licensed",
          oshaCompliance: "Yes",
          w9Status: "Provided",
          coiStatus: "Provided",
          insuranceExpiryDate: "2099-01-01",
        }),
      });
      const data = await resp.json();
      return data.contractor.id;
    }

    const a = await makeContractor("Alpha", 12);
    const b = await makeContractor("Beta", 4);

    await fetch(`${baseUrl}/api/admin/projects/complete`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ contractorId: a, projectName: "High", quality: 30, timeliness: 20, communication: 15, compliance: 15, clientSatisfaction: 20 }) });
    await fetch(`${baseUrl}/api/admin/projects/complete`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ contractorId: b, projectName: "Mid", quality: 22, timeliness: 15, communication: 10, compliance: 12, clientSatisfaction: 15 }) });

    const pkgResp = await fetch(`${baseUrl}/api/admin/packages`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name: "Pkg 1", tradeCategory: "Electrical", region: "Montana", allocationType: "Competitive Bid" }) });
    const pkg = (await pkgResp.json()).package;

    const rankResp = await fetch(`${baseUrl}/api/admin/packages/${encodeURIComponent(pkg.id)}/rank`, { headers: { "x-admin-token": process.env.ADMIN_TOKEN } });
    const rank = await rankResp.json();
    assert.equal(rank.ok, true);
    assert.equal(rank.ranked[0].contractorId, a);

    const directPkgResp = await fetch(`${baseUrl}/api/admin/packages`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ name: "Pkg Direct", tradeCategory: "Electrical", region: "Montana", allocationType: "Direct Award" }) });
    const directPkg = (await directPkgResp.json()).package;

    const sendResp = await fetch(`${baseUrl}/api/admin/packages/${encodeURIComponent(directPkg.id)}/send-offers`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ mode: "top3" }) });
    const sent = await sendResp.json();
    assert.equal(sent.ok, true);
    assert.ok(sent.offers.length >= 1);

    const contractorsResp = await fetch(`${baseUrl}/api/admin/contractors`, { headers: { "x-admin-token": process.env.ADMIN_TOKEN } });
    const contractors = await contractorsResp.json();
    const byId = new Map(contractors.contractors.map((c) => [c.id, c]));
    for (const offer of sent.offers) {
      assert.equal(byId.get(offer.contractorId).tierLevel, "Tier 1");
    }
  } finally {
    server.close();
  }
});


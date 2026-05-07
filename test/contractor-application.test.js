const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../server");

async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

test("contractor application requires fields", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const resp = await fetch(`${baseUrl}/api/contractor-application`, { method: "POST" });
    assert.equal(resp.status, 400);
  } finally {
    server.close();
  }
});

test("contractor application accepts valid submission with insurance upload", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const fd = new FormData();
    fd.set("applicantName", "Test Applicant");
    fd.set("companyName", "Test Co Ltd");
    fd.set("email", "test@example.com");
    fd.set("phoneNumber", "+447000000000");
    fd.set("tradeCategory", "Electrical & Technical");
    fd.set("yearsOfExperience", "7");
    fd.set("regionsCovered", "London");
    fd.set("workforceSize", "2–5");
    fd.set("emergencyAvailability", "Yes");
    fd.set("stateLicense", "Not Required");
    fd.set("oshaCompliance", "Yes");
    fd.set("workAuthorization", "Yes");

    const coiFile = new File([new Blob(["pdf-bytes"])], "coi.pdf", { type: "application/pdf" });
    const w9File = new File([new Blob(["pdf-bytes"])], "w9.pdf", { type: "application/pdf" });
    fd.set("certificateOfInsurance", coiFile);
    fd.set("w9Form", w9File);

    const resp = await fetch(`${baseUrl}/api/contractor-application`, { method: "POST", body: fd });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.ok, true);
    assert.ok(data.applicationId);
  } finally {
    server.close();
  }
});

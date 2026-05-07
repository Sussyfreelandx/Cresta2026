const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createApp } = require("../server");

async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

test("email subscribe rejects when required fields are missing", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const fd = new FormData();
    fd.set("companyName", "");
    fd.set("contactName", "");
    fd.set("email", "");
    fd.set("consent", "yes");
    const resp = await fetch(`${baseUrl}/api/email-subscribe`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: fd,
    });
    assert.equal(resp.status, 400);
    const json = await resp.json();
    assert.equal(json.ok, false);
  } finally {
    server.close();
  }
});

test("email subscribe rejects when consent is not given", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const fd = new FormData();
    fd.set("companyName", "Acme Trades LLC");
    fd.set("contactName", "Jane Doe");
    fd.set("email", "jane@acmetrades.example");
    const resp = await fetch(`${baseUrl}/api/email-subscribe`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: fd,
    });
    assert.equal(resp.status, 400);
    const json = await resp.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /consent/i);
  } finally {
    server.close();
  }
});

test("email subscribe rejects invalid email format", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const fd = new FormData();
    fd.set("companyName", "Acme Trades LLC");
    fd.set("contactName", "Jane Doe");
    fd.set("email", "not-an-email");
    fd.set("consent", "yes");
    const resp = await fetch(`${baseUrl}/api/email-subscribe`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: fd,
    });
    assert.equal(resp.status, 400);
  } finally {
    server.close();
  }
});

test("email subscribe silently rejects honeypot submissions", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const fd = new FormData();
    fd.set("companyName", "Acme Trades LLC");
    fd.set("contactName", "Jane Doe");
    fd.set("email", "jane@acmetrades.example");
    fd.set("consent", "yes");
    fd.set("website", "http://spam.example"); // honeypot tripped
    const resp = await fetch(`${baseUrl}/api/email-subscribe`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: fd,
    });
    assert.equal(resp.status, 400);
  } finally {
    server.close();
  }
});

test("email subscribe accepts a valid opt-in and writes an audit record", async () => {
  const { server, baseUrl } = await startServer();
  const logPath = path.join(__dirname, "..", "data", "email-subscribers.jsonl");
  const sizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  try {
    const fd = new FormData();
    fd.set("companyName", "Acme Trades LLC");
    fd.set("contactName", "Jane Doe");
    fd.set("email", "Jane@Acmetrades.Example");
    fd.set("role", "Operations Manager");
    fd.set("tradeCategory", "Electrical");
    fd.set("region", "Montana");
    fd.set("consent", "yes");
    const resp = await fetch(`${baseUrl}/api/email-subscribe`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: fd,
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.ok, true);
    assert.ok(json.subscriptionId);

    assert.ok(fs.existsSync(logPath), "subscriber log file must exist");
    const sizeAfter = fs.statSync(logPath).size;
    assert.ok(sizeAfter > sizeBefore, "log must have grown after a subscription");

    // Inspect the last line we just wrote.
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.email, "jane@acmetrades.example", "email must be lowercased");
    assert.equal(last.companyName, "Acme Trades LLC");
    assert.equal(last.consent, true);
    assert.equal(last.sourceUrl, "/email-subscribe.html");
    assert.ok(last.timestamp);
    assert.ok(last.subscriptionId);
    assert.ok(last.consentText && last.consentText.length > 0, "consent text must be recorded");
  } finally {
    server.close();
  }
});

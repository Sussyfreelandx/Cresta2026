const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("public pages use production email and local images", () => {
  const files = walk(PUBLIC).filter((f) => f.endsWith(".html") || f.endsWith(".css") || f.endsWith(".js"));
  assert.ok(files.length > 0);

  const allText = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  assert.ok(allText.includes("info@cresteraconstructionauthority.com"));
  assert.ok(!allText.includes("crestara.example"));
  assert.ok(!allText.includes("/assets/assets/"));

  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");

    for (const match of html.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
      const src = match[1];
      if (/^https?:\/\//i.test(src) || src.startsWith("data:")) continue;
      const localPath = path.join(PUBLIC, src.replace(/^\//, ""));
      assert.ok(fs.existsSync(localPath), `Missing image referenced by ${path.relative(PUBLIC, file)}: ${src}`);
    }

    for (const match of html.matchAll(/data-online-src="([^"]+)"/gi)) {
      const src = match[1];
      assert.ok(/^https:\/\//i.test(src), `Online image must be https in ${path.relative(PUBLIC, file)}: ${src}`);
    }

    for (const match of html.matchAll(/--hero-image:url\(['"]?([^'")]+)['"]?\)/gi)) {
      const url = match[1];
      if (/^https?:\/\//i.test(url) || url.startsWith("data:")) continue;
      const absolutePath = path.join(PUBLIC, url.replace(/^\//, ""));
      const relativeToAssetsPath = path.join(PUBLIC, "assets", url.replace(/^\//, ""));
      assert.ok(
        fs.existsSync(absolutePath) || fs.existsSync(relativeToAssetsPath),
        `Missing hero image referenced by ${path.relative(PUBLIC, file)}: ${url}`
      );
    }
  }
});

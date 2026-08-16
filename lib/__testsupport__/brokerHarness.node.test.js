// Guards the fixture app directory that every server-backed suite boots from.
//
// Why this file exists: when the harness fails to stage a directory that
// server.js needs, the backend dies with MODULE_NOT_FOUND, waitReady() times
// out, and the affected suites report SKIPPED rather than FAILED. A skip reads
// like "not applicable here" and hides a genuine regression. This suite turns
// that silent skip into a hard failure, and it deliberately needs no
// node_modules so it runs even on a machine where the backend cannot boot.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { REPO_ROOT, buildApp } = require("./brokerHarness");

// Every relative require in server.js, as written in the source.
function serverRelativeRequires() {
  const src = fs.readFileSync(path.join(REPO_ROOT, "server.js"), "utf-8");
  const found = new Set();
  const re = /require\(\s*["'](\.[^"']*)["']\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) found.add(m[1]);
  return [...found].sort();
}

test("the fixture app dir resolves every relative require in server.js", () => {
  const specs = serverRelativeRequires();
  assert.ok(specs.length > 0, "found no relative requires in server.js - regex broken?");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-layout-"));
  try {
    const { appDir } = buildApp(tmpRoot);
    const missing = [];
    for (const spec of specs) {
      try {
        require.resolve(path.resolve(appDir, spec));
      } catch {
        missing.push(spec);
      }
    }
    assert.deepStrictEqual(
      missing, [],
      "server.js requires these paths but the harness did not stage them into "
      + "the fixture app dir. Add the missing top-level directory to the link "
      + "list in buildApp(). Unresolved: " + missing.join(", "),
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("the fixture app dir stages every top-level dir server.js reaches into", () => {
  const roots = new Set(
    serverRelativeRequires()
      .map((s) => s.replace(/^\.\//, "").split("/")[0])
      .filter((seg) => seg && seg !== ".." && !seg.endsWith(".js")),
  );

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-roots-"));
  try {
    const { appDir } = buildApp(tmpRoot);
    for (const r of roots) {
      assert.ok(
        fs.existsSync(path.join(appDir, r)),
        `server.js reaches into "${r}/" but the fixture app dir has no such entry`,
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

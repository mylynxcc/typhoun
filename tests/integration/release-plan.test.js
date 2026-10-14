/**
 * Release planner tests.
 *
 * The planner decides what a merge to `main` will publish, so its mistakes are
 * public: a wrong version tags the wrong release, and a badly sliced body makes
 * the notes wrong on the repository front page. It is therefore tested like
 * production code rather than trusted because it "just parses markdown".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isReleasableVersion,
  latestRelease,
  parseChangelog,
  publishRelease,
  releaseNotes,
} from "../../tools/release/plan-release.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const planner = join(root, "tools", "release", "plan-release.js");

function scratch(changelog) {
  const dir = mkdtempSync(join(tmpdir(), "typhoun-release-"));
  const path = join(dir, "CHANGELOG.md");
  writeFileSync(path, changelog, "utf8");
  return { dir, path };
}

/** Run the planner, keeping stderr out of the test output. */
function plan(args) {
  const stdout = execFileSync(process.execPath, [planner, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const outputs = {};
  for (const line of stdout.trim().split("\n")) {
    const eq = line.indexOf("=");
    outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return outputs;
}

/**
 * Run the planner without throwing, keeping stdout and stderr apart — the
 * publish path reports on both, and the split is part of its contract.
 */
function run(args, env) {
  // `spawnSync`, not `execFileSync`: the publish path reports the plan on stderr
  // and still exits 0, and execFileSync only hands stderr over when it throws.
  const result = spawnSync(process.execPath, [planner, ...args], {
    encoding: "utf8",
    env: env ?? process.env,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * A transport that answers from a script and records what it was asked, so the
 * publish logic can be tested against 404s, 200s and failures without a
 * repository — the interesting behaviour is "check, then create only what is
 * missing", not the HTTP call itself.
 */
function scriptedTransport(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async send(method, path, body) {
      calls.push({ method, path, body });
      const response = responses[index++];
      if (!response) throw new Error(`unexpected request ${method} ${path}`);
      return response;
    },
  };
}

describe("release planner: parsing", () => {
  it("reads the real CHANGELOG and finds the shipped version", () => {
    const entries = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
    const latest = latestRelease(entries);
    assert.ok(latest, "the project has a released version");
    assert.equal(latest.version, "0.1.0");
    assert.equal(latest.date, "2026-10-14");
  });

  it("takes the section body as the notes, heading excluded", () => {
    const entries = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
    const notes = releaseNotes(latestRelease(entries));
    assert.equal(notes.startsWith("## ["), false, "the heading must not be part of the notes");
    assert.ok(notes.includes("### Known limitations"), "subsections belong to the body");
    assert.ok(notes.length > 1000, `expected a substantial body, got ${notes.length} characters`);
  });

  it("skips the Unreleased section", () => {
    const entries = parseChangelog("# Changelog\n\n## [Unreleased]\n\nWork in progress.\n");
    assert.equal(latestRelease(entries), null, "unreleased work is not a release");
  });

  it("picks the newest released section, which is the first one written", () => {
    const entries = parseChangelog(
      "# Changelog\n\n## [Unreleased]\n\n---\n\n## [0.3.0] — 2026-12-01\n\nThird.\n\n## [0.2.0] — 2026-11-01\n\nSecond.\n",
    );
    assert.equal(latestRelease(entries).version, "0.3.0");
    assert.equal(entries.length, 3);
  });

  it("does not start a section at a ### subsection heading", () => {
    const entries = parseChangelog("## [1.2.3] — 2026-01-01\n\n### Added\n\n* a thing\n");
    assert.equal(entries.length, 1);
    assert.ok(entries[0].body.includes("### Added"));
  });

  it("strips the separator that ends a section which is not the last one", () => {
    // Regression: the document's own `---` sits between two sections, and would
    // otherwise land at the bottom of the release notes as a stray rule.
    const entries = parseChangelog(
      "## [0.2.0] — 2026-11-01\n\nSecond release.\n\n### Added\n\n* Something new.\n\n---\n\n## [0.1.0] — 2026-10-14\n\nFirst.\n",
    );
    const notes = releaseNotes(entries[0]);
    assert.equal(notes.endsWith("---"), false, `notes ended with a separator: ${JSON.stringify(notes)}`);
    assert.equal(notes, "Second release.\n\n### Added\n\n* Something new.");
  });
});

describe("release planner: version guard", () => {
  it("accepts release versions and rejects anything else", () => {
    for (const ok of ["0.2.0", "1.0.0", "2.1.3-rc.1", "1.0.0+build.7"]) {
      assert.equal(isReleasableVersion(ok), true, `${ok} should be taggable`);
    }
    for (const bad of ["Unreleased", "v1.0.0", "1.0", "latest", "", "1.0.0 beta"]) {
      assert.equal(isReleasableVersion(bad), false, `${bad} should not be taggable`);
    }
  });

  it("refuses to tag a heading that is not a version, rather than tagging nonsense", () => {
    const { path } = scratch("# Changelog\n\n## [Shipping soon] — 2026-11-01\n\nText.\n");
    const outputs = plan(["--changelog", path, "--tagged", ""]);
    assert.equal(outputs.releasable, "false");
    assert.equal(outputs.tag, "");
  });
});

describe("release planner: the command line", () => {
  it("reports an untagged version as releasable and writes its notes", () => {
    const { dir, path } = scratch(
      "# Changelog\n\n## [Unreleased]\n\nNothing yet.\n\n---\n\n## [0.2.0] — 2026-11-01\n\nSecond release.\n\n### Added\n\n* Something new.\n",
    );
    const notesOut = join(dir, "notes.md");
    const outputs = plan(["--changelog", path, "--tagged", "v0.1.0", "--notes-out", notesOut]);
    assert.equal(outputs.releasable, "true");
    assert.equal(outputs.version, "0.2.0");
    assert.equal(outputs.tag, "v0.2.0");
    assert.equal(readFileSync(notesOut, "utf8").trim(), "Second release.\n\n### Added\n\n* Something new.");
  });

  it("reports an already-tagged version as not releasable", () => {
    const { path } = scratch("# Changelog\n\n## [0.2.0] — 2026-11-01\n\nAlready out.\n");
    const outputs = plan(["--changelog", path, "--tagged", "v0.1.0,v0.2.0"]);
    assert.equal(outputs.releasable, "false");
    assert.equal(outputs.tag, "v0.2.0", "the tag is still named, so the summary can show it");
  });

  it("treats a CHANGELOG with no release as nothing to do", () => {
    const { path } = scratch("# Changelog\n\n## [Unreleased]\n\nWork in progress.\n");
    const outputs = plan(["--changelog", path, "--tagged", ""]);
    assert.equal(outputs.releasable, "false");
    assert.equal(outputs.version, "");
  });

  it("emits only key=value lines on stdout, so $GITHUB_OUTPUT is safe to append to", () => {
    const { path } = scratch("# Changelog\n\n## [0.2.0] — 2026-11-01\n\nSecond.\n");
    const stdout = execFileSync(process.execPath, [planner, "--changelog", path, "--tagged", ""], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of stdout.trim().split("\n")) {
      assert.match(line, /^[a-z_]+=.*$/, `not a GITHUB_OUTPUT line: ${JSON.stringify(line)}`);
    }
  });
});
describe("release planner: what a publish would do", () => {
  const NOTES = "Second release.\n\n### Added\n\n* Something new.";
  const SHA = "0221268bd161bf3ce7076448b2cf59cb290ccc9c";
  const REPO = "mylynxcc/typhoun";
  const base = { tag: "v0.2.0", repo: REPO, sha: SHA, notes: NOTES, event: () => {} };

  it("creates the tag, then the release, with the notes as the body", async () => {
    const transport = scriptedTransport([
      { status: 404, payload: {} },
      { status: 404, payload: {} },
      { status: 201, payload: {} },
      { status: 201, payload: { html_url: "https://example.test/release" } },
    ]);
    const report = await publishRelease({ ...base, send: transport.send });

    assert.deepEqual(
      transport.calls.map((call) => `${call.method} ${call.path}`),
      [
        `GET /repos/${REPO}/releases/tags/v0.2.0`,
        `GET /repos/${REPO}/git/ref/refs/tags/v0.2.0`,
        `POST /repos/${REPO}/git/refs`,
        `POST /repos/${REPO}/releases`,
      ],
      "the tag has to exist before the release points at it",
    );
    assert.deepEqual(transport.calls[2].body, { ref: "refs/tags/v0.2.0", sha: SHA });
    assert.deepEqual(transport.calls[3].body, {
      tag_name: "v0.2.0",
      name: "Typhoun v0.2.0",
      body: NOTES,
      draft: false,
      prerelease: false,
    });
    assert.equal(report.releaseCreated, true);
    assert.equal(report.releaseUrl, "https://example.test/release");
  });

  it("reuses a tag that already exists instead of moving it", async () => {
    const transport = scriptedTransport([
      { status: 404, payload: {} },
      { status: 200, payload: {} },
      { status: 201, payload: { html_url: "https://example.test/release" } },
    ]);
    await publishRelease({ ...base, send: transport.send });

    assert.equal(
      transport.calls.some((call) => call.method === "POST" && call.path.endsWith("/git/refs")),
      false,
      "a tag that exists is never rewritten",
    );
    assert.equal(transport.calls.length, 3);
  });

  it("leaves an existing release completely alone", async () => {
    const transport = scriptedTransport([
      { status: 200, payload: { html_url: "https://example.test/existing" } },
    ]);
    const report = await publishRelease({ ...base, send: transport.send });

    assert.equal(transport.calls.length, 1, "only the lookup, no writes");
    assert.equal(report.releaseCreated, false);
    assert.equal(report.releaseUrl, "https://example.test/existing");
  });

  it("fails loudly when the API refuses to create the tag", async () => {
    const transport = scriptedTransport([
      { status: 404, payload: {} },
      { status: 404, payload: {} },
      { status: 422, payload: { message: "Reference already exists" } },
    ]);
    await assert.rejects(
      () => publishRelease({ ...base, send: transport.send }),
      /cannot create refs\/tags\/v0\.2\.0: HTTP 422 Reference already exists/,
    );
  });

  it("does not mistake a broken lookup for an absent release", async () => {
    const transport = scriptedTransport([{ status: 403, payload: {} }]);
    await assert.rejects(
      () => publishRelease({ ...base, send: transport.send }),
      /cannot check for an existing release: HTTP 403/,
    );
    assert.equal(transport.calls.length, 1, "a failed check must not be read as 'nothing there'");
  });
});

describe("release planner: dry run", () => {
  const CHANGELOG = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "Nothing yet.",
    "",
    "---",
    "",
    "## [0.2.0] — 2026-11-01",
    "",
    "Second release.",
    "",
    "### Added",
    "",
    "* Something new.",
    "",
  ].join("\n");
  const SHA = "0221268bd161bf3ce7076448b2cf59cb290ccc9c";

  function dryRun(extra = []) {
    const { dir, path } = scratch(CHANGELOG);
    const notesOut = join(dir, "notes.md");
    return {
      notesOut,
      dir,
      result: run(
        [
          "--changelog",
          path,
          "--tagged",
          "v0.1.0",
          "--notes-out",
          notesOut,
          "--repo",
          "mylynxcc/typhoun",
          "--sha",
          SHA,
          "--publish",
          "--dry-run",
          ...extra,
        ],
        // No credentials at all: a dry run must be usable wherever it is safe to
        // read the CHANGELOG, which is what lets CI exercise it on every push.
        { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
      ),
    };
  }

  it("walks the tagging and notes path without sending anything", () => {
    const { result, notesOut } = dryRun();
    assert.equal(result.status, 0, result.stderr);

    const outputs = {};
    for (const line of result.stdout.trim().split("\n")) {
      const eq = line.indexOf("=");
      outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
    assert.equal(outputs.releasable, "true");
    assert.equal(outputs.tag, "v0.2.0");
    assert.equal(outputs.dry_run, "true");
    assert.equal(outputs.published, "false", "a dry run never claims to have published");
    assert.equal(outputs.planned_requests, "4");

    assert.match(result.stderr, /POST \/repos\/mylynxcc\/typhoun\/git\/refs\n/);
    assert.match(result.stderr, /"ref": "refs\/tags\/v0\.2\.0"/);
    assert.match(result.stderr, /POST \/repos\/mylynxcc\/typhoun\/releases\n/);

    // The payload is built from the same notes that were written out, so the
    // body a real run would publish is exactly this CHANGELOG section.
    const notes = readFileSync(notesOut, "utf8").trim();
    assert.equal(notes, "Second release.\n\n### Added\n\n* Something new.");
    assert.match(result.stderr, new RegExp(`"body": ${notes.length} characters of notes`));

    // Nothing was sent. That this succeeded at all with both credentials emptied
    // is the evidence: the live transport refuses to run without a token, so no
    // live transport was reached.
  });

  it("stops at the idempotency check when the derived tag already exists", () => {
    const { result } = dryRun(["--tagged", "v0.1.0,v0.2.0"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^releasable=false$/m);
    assert.equal(result.stdout.includes("dry_run="), false, "there is no publish to describe");
    assert.match(result.stderr, /not touching it/);
  });

  it("rejects the flag on its own, because a dry run describes a publish", () => {
    const { path } = scratch(CHANGELOG);
    const result = run(["--changelog", path, "--dry-run"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--dry-run describes a publish; pass --publish as well/);
  });
});

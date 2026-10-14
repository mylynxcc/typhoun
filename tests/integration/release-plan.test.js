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
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isReleasableVersion,
  latestRelease,
  parseChangelog,
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

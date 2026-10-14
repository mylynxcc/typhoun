#!/usr/bin/env node
/**
 * Typhoun release planner.
 *
 * Usage:
 *   node tools/release/plan-release.js [--changelog PATH] [--notes-out PATH]
 *                                      [--tagged a,b,c] [--publish]
 *                                      [--repo OWNER/NAME] [--sha COMMIT]
 *
 * The CHANGELOG is the source of truth for this project in two ways: it says
 * *which* version is next — the first section after `Unreleased` — and its body
 * becomes the release notes verbatim. So a release is cut by editing the
 * CHANGELOG (`## [Unreleased]` becomes `## [x.y.z] — <date>`) and merging to
 * main, never by running a command with a version argument that could disagree
 * with what the notes claim.
 *
 * The run is idempotent. If the derived tag already exists, `releasable` is
 * false and nothing happens; with `--publish` an existing tag or release is
 * reported rather than overwritten. That is what makes it safe to run on every
 * push to main.
 *
 * Contract for the caller: `stdout` carries only `key=value` lines suitable for
 * appending to `$GITHUB_OUTPUT`; everything meant for a human goes to `stderr`.
 * Redirecting stdout into a file therefore cannot corrupt it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The heading that names work that is not released yet. */
const UNRELEASED = "unreleased";

/** A heading this tool is willing to turn into a tag. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$/;

/**
 * Split a CHANGELOG into its `## [version]` sections, in file order.
 *
 * Only level-two headings with a bracketed version start a section, so the
 * `### Added` / `### Fixed` subsections inside one stay part of its body. A
 * section runs until the next such heading or the end of the file.
 *
 * @param {string} text
 * @returns {{version: string, date: string, heading: string, body: string}[]}
 */
export function parseChangelog(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^##\s*\[([^\]]+)\]\s*(?:[—–-]\s*(.*?))?\s*$/.exec(line);
    if (match) {
      current = {
        version: match[1].trim(),
        date: (match[2] ?? "").trim(),
        heading: line,
        body: [],
      };
      entries.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return entries.map((entry) => ({ ...entry, body: trimTrailingRules(entry.body.join("\n")) }));
}

/**
 * Drop the blank lines and horizontal rules that separate one section from the
 * next. A section that is not last would otherwise carry the document's own
 * `---` separator into its release notes, where it renders as a stray rule.
 */
function trimTrailingRules(body) {
  const lines = body.split("\n");
  for (;;) {
    const last = lines[lines.length - 1];
    if (last !== undefined && /^\s*(?:-{3,}|\*{3,}|_{3,})?\s*$/.test(last)) lines.pop();
    else break;
  }
  return lines.join("\n").trim();
}

/**
 * The newest section that actually names a release, or null.
 *
 * The CHANGELOG is written newest-first, so this is simply the first section
 * that is not `Unreleased`. Returning null — rather than guessing a version —
 * is what makes "nothing to release yet" a clean no-op.
 *
 * @param {ReturnType<typeof parseChangelog>} entries
 */
export function latestRelease(entries) {
  return entries.find((entry) => entry.version.toLowerCase() !== UNRELEASED) ?? null;
}

/** True when a section's version is one this tool will tag. */
export function isReleasableVersion(version) {
  return VERSION.test(version);
}

/** The notes for a section: its body, with the heading line left out. */
export function releaseNotes(entry) {
  return entry.body;
}

// ------------------------------------------------------------------ CLI -----

function parseArgs(argv) {
  const options = { publish: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--publish") options.publish = true;
    else if (arg === "--changelog") options.changelog = argv[++i];
    else if (arg === "--notes-out") options.notesOut = argv[++i];
    else if (arg === "--tagged") options.tagged = argv[++i];
    else if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "--sha") options.sha = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown option '${arg}'`);
  }
  return options;
}

function note(message) {
  process.stderr.write(`${message}\n`);
}

/** Existing tags: an explicit list wins, otherwise ask git. */
function existingTags(options) {
  if (options.tagged !== undefined) {
    return new Set(options.tagged.split(",").map((t) => t.trim()).filter(Boolean));
  }
  try {
    const out = execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" });
    return new Set(out.split("\n").map((t) => t.trim()).filter(Boolean));
  } catch (err) {
    throw new Error(`cannot list git tags (${err.message}); pass --tagged to supply them`);
  }
}

async function api(method, path, body) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("--publish needs GITHUB_TOKEN or GH_TOKEN");
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  return { status: response.status, payload };
}

async function publish({ tag, repo, sha, notes }) {
  if (!repo) throw new Error("--publish needs --repo (or GITHUB_REPOSITORY)");
  if (!sha) throw new Error("--publish needs --sha (or GITHUB_SHA)");

  const existing = await api("GET", `/repos/${repo}/releases/tags/${tag}`);
  if (existing.status === 200) {
    note(`release ${tag} already exists — leaving it alone`);
    process.stdout.write(`published=false\nrelease_url=${existing.payload.html_url}\n`);
    return;
  }
  if (existing.status !== 404) {
    throw new Error(`cannot check for an existing release: HTTP ${existing.status}`);
  }

  const tagRef = `refs/tags/${tag}`;
  const tagLookup = await api("GET", `/repos/${repo}/git/ref/${tagRef}`);
  if (tagLookup.status === 404) {
    const created = await api("POST", `/repos/${repo}/git/refs`, { ref: tagRef, sha });
    if (created.status !== 201) {
      throw new Error(`cannot create ${tagRef}: HTTP ${created.status} ${created.payload.message ?? ""}`);
    }
    note(`created tag ${tag} at ${sha.slice(0, 7)}`);
  } else if (tagLookup.status === 200) {
    note(`tag ${tag} already existed — reusing it`);
  } else {
    throw new Error(`cannot check for an existing tag: HTTP ${tagLookup.status}`);
  }

  const created = await api("POST", `/repos/${repo}/releases`, {
    tag_name: tag,
    name: `Typhoun ${tag}`,
    body: notes,
    draft: false,
    prerelease: false,
  });
  if (created.status !== 201) {
    throw new Error(`cannot create the release: HTTP ${created.status} ${created.payload.message ?? ""}`);
  }
  note(`published ${created.payload.html_url}`);
  process.stdout.write(`published=true\nrelease_url=${created.payload.html_url}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const changelogPath = options.changelog ?? join(root, "CHANGELOG.md");
  const entries = parseChangelog(readFileSync(changelogPath, "utf8"));
  const latest = latestRelease(entries);

  if (!latest) {
    note("no released section in the CHANGELOG — nothing to release");
    process.stdout.write("releasable=false\nversion=\ntag=\nnotes_chars=0\n");
    return;
  }

  const version = latest.version;
  const tag = `v${version}`;
  const notes = releaseNotes(latest);
  note(`CHANGELOG names ${tag}${latest.date ? ` (${latest.date})` : ""}, ${notes.length} characters of notes`);

  if (options.notesOut) writeFileSync(options.notesOut, `${notes}\n`, "utf8");

  if (!isReleasableVersion(version)) {
    note(`'${version}' is not a version this tool will tag — skipping`);
    process.stdout.write(`releasable=false\nversion=${version}\ntag=\nnotes_chars=${notes.length}\n`);
    return;
  }

  const tags = existingTags(options);
  const releasable = !tags.has(tag);
  note(releasable ? `${tag} is untagged — this run would publish it` : `${tag} already exists — nothing to do`);

  process.stdout.write(`releasable=${releasable}\nversion=${version}\ntag=${tag}\nnotes_chars=${notes.length}\n`);

  if (!options.publish) return;
  if (!releasable) {
    note("--publish asked for, but the tag exists; not touching it");
    return;
  }
  await publish({
    tag,
    repo: options.repo ?? process.env.GITHUB_REPOSITORY,
    sha: options.sha ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    notes,
  });
}

// Only run when executed, so tests can import the parsing functions.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

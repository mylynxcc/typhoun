#!/usr/bin/env node
/**
 * Typhoun release planner.
 *
 * Usage:
 *   node tools/release/plan-release.js [--changelog PATH] [--notes-out PATH]
 *                                      [--tagged a,b,c] [--publish] [--dry-run]
 *                                      [--repo OWNER/NAME] [--sha COMMIT]
 *
 * `--dry-run` (which needs `--publish`) walks the entire publish path — the
 * idempotency checks, the tag, the release built from the notes — through a
 * transport that sends nothing and answers as if nothing had been published
 * yet. It needs no token and no network, prints the requests a real run would
 * make, and reports `published=false`. That is what makes the branch which
 * actually publishes testable: it used to run once per version, so a mistake in
 * it was found by the release it broke.
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
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--changelog") options.changelog = argv[++i];
    else if (arg === "--notes-out") options.notesOut = argv[++i];
    else if (arg === "--tagged") options.tagged = argv[++i];
    else if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "--sha") options.sha = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown option '${arg}'`);
  }
  // Failing loudly beats a flag that silently does nothing: a dry run only means
  // something in the context of the publish it is describing.
  if (options.dryRun && !options.publish) {
    throw new Error("--dry-run describes a publish; pass --publish as well");
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

/**
 * The real transport. Every write goes through here, and it refuses to run
 * without a token, so a publish cannot happen by accident in a context that was
 * never meant to publish.
 */
async function liveTransport(method, path, body) {
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

/**
 * A dry-run transport: records what a real run would send, sends nothing, and
 * answers as if nothing had been published yet — which is the state a run only
 * reaches when the version really is new, and therefore the path worth walking.
 */
function recordingTransport(requests) {
  return async (method, path, body) => {
    requests.push({ method, path, body });
    return method === "GET" ? { status: 404, payload: {} } : { status: 201, payload: {} };
  };
}

/**
 * Create the tag and the release, reusing or skipping whatever already exists.
 *
 * The transport is a parameter so the conditional branches can be tested
 * without a repository: the interesting behaviour is "check, then create only
 * what is missing", not the HTTP call itself.
 */
export async function publishRelease({ tag, repo, sha, notes, send, event = note }) {
  if (!repo) throw new Error("--publish needs --repo (or GITHUB_REPOSITORY)");
  if (!sha) throw new Error("--publish needs --sha (or GITHUB_SHA)");

  const existing = await send("GET", `/repos/${repo}/releases/tags/${tag}`);
  if (existing.status === 200) {
    event(`release ${tag} already exists — leaving it alone`);
    return { releaseCreated: false, releaseUrl: existing.payload.html_url ?? null };
  }
  if (existing.status !== 404) {
    throw new Error(`cannot check for an existing release: HTTP ${existing.status}`);
  }

  const tagRef = `refs/tags/${tag}`;
  const tagLookup = await send("GET", `/repos/${repo}/git/ref/${tagRef}`);
  if (tagLookup.status === 404) {
    const created = await send("POST", `/repos/${repo}/git/refs`, { ref: tagRef, sha });
    if (created.status !== 201) {
      throw new Error(`cannot create ${tagRef}: HTTP ${created.status} ${created.payload.message ?? ""}`);
    }
    event(`created tag ${tag} at ${sha.slice(0, 7)}`);
  } else if (tagLookup.status === 200) {
    event(`tag ${tag} already existed — reusing it`);
  } else {
    throw new Error(`cannot check for an existing tag: HTTP ${tagLookup.status}`);
  }

  const created = await send("POST", `/repos/${repo}/releases`, {
    tag_name: tag,
    name: `Typhoun ${tag}`,
    body: notes,
    draft: false,
    prerelease: false,
  });
  if (created.status !== 201) {
    throw new Error(`cannot create the release: HTTP ${created.status} ${created.payload.message ?? ""}`);
  }
  const url = created.payload.html_url ?? null;
  if (url) event(`published ${url}`);
  return { releaseCreated: true, releaseUrl: url };
}

/** A request body as one line, with the notes measured instead of pasted. */
function describeBody(body) {
  const parts = Object.entries(body).map(([key, value]) =>
    key === "body" ? `"body": ${value.length} characters of notes` : `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `{ ${parts.join(", ")} }`;
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

  const requests = [];
  const report = await publishRelease({
    tag,
    repo: options.repo ?? process.env.GITHUB_REPOSITORY,
    sha: options.sha ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    notes,
    send: options.dryRun ? recordingTransport(requests) : liveTransport,
    // A dry run says nothing about what happened; it reports what would happen
    // below, from the requests themselves.
    event: options.dryRun ? () => {} : note,
  });

  if (options.dryRun) {
    note(`dry run — nothing was sent; a real publish would make ${requests.length} request(s):`);
    for (const request of requests) {
      note(`  ${request.method} ${request.path}`);
      if (request.body) note(`      ${describeBody(request.body)}`);
    }
    note("  (responses were simulated: a real run reuses whatever the repository already has)");
    process.stdout.write(`dry_run=true\npublished=false\nrelease_url=\nplanned_requests=${requests.length}\n`);
    return;
  }

  process.stdout.write(`dry_run=false\npublished=${report.releaseCreated}\nrelease_url=${report.releaseUrl ?? ""}\n`);
}

// Only run when executed, so tests can import the parsing functions.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

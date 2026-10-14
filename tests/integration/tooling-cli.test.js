/**
 * `typhoun fmt` and `typhoun lint` through the real command-line interface.
 *
 * These cases drive `main()` with captured streams — the same entry point
 * `bin/typhoun.js` uses — so they cover option parsing, exit codes, the JSON
 * form and the human-readable form. Files are written in throwaway directories
 * because `fmt` rewrites what it is given.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "../../src/cli/cli.js";
import { fixture } from "../helpers.js";

const GUARDED = [
  "fn risky(n) {",
  "    return 10 / n",
  "}",
  "try {",
  "    print(risky(0))",
  "} catch err {",
  "    print(err.code)",
  "}",
  "",
].join("\n");

function runCli(argv) {
  const out = [];
  const err = [];
  const code = main(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "typhoun-cli-"));
}

function write(dir, name, text) {
  const path = join(dir, name);
  writeFileSync(path, text, "utf8");
  return path;
}

const MESSY = "let x=1\nprint( x )\n";
const WARNING = "let unused = 1\n";

describe("cli: fmt", () => {
  it("prints the canonical source with --stdout and leaves the file alone", () => {
    const dir = tempDir();
    const path = write(dir, "messy.typ", MESSY);

    const { code, stdout } = runCli(["fmt", "--stdout", path]);
    assert.equal(code, EXIT_OK);
    assert.equal(stdout, "let x = 1\nprint(x)\n");
    assert.equal(readFileSync(path, "utf8"), MESSY, "--stdout must not write");
  });

  it("reports files that are not formatted with --check, changing nothing", () => {
    const dir = tempDir();
    const messy = write(dir, "messy.typ", MESSY);
    const clean = write(dir, "clean.typ", "let x = 1\nprint(x)\n");

    const bad = runCli(["fmt", "--check", messy]);
    assert.equal(bad.code, EXIT_FAILURE);
    assert.match(bad.stdout, /would reformat/);
    assert.equal(readFileSync(messy, "utf8"), MESSY);

    const good = runCli(["fmt", "--check", clean]);
    assert.equal(good.code, EXIT_OK);
    assert.match(good.stdout, /0 of 1 file\(s\) need formatting/);
  });

  it("rewrites a file in place and is idempotent", () => {
    const dir = tempDir();
    const path = write(dir, "messy.typ", MESSY);

    const first = runCli(["fmt", path]);
    assert.equal(first.code, EXIT_OK);
    assert.match(first.stdout, /^formatted /m);
    assert.match(first.stdout, /1 of 1 file\(s\) reformatted/);
    assert.equal(readFileSync(path, "utf8"), "let x = 1\nprint(x)\n");

    const second = runCli(["fmt", path]);
    assert.equal(second.code, EXIT_OK);
    assert.match(second.stdout, /0 of 1 file\(s\) reformatted/);
  });

  it("expands a directory to the .typ files inside it", () => {
    const dir = tempDir();
    write(dir, "a.typ", MESSY);
    write(dir, "b.typ", MESSY);
    write(dir, "notes.txt", "ignored\n");

    const { code, stdout } = runCli(["fmt", dir]);
    assert.equal(code, EXIT_OK);
    assert.match(stdout, /2 of 2 file\(s\) reformatted/);
    assert.equal(readFileSync(join(dir, "a.typ"), "utf8"), "let x = 1\nprint(x)\n");
  });

  it("breaks the lists that do not fit the requested width", () => {
    const dir = tempDir();
    const source = 'print("aaaa", "bbbb", "cccc")\n';
    const path = write(dir, "wide.typ", source);

    assert.equal(runCli(["fmt", "--stdout", path]).stdout, source);

    const narrow = runCli(["fmt", "--stdout", "--width", "14", path]);
    assert.equal(narrow.stdout, 'print(\n    "aaaa",\n    "bbbb",\n    "cccc"\n)\n');
    assert.equal(readFileSync(path, "utf8"), source, "--stdout must not write");
  });

  it("emits a JSON report with --json", () => {
    const dir = tempDir();
    const path = write(dir, "messy.typ", MESSY);

    const { code, stdout } = runCli(["fmt", "--check", "--json", path]);
    assert.equal(code, EXIT_FAILURE);
    const report = JSON.parse(stdout);
    assert.equal(report.mode, "check");
    assert.equal(report.total, 1);
    assert.equal(report.changed, 1);
    assert.equal(report.files[0].changed, true);
  });

  it("refuses to rewrite a file it cannot parse, and says so", () => {
    const dir = tempDir();
    const path = write(dir, "broken.typ", "let x = \n");

    const { code, stdout, stderr } = runCli(["fmt", path]);
    assert.equal(code, EXIT_FAILURE);
    assert.match(stderr, /TYP2004|error\[/);
    assert.match(stdout, /1 file\(s\) skipped/);
    assert.equal(readFileSync(path, "utf8"), "let x = \n");
  });

  it("needs at least one file, and one file for --stdout", () => {
    assert.equal(runCli(["fmt"]).code, EXIT_USAGE);
    const dir = tempDir();
    write(dir, "a.typ", MESSY);
    write(dir, "b.typ", MESSY);
    const { code, stderr } = runCli(["fmt", "--stdout", join(dir, "a.typ"), join(dir, "b.typ")]);
    assert.equal(code, EXIT_USAGE);
    assert.match(stderr, /exactly one file/);
  });

  it("rejects an invalid width", () => {
    const { code, stderr } = runCli(["fmt", fixture("programs", "hello.typ"), "--width", "0"]);
    assert.equal(code, EXIT_USAGE);
    assert.match(stderr, /--width/);
  });
});

describe("cli: try/catch through the tools", () => {
  it("shows the region markers in the disassembly", () => {
    const dir = tempDir();
    const path = write(dir, "guard.typ", GUARDED);
    const { code, stdout } = runCli(["dis", path]);
    assert.equal(code, EXIT_OK);
    assert.match(stdout, /TRY_BEGIN\s+; handler at \d+\s+into slot \d+/);
    assert.match(stdout, /TRY_END\s+; leave region/);
  });

  it("accepts a canonical statement and rewrites a cramped one", () => {
    const dir = tempDir();
    const canonical = write(dir, "canonical.typ", GUARDED);
    assert.equal(runCli(["fmt", "--check", canonical]).code, EXIT_OK);

    const messy = write(
      dir,
      "messy.typ",
      "fn risky(n) {\n    return 10 / n\n}\ntry{print(risky(0))}catch err{print(err.code)}\n",
    );
    const checked = runCli(["fmt", "--check", messy]);
    assert.equal(checked.code, EXIT_FAILURE);
    assert.match(checked.stdout, /would reformat/);

    assert.equal(runCli(["fmt", messy]).code, EXIT_OK);
    assert.equal(readFileSync(messy, "utf8"), GUARDED);
  });

  it("checks and lints a program that handles its own errors", () => {
    const dir = tempDir();
    const path = write(dir, "guard.typ", GUARDED);
    assert.equal(runCli(["check", path]).code, EXIT_OK);
    const linted = runCli(["lint", "--strict", path]);
    assert.equal(linted.code, EXIT_OK);
    assert.match(linted.stdout, /no problems found/);
  });

  it("runs the program, catches the failure and exits successfully", () => {
    const dir = tempDir();
    const path = write(dir, "guard.typ", GUARDED);
    const { code, stdout } = runCli(["run", "-q", path]);
    assert.equal(code, EXIT_OK);
    assert.equal(stdout, "TYP4002\n");
  });
});

describe("cli: lint", () => {
  it("reports a clean file as clean", () => {
    const dir = tempDir();
    const path = write(dir, "clean.typ", "const x = 1\nprint(x)\n");

    const { code, stdout, stderr } = runCli(["lint", path]);
    assert.equal(code, EXIT_OK);
    assert.equal(stderr, "");
    assert.match(stdout, /no problems found/);
  });

  it("prints warnings without failing the build", () => {
    const dir = tempDir();
    const path = write(dir, "warning.typ", WARNING);

    const { code, stdout } = runCli(["lint", path]);
    assert.equal(code, EXIT_OK);
    assert.match(stdout, /warning\[TYP7001\]/);
    assert.match(stdout, /1 warning\(s\) and 0 error\(s\)/);
  });

  it("fails on warnings with --strict and with --max-warnings 0", () => {
    const dir = tempDir();
    const path = write(dir, "warning.typ", WARNING);

    assert.equal(runCli(["lint", "--strict", path]).code, EXIT_FAILURE);
    assert.equal(runCli(["lint", "--max-warnings", "0", path]).code, EXIT_FAILURE);
    assert.equal(runCli(["lint", "--max-warnings", "1", path]).code, EXIT_OK);
  });

  it("runs only the requested rules", () => {
    const dir = tempDir();
    const path = write(dir, "two.typ", "let unused = 1\nif true { print(2) }\n");

    const all = runCli(["lint", path]);
    assert.match(all.stdout, /TYP7001/);
    assert.match(all.stdout, /TYP7008/);

    const only = runCli(["lint", "--rule", "constant-condition", path]);
    assert.doesNotMatch(only.stdout, /TYP7001/);
    assert.match(only.stdout, /TYP7008/);

    const disabled = runCli(["lint", "--disable", "constant-condition", path]);
    assert.match(disabled.stdout, /TYP7001/);
    assert.doesNotMatch(disabled.stdout, /TYP7008/);
  });

  it("accepts comma-separated and repeated rule lists", () => {
    const dir = tempDir();
    const path = write(dir, "two.typ", "let unused = 1\nif true { print(2) }\n");

    const comma = runCli(["lint", "--rule", "unused-variable,constant-condition", path]);
    assert.match(comma.stdout, /2 warning\(s\)/);
    const repeated = runCli(["lint", "--rule", "unused-variable", "--rule", "constant-condition", path]);
    assert.match(repeated.stdout, /2 warning\(s\)/);
  });

  it("rejects an unknown rule name", () => {
    const { code, stderr } = runCli(["lint", "--rule", "no-such-rule", fixture("programs", "hello.typ")]);
    assert.equal(code, EXIT_USAGE);
    assert.match(stderr, /unknown lint rule/);
    assert.match(stderr, /unused-variable/);
  });

  it("emits diagnostics and a summary as JSON", () => {
    const dir = tempDir();
    const path = write(dir, "warning.typ", WARNING);

    const { code, stdout } = runCli(["lint", "--json", path]);
    assert.equal(code, EXIT_OK);
    const report = JSON.parse(stdout);
    assert.deepEqual(report.summary, { files: 1, errors: 0, warnings: 1 });
    assert.equal(report.files[0].diagnostics[0].code, "TYP7001");
    assert.equal(report.files[0].diagnostics[0].severity, "warning");
  });

  it("reports errors and fails when the program does not resolve", () => {
    const dir = tempDir();
    const path = write(dir, "broken.typ", "let unused = 1\nprint(nope)\n");

    const { code, stderr } = runCli(["lint", path]);
    assert.equal(code, EXIT_FAILURE);
    assert.match(stderr, /TYP3001/);
  });

  it("suppresses the summary with --quiet", () => {
    const dir = tempDir();
    const path = write(dir, "warning.typ", WARNING);
    const { stdout } = runCli(["lint", "-q", path]);
    assert.doesNotMatch(stdout, /warning\(s\)/);
  });

  it("lints every .typ file in a directory", () => {
    const dir = tempDir();
    write(dir, "a.typ", WARNING);
    write(dir, "b.typ", "let another = 2\n");

    const { code, stdout } = runCli(["lint", dir]);
    assert.equal(code, EXIT_OK);
    assert.match(stdout, /2 file\(s\)/);
    assert.match(stdout, /2 warning\(s\)/);
  });

  it("needs at least one file", () => {
    assert.equal(runCli(["lint"]).code, EXIT_USAGE);
  });
});

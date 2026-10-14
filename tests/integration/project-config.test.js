/**
 * Project settings — `typhoun.json`.
 *
 * The first half exercises the settings module on its own: discovery walking
 * up a tree, the precedence rules, and the validation that turns a typo in a
 * file into a usage error rather than a silently half-applied setting. The
 * second half drives the real CLI (`main()`, the same entry point
 * `bin/typhoun.js` uses) to prove that `fmt` and `lint` actually read the file
 * and that a command-line flag still wins over it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { main, EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "../../src/cli/cli.js";
import {
  CONFIG_FILE_NAME,
  loadProjectConfig,
  findProjectConfig,
  readProjectConfig,
  resolveFormatSettings,
  resolveLintSettings,
} from "../../src/cli/project-config.js";

const WIDE = 'print("aaaa", "bbbb", "cccc")\n';
const MESSY = "let x=1\nprint( x )\n";
const CONSTANT = "if true {\n    print(1)\n}\n";
const UNUSED = "let unused = 1\n";

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
  return mkdtempSync(join(tmpdir(), "typhoun-config-"));
}

function write(dir, name, text) {
  const path = join(dir, name);
  writeFileSync(path, text, "utf8");
  return path;
}

function writeConfig(dir, data, name = CONFIG_FILE_NAME) {
  return write(dir, name, JSON.stringify(data, null, 2) + "\n");
}

/** Run a callback with `process.cwd()` set to `dir`, always restoring it. */
function inDirectory(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

describe("project settings: reading the file", () => {
  it("returns the fmt and lint sections it was given", () => {
    const dir = tempDir();
    const path = writeConfig(dir, {
      fmt: { width: 80, indent: 2 },
      lint: { rules: ["constant-condition"], disable: ["prefer-const"], strict: true, maxWarnings: 0 },
    });

    const config = readProjectConfig(path);
    assert.equal(config.path, path);
    assert.deepEqual(config.fmt, { width: 80, indent: 2 });
    assert.deepEqual(config.lint, {
      rules: ["constant-condition"],
      disable: ["prefer-const"],
      strict: true,
      maxWarnings: 0,
    });
  });

  it("treats an empty object as an empty settings file", () => {
    const dir = tempDir();
    const config = readProjectConfig(writeConfig(dir, {}));
    assert.deepEqual(config.fmt, {});
    assert.deepEqual(config.lint, {});
  });

  it("rejects everything it does not recognise, naming the offender", () => {
    const cases = [
      [{ run: { engine: "vm" } }, /unknown key in 'the top level'/],
      [{ fmt: { widht: 10 } }, /unknown key in 'fmt'/],
      [{ lint: { rule: ["constant-condition"] } }, /unknown key in 'lint'/],
      [{ fmt: { width: "wide" } }, /'fmt.width' expects an integer/],
      [{ fmt: { width: 0 } }, /'fmt.width' expects an integer/],
      [{ fmt: { indent: 40 } }, /'fmt.indent' expects an integer/],
      [{ fmt: [] }, /'fmt' expects an object/],
      [{ lint: { strict: "yes" } }, /'lint.strict' expects true or false/],
      [{ lint: { rules: "constant-condition" } }, /'lint.rules' expects an array/],
      [{ lint: { maxWarnings: -1 } }, /'lint.maxWarnings' expects an integer/],
    ];

    for (const [data, pattern] of cases) {
      const dir = tempDir();
      const path = writeConfig(dir, data);
      assert.throws(() => readProjectConfig(path), pattern, JSON.stringify(data));
    }
  });

  it("rejects a lint rule that does not exist, and lists the real ones", () => {
    const dir = tempDir();
    const path = writeConfig(dir, { lint: { rules: ["no-shadow", "constant-condition"] } });
    assert.throws(
      () => readProjectConfig(path),
      (err) => {
        assert.match(err.message, /unknown lint rule\(s\) in 'lint.rules': no-shadow/);
        assert.match(err.message, /known rules: unused-variable/);
        return true;
      },
    );
  });

  it("rejects invalid JSON and a non-object top level", () => {
    const dir = tempDir();
    const broken = write(dir, CONFIG_FILE_NAME, '{ "fmt": { width: 80, } }');
    assert.throws(() => readProjectConfig(broken), /invalid JSON/);

    const list = write(dir, "list.json", "[1, 2]");
    assert.throws(() => readProjectConfig(list), /expected a JSON object at the top level/);
  });

  it("reports an unreadable file rather than crashing", () => {
    const dir = tempDir();
    assert.throws(
      () => readProjectConfig(join(dir, "missing.json")),
      /cannot read settings file/,
    );
  });
});

describe("project settings: discovery and precedence", () => {
  it("finds the nearest settings file at or above the directory", () => {
    const root = tempDir();
    const nested = join(root, "src", "deep", "deeper");
    mkdirSync(nested, { recursive: true });
    const path = writeConfig(root, { fmt: { width: 72 } });

    assert.equal(findProjectConfig(root), path);
    assert.equal(findProjectConfig(join(root, "src")), path);
    assert.equal(findProjectConfig(nested), path);
  });

  it("does not invent a settings file that is not there", () => {
    const root = tempDir();
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    const found = findProjectConfig(nested);
    assert.ok(
      found === null || !found.startsWith(root + sep),
      `expected no settings file inside ${root}, found ${found}`,
    );
  });

  it("loads a named file instead of searching, and fails when it is absent", () => {
    const dir = tempDir();
    const path = writeConfig(dir, { fmt: { width: 64 } });
    assert.equal(loadProjectConfig({ configPath: path }).path, path);

    assert.throws(
      () => loadProjectConfig({ configPath: "nowhere.json", cwd: dir }),
      /settings file not found/,
    );
  });

  it("applies defaults, then the file, then the command line for fmt", () => {
    const config = {
      path: "/repo/typhoun.json",
      fmt: { width: 80, indent: 2 },
      lint: {},
    };

    const defaults = resolveFormatSettings({}, null);
    assert.equal(defaults.width, 100);
    assert.equal(defaults.indent, "    ");
    assert.equal(defaults.configPath, null);

    const fromFile = resolveFormatSettings({}, config);
    assert.equal(fromFile.width, 80);
    assert.equal(fromFile.indent, "  ");
    assert.equal(fromFile.indentWidth, 2);
    assert.equal(fromFile.configPath, "/repo/typhoun.json");

    const fromCli = resolveFormatSettings({ width: 40, indent: 8 }, config);
    assert.equal(fromCli.width, 40);
    assert.equal(fromCli.indent, "        ");
    assert.equal(fromCli.indentWidth, 8);
  });

  it("applies defaults, then the file, then the command line for lint", () => {
    const config = {
      path: "/repo/typhoun.json",
      fmt: {},
      lint: { rules: ["constant-condition"], disable: ["prefer-const"], strict: true, maxWarnings: 3 },
    };

    const defaults = resolveLintSettings({}, null);
    assert.equal(defaults.rules, null);
    assert.deepEqual(defaults.disable, []);
    assert.equal(defaults.strict, false);
    assert.equal(defaults.maxWarnings, null);

    const fromFile = resolveLintSettings({}, config);
    assert.deepEqual(fromFile.rules, ["constant-condition"]);
    assert.deepEqual(fromFile.disable, ["prefer-const"]);
    assert.equal(fromFile.strict, true);
    assert.equal(fromFile.maxWarnings, 3);

    const overridden = resolveLintSettings(
      { rules: ["unused-variable"], disable: ["unused-function"], maxWarnings: 10 },
      config,
    );
    assert.deepEqual(overridden.rules, ["unused-variable"]);
    assert.deepEqual(overridden.disable, ["unused-function"]);
    assert.equal(overridden.maxWarnings, 10);
    assert.equal(overridden.strict, true, "strict stays on when no flag turns it off");

    assert.equal(
      resolveLintSettings({ noStrict: true }, config).strict,
      false,
      "--no-strict turns off a strict setting from the file",
    );
  });
});

describe("cli: fmt reads typhoun.json", () => {
  it("takes the width and the indent from the file", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { fmt: { width: 14, indent: 2 } });
    const path = write(dir, "wide.typ", WIDE);

    const { code, stdout } = runCli(["fmt", "--stdout", "--config", config, path]);
    assert.equal(code, EXIT_OK);
    assert.equal(stdout, 'print(\n  "aaaa",\n  "bbbb",\n  "cccc"\n)\n');
    assert.equal(readFileSync(path, "utf8"), WIDE, "--stdout must not write");
  });

  it("still lets --width and --indent win over the file", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { fmt: { width: 14, indent: 2 } });
    const path = write(dir, "wide.typ", WIDE);

    assert.equal(runCli(["fmt", "--stdout", "--config", config, "--width", "100", path]).stdout, WIDE);
    assert.equal(
      runCli(["fmt", "--stdout", "--config", config, "--indent", "4", path]).stdout,
      'print(\n    "aaaa",\n    "bbbb",\n    "cccc"\n)\n',
    );
  });

  it("changes what --check calls canonical", () => {
    const dir = tempDir();
    const twoSpace = write(dir, "two.typ", "if true {\n  print(1)\n}\n");

    const fourSpace = writeConfig(dir, { fmt: { indent: 4 } }, "four.json");
    assert.equal(runCli(["fmt", "--check", "--config", fourSpace, twoSpace]).code, EXIT_FAILURE);

    const two = writeConfig(dir, { fmt: { indent: 2 } }, "two.json");
    assert.equal(runCli(["fmt", "--check", "--config", two, twoSpace]).code, EXIT_OK);
  });

  it("keeps the built-in defaults when there is no settings file", () => {
    const dir = tempDir();
    const path = write(dir, "wide.typ", WIDE);
    // Run from inside the empty directory: no file is discovered, so this holds
    // whatever the repository around the test suite happens to contain.
    const { code, stdout } = inDirectory(dir, () => runCli(["fmt", "--stdout", path]));
    assert.equal(code, EXIT_OK);
    assert.equal(stdout, WIDE);
  });

  it("names the settings file it used, in the text and JSON reports", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { fmt: { width: 14, indent: 2 } });
    const path = write(dir, "wide.typ", WIDE);

    const text = runCli(["fmt", "--check", "--config", config, path]);
    assert.equal(text.code, EXIT_FAILURE);
    assert.match(text.stdout, /settings from .*typhoun\.json/);

    const json = runCli(["fmt", "--check", "--json", "--config", config, path]);
    const report = JSON.parse(json.stdout);
    assert.equal(report.settings.source, config);
    assert.equal(report.settings.width, 14);
    assert.equal(report.settings.indent, 2);
  });

  it("runs --quiet without the settings line", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { fmt: { width: 14 } });
    const path = write(dir, "wide.typ", WIDE);

    const { code, stdout } = runCli(["fmt", "--check", "-q", "--config", config, path]);
    assert.equal(code, EXIT_FAILURE);
    assert.match(stdout, /^would reformat .*wide\.typ\n$/, "-q keeps the per-file line, drops the summary");
    assert.doesNotMatch(stdout, /settings from/);
  });
});

describe("cli: lint reads typhoun.json", () => {
  it("selects the rules the file lists, and only those", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { lint: { rules: ["constant-condition"] } });
    const both = write(dir, "both.typ", UNUSED + CONSTANT);

    const { code, stdout } = runCli(["lint", "--config", config, both]);
    assert.equal(code, EXIT_OK);
    assert.match(stdout, /TYP7008/);
    assert.doesNotMatch(stdout, /TYP7001/);
    assert.match(stdout, /settings from .*typhoun\.json/);
  });

  it("still lets --rule win over the file", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { lint: { rules: ["constant-condition"] } });
    const both = write(dir, "both.typ", UNUSED + CONSTANT);

    const { stdout } = runCli(["lint", "--rule", "unused-variable", "--config", config, both]);
    assert.match(stdout, /TYP7001/);
    assert.doesNotMatch(stdout, /TYP7008/);
  });

  it("applies disable, including on top of the default rule set", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { lint: { disable: ["constant-condition"] } });
    const both = write(dir, "both.typ", UNUSED + CONSTANT);

    const { stdout } = runCli(["lint", "--config", config, both]);
    assert.doesNotMatch(stdout, /TYP7008/);
    assert.match(stdout, /TYP7001/, "the other rules are still on");
  });

  it("takes strict from the file, and --no-strict turns it back off", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { lint: { strict: true } });
    const path = write(dir, "warn.typ", CONSTANT);

    assert.equal(runCli(["lint", "--config", config, path]).code, EXIT_FAILURE);
    assert.equal(runCli(["lint", "--no-strict", "--config", config, path]).code, EXIT_OK);
  });

  it("takes maxWarnings from the file, and --max-warnings wins over it", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { lint: { maxWarnings: 0 } });
    const path = write(dir, "warn.typ", CONSTANT);

    assert.equal(runCli(["lint", "--config", config, path]).code, EXIT_FAILURE);
    assert.equal(runCli(["lint", "--max-warnings", "5", "--config", config, path]).code, EXIT_OK);
  });

  it("reports the rules in force with --json", () => {
    const dir = tempDir();
    const config = writeConfig(dir, { lint: { rules: ["constant-condition"], strict: true } });
    const path = write(dir, "warn.typ", CONSTANT);

    const { code, stdout } = runCli(["lint", "--json", "--config", config, path]);
    assert.equal(code, EXIT_FAILURE);
    const report = JSON.parse(stdout);
    assert.equal(report.settings.source, config);
    assert.deepEqual(report.settings.rules, ["constant-condition"]);
    assert.equal(report.settings.strict, true);
    assert.equal(report.summary.warnings, 1);
  });

  it("keeps the built-in rule set when there is no settings file", () => {
    const dir = tempDir();
    const both = write(dir, "both.typ", UNUSED + CONSTANT);
    const { code, stdout } = inDirectory(dir, () => runCli(["lint", "--json", both]));
    assert.equal(code, EXIT_OK);
    const report = JSON.parse(stdout);
    assert.equal(report.settings.source, null);
    assert.equal(report.settings.rules, null);
    assert.equal(report.settings.strict, false);
    assert.equal(report.summary.warnings, 2);
  });
});

describe("cli: how the settings file is located", () => {
  it("discovers the file by walking up from the working directory", () => {
    const root = tempDir();
    const nested = join(root, "src", "nested");
    mkdirSync(nested, { recursive: true });
    writeConfig(root, { fmt: { width: 14, indent: 2 } });
    const path = write(nested, "wide.typ", WIDE);

    const result = inDirectory(nested, () => runCli(["fmt", "--stdout", path]));
    assert.equal(result.code, EXIT_OK);
    assert.equal(result.stdout, 'print(\n  "aaaa",\n  "bbbb",\n  "cccc"\n)\n');

    const reported = inDirectory(root, () => runCli(["fmt", "--check", path]));
    assert.match(reported.stdout, /settings from typhoun\.json/);
  });

  it("reads a file with any name when --config names it", () => {
    const dir = tempDir();
    const named = writeConfig(dir, { fmt: { width: 14 } }, "tooling.json");
    const path = write(dir, "wide.typ", WIDE);

    const { code, stdout } = runCli(["fmt", "--stdout", "--config", named, path]);
    assert.equal(code, EXIT_OK);
    assert.equal(stdout, 'print(\n    "aaaa",\n    "bbbb",\n    "cccc"\n)\n');
  });

  it("fails with a usage error on a broken file, changing nothing", () => {
    const dir = tempDir();
    const path = write(dir, "wide.typ", WIDE);

    const unknownKey = writeConfig(dir, { fmt: { widht: 10 } }, "typo.json");
    const first = runCli(["fmt", path, "--config", unknownKey]);
    assert.equal(first.code, EXIT_USAGE);
    assert.match(first.stderr, /unknown key in 'fmt'|unknown key/);
    assert.match(first.stderr, /widht/);
    assert.equal(readFileSync(path, "utf8"), WIDE);

    const badRule = writeConfig(dir, { lint: { rules: ["no-such-rule"] } }, "bad-rule.json");
    const second = runCli(["lint", path, "--config", badRule]);
    assert.equal(second.code, EXIT_USAGE);
    assert.match(second.stderr, /unknown lint rule\(s\)/);

    const badJson = write(dir, "bad.json", "{ nope }");
    const third = runCli(["lint", path, "--config", badJson]);
    assert.equal(third.code, EXIT_USAGE);
    assert.match(third.stderr, /invalid JSON/);

    const fourth = runCli(["fmt", path, "--config", join(dir, "absent.json")]);
    assert.equal(fourth.code, EXIT_USAGE);
    assert.match(fourth.stderr, /settings file not found/);

    const fifth = runCli(["fmt", path, "--config"]);
    assert.equal(fifth.code, EXIT_USAGE);
    assert.match(fifth.stderr, /'--config' expects a path/);
  });

  it("does not disturb the commands that have nothing to configure", () => {
    const dir = tempDir();
    const broken = write(dir, "broken.json", "{ nope }");
    const path = write(dir, "wide.typ", WIDE);

    assert.equal(runCli(["check", "--config", broken, path]).code, EXIT_OK);
    assert.equal(runCli(["tokens", "--config", broken, path]).code, EXIT_OK);
    assert.equal(runCli(["fmt", path, "--config", broken]).code, EXIT_USAGE);
  });
});

/**
 * Stage 7 — Command-line interface.
 *
 * Commands: run, check, tokens, ast, version, help (plus an interactive repl).
 * Diagnostics go to standard error; program output goes to standard output.
 * Exit codes: 0 success, 1 diagnostics/execution failure, 2 usage error.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import {
  LANG_CLI,
  LANG_EXTENSION,
  LANG_NAME,
  LANG_TAGLINE,
  LANG_VERSION,
  DEFAULT_LIMITS,
} from "../config.js";
import { DEFAULT_WIDTH } from "../format/formatter.js";
import { RULES as LINT_RULES, unknownRules } from "../lint/rules.js";
import {
  ConfigurationError,
  DEFAULT_ENGINE,
  ENGINES,
  ExecutionContext,
  Environment,
  NodeType,
  checkFile,
  compileFile,
  createEngine,
  disassemble,
  disassembleSummary,
  formatFile,
  lintFile,
  parseSource,
  runFile,
  tokenizeSource,
  printAst,
  renderDiagnostics,
  SourceManager,
  TyphounError,
} from "../main/index.js";
import { toRepr } from "../runtime/values.js";
import {
  benchmarkAll,
  collectPrograms,
  formatReport,
} from "./bench.js";
import { createLineReader } from "./sync-input.js";
import {
  CONFIG_FILE_NAME,
  DEFAULT_INDENT_WIDTH,
  MAX_INDENT_WIDTH,
  loadProjectConfig,
  resolveFormatSettings,
  resolveLintSettings,
} from "./project-config.js";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

export function usage() {
  return [
    `${LANG_NAME} ${LANG_VERSION} — ${LANG_TAGLINE}`,
    "",
    `Usage: ${LANG_CLI} <command> [options] [file${LANG_EXTENSION}]`,
    "",
    "Commands:",
    "  run <file>      Execute a Typhoun program",
    "  check <file>    Lex, parse and analyze without executing",
    "  tokens <file>   Print the token stream with source positions",
    "  ast <file>      Print the abstract syntax tree",
    "  dis <file>      Compile to bytecode and print the disassembly",
    "  fmt [file..]    Rewrite files in the canonical style (--check to verify)",
    "  lint [file..]   Report actionable warnings without running the program",
    "  bench [file..]  Benchmark the tree-walker against the bytecode VM",
    "  version         Print language and runtime version information",
    "  help            Show this message",
    "  repl            Start an interactive session",
    "",
    "Options:",
    `  --engine <name>     Execution backend: ${ENGINES.join(" | ")} (default: ${DEFAULT_ENGINE})`,
    "  --iterations <n>    Timed benchmark runs per program (default: 5)",
    "  --warmups <n>       Untimed warm-up runs per program (default: 1)",
    `  --root <dir>        Restrict imports to <dir> (default: the entry file's directory)`,
    `  --max-steps <n>     Maximum evaluated steps (default: ${DEFAULT_LIMITS.maxSteps})`,
    `  --max-depth <n>     Maximum call depth (default: ${DEFAULT_LIMITS.maxCallDepth})`,
    `  --max-ms <n>        Wall-clock limit in milliseconds (default: ${DEFAULT_LIMITS.maxDurationMs})`,
    `  --output-limit <n>  Maximum characters a program may print`,
    "  --no-input          Disable the input() built-in",
    "  -q, --quiet         Suppress the trailing summary line",
    "  --json              Emit diagnostics as JSON (check, fmt, lint)",
    "  --check             fmt: report files that are not formatted, change nothing",
    "  --stdout            fmt: print the formatted source instead of writing",
    `  --width <n>         fmt: maximum line width (default: ${DEFAULT_WIDTH})`,
    `  --indent <n>        fmt: spaces per indent level (default: ${DEFAULT_INDENT_WIDTH})`,
    "  --strict            lint: exit nonzero when warnings are found",
    "  --no-strict         lint: ignore 'strict: true' from the settings file",
    "  --max-warnings <n>  lint: exit nonzero above n warnings",
    "  --rule <names>      lint: run only these rules (comma separated, repeatable)",
    "  --disable <names>   lint: skip these rules (comma separated, repeatable)",
    `  --config <path>     Read settings from <path> instead of searching for ${CONFIG_FILE_NAME}`,
    "",
    `fmt and lint read their defaults from ${CONFIG_FILE_NAME} in the working`,
    "directory or the nearest parent; a command-line flag always wins.",
    "",
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 * @returns {number} process exit code
 */
export function main(argv, io) {
  const args = [...argv];
  const command = args.shift();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(usage());
    return command ? EXIT_OK : EXIT_USAGE;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    io.stdout(
      [
        `${LANG_NAME} ${LANG_VERSION}`,
        `tagline: ${LANG_TAGLINE}`,
        `source extension: ${LANG_EXTENSION}`,
        `runtime: Node.js ${process.version} on ${process.platform}`,
        `parallelism: ${typeof availableParallelism === "function" ? availableParallelism() : "n/a"}`,
      ].join("\n") + "\n",
    );
    return EXIT_OK;
  }

  const { options, positional, error } = parseOptions(args);
  if (error) {
    io.stderr(`error: ${error}\n\n`);
    io.stderr(usage());
    return EXIT_USAGE;
  }
  if (options.engine !== undefined && !ENGINES.includes(options.engine)) {
    io.stderr(
      `error: unknown engine '${options.engine}'. Expected one of: ${ENGINES.join(", ")}\n\n`,
    );
    return EXIT_USAGE;
  }
  if (options.width !== undefined && !(Number.isFinite(options.width) && options.width > 0)) {
    io.stderr(`error: '--width' expects a positive number\n\n`);
    return EXIT_USAGE;
  }
  if (
    options.maxWarnings !== undefined &&
    !(Number.isFinite(options.maxWarnings) && options.maxWarnings >= 0)
  ) {
    io.stderr(`error: '--max-warnings' expects a number of zero or more\n\n`);
    return EXIT_USAGE;
  }
  if (
    options.indent !== undefined &&
    !(Number.isInteger(options.indent) && options.indent >= 0 && options.indent <= MAX_INDENT_WIDTH)
  ) {
    io.stderr(`error: '--indent' expects an integer between 0 and ${MAX_INDENT_WIDTH}\n\n`);
    return EXIT_USAGE;
  }
  const requestedRules = [...(options.rules ?? []), ...(options.disable ?? [])];
  const unknown = unknownRules(requestedRules);
  if (unknown.length > 0) {
    io.stderr(
      `error: unknown lint rule(s): ${unknown.join(", ")}\n` +
        `known rules: ${LINT_RULES.map((rule) => rule.name).join(", ")}\n\n`,
    );
    return EXIT_USAGE;
  }

  // `fmt` and `lint` take their defaults from the project settings file. The
  // command line has already been validated above, so the file can only supply
  // what was left out — except for `--no-strict`, which is the flag that turns
  // a stricter setting back off.
  let settings = null;
  if (command === "fmt" || command === "lint") {
    try {
      const config = loadProjectConfig({ configPath: options.config });
      settings =
        command === "fmt"
          ? resolveFormatSettings(options, config)
          : resolveLintSettings(options, config);
    } catch (err) {
      if (err instanceof ConfigurationError) {
        io.stderr(`error: ${err.message}\n`);
        return EXIT_USAGE;
      }
      throw err;
    }
  }

  switch (command) {
    case "run":
      return commandRun(positional, options, io);
    case "check":
      return commandCheck(positional, options, io);
    case "tokens":
      return commandTokens(positional, options, io);
    case "ast":
      return commandAst(positional, options, io);
    case "dis":
      return commandDis(positional, options, io);
    case "fmt":
      return commandFmt(positional, options, settings, io);
    case "lint":
      return commandLint(positional, options, settings, io);
    case "bench":
      return commandBench(positional, options, io);
    case "repl":
      return commandRepl(options, io);
    default:
      io.stderr(`error: unknown command '${command}'\n\n`);
      io.stderr(usage());
      return EXIT_USAGE;
  }
}

/** Split a comma-separated option value, tolerating repeats and spaces. */
function listValues(value) {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ------------------------------------------------------------------- options

function parseOptions(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--root":
        options.root = args[++i];
        break;
      case "--max-steps":
        options.maxSteps = Number(args[++i]);
        break;
      case "--max-depth":
        options.maxDepth = Number(args[++i]);
        break;
      case "--max-ms":
        options.maxMs = Number(args[++i]);
        break;
      case "--output-limit":
        options.outputLimit = Number(args[++i]);
        break;
      case "--no-input":
        options.allowInput = false;
        break;
      case "-q":
      case "--quiet":
        options.quiet = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--engine":
        options.engine = args[++i];
        break;
      case "-e":
        options.engine = args[++i];
        break;
      case "--iterations":
        options.iterations = Number(args[++i]);
        break;
      case "--warmups":
        options.warmups = Number(args[++i]);
        break;
      case "--check":
        options.check = true;
        break;
      case "--stdout":
        options.stdout = true;
        break;
      case "--width":
        options.width = Number(args[++i]);
        break;
      case "--indent":
        options.indent = Number(args[++i]);
        break;
      case "--config": {
        const value = args[++i];
        if (value === undefined) {
          return { options, positional, error: "'--config' expects a path" };
        }
        options.config = value;
        break;
      }
      case "--no-strict":
        options.noStrict = true;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--max-warnings":
        options.maxWarnings = Number(args[++i]);
        break;
      case "--rule":
        options.rules = [...(options.rules ?? []), ...listValues(args[++i])];
        break;
      case "--disable":
        options.disable = [...(options.disable ?? []), ...listValues(args[++i])];
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") {
          return { options, positional, error: `unknown option '${arg}'` };
        }
        positional.push(arg);
    }
  }
  return { options, positional, error: null };
}

function limitOptions(options) {
  const limits = {};
  if (Number.isFinite(options.maxSteps)) limits.maxSteps = options.maxSteps;
  if (Number.isFinite(options.maxDepth)) limits.maxCallDepth = options.maxDepth;
  if (Number.isFinite(options.maxMs)) limits.maxDurationMs = options.maxMs;
  if (Number.isFinite(options.outputLimit)) limits.maxOutputChars = options.outputLimit;
  if (options.allowInput === false) limits.allowInput = false;
  return limits;
}

// ------------------------------------------------------------------ commands

function requireFile(positional, io, command) {
  if (positional.length !== 1) {
    io.stderr(`error: '${command}' expects exactly one file argument\n\n`);
    io.stderr(usage());
    return null;
  }
  const file = resolve(positional[0]);
  if (!existsSync(file)) {
    io.stderr(`error: file not found: ${file}\n`);
    return null;
  }
  return file;
}

function commandRun(positional, options, io) {
  const file = requireFile(positional, io, "run");
  if (!file) return EXIT_USAGE;
  const engineName = options.engine ?? DEFAULT_ENGINE;
  const readLine = createLineReader(0);
  const sourceManager = new SourceManager();
  try {
    const result = runFile(file, {
      sourceManager,
      engine: engineName,
      moduleRoot: options.root,
      limits: limitOptions(options),
      onOutput: (text) => io.stdout(text),
      onInput: () => {
        const line = readLine();
        return line === null ? "" : line;
      },
    });
    if (!options.quiet) {
      io.stderr(
        `[${LANG_NAME}] program finished in ${result.context.elapsedMs()} ms ` +
          `(${result.context.steps} steps, ${engineName} engine)\n`,
      );
    }
    return EXIT_OK;
  } catch (err) {
    return reportFailure(err, sourceManager, io);
  }
}

function commandDis(positional, options, io) {
  if (positional.length === 0) {
    io.stderr("error: 'dis' expects at least one file argument\n\n");
    io.stderr(usage());
    return EXIT_USAGE;
  }
  let failed = false;
  for (const name of positional) {
    const file = resolve(name);
    if (!existsSync(file)) {
      io.stderr(`error: file not found: ${file}\n`);
      failed = true;
      continue;
    }
    const sourceManager = new SourceManager();
    try {
      const compiled = compileFile(file, {
        sourceManager,
        rootDir: options.root,
        limits: limitOptions(options),
      });
      if (options.json) {
        const summary = {};
        for (const [absPath, proto] of compiled.protos) {
          summary[relative(compiled.loader.rootDir, absPath) || absPath] = disassembleSummary(proto);
        }
        io.stdout(JSON.stringify(summary, null, 2) + "\n");
        continue;
      }
      for (const [absPath, proto] of compiled.protos) {
        const label = relative(compiled.loader.rootDir, absPath) || absPath;
        io.stdout(`; module ${label}\n`);
        io.stdout(disassemble(proto) + "\n\n");
      }
    } catch (err) {
      const code = reportFailure(err, sourceManager, io);
      failed = failed || code !== EXIT_OK;
    }
  }
  return failed ? EXIT_FAILURE : EXIT_OK;
}

/**
 * Resolve file arguments, expanding directories to the `.typ` files inside
 * them. Returns null (after reporting) when something is missing.
 */
function collectFileArguments(positional, io, command) {
  if (positional.length === 0) {
    io.stderr(`error: '${command}' expects at least one file argument\n\n`);
    io.stderr(usage());
    return null;
  }
  const files = new Set();
  for (const name of positional) {
    const file = resolve(name);
    if (!existsSync(file)) {
      io.stderr(`error: file not found: ${file}\n`);
      return null;
    }
    if (statSync(file).isDirectory()) {
      const found = collectPrograms(file);
      if (found.length === 0) {
        io.stderr(`error: no ${LANG_EXTENSION} files in ${file}\n`);
        return null;
      }
      for (const entry of found) files.add(entry);
    } else {
      files.add(file);
    }
  }
  return [...files].sort();
}

/** Path shown to the user: relative to the working directory when possible. */
function displayPath(path) {
  const relativePath = relative(process.cwd(), path);
  return relativePath && !relativePath.startsWith("..") ? relativePath : path;
}

function commandFmt(positional, options, settings, io) {
  const files = collectFileArguments(positional, io, "fmt");
  if (!files) return EXIT_USAGE;
  if (options.stdout && files.length !== 1) {
    io.stderr("error: '--stdout' formats exactly one file\n\n");
    return EXIT_USAGE;
  }

  const results = [];
  let broken = false;

  for (const file of files) {
    let formatted;
    try {
      formatted = formatFile(file, { width: settings.width, indent: settings.indent });
    } catch (err) {
      io.stderr(`error: ${err.message}\n`);
      return EXIT_USAGE;
    }
    if (formatted.diagnostics.hasErrors) {
      io.stderr(renderDiagnostics(formatted.diagnostics.items, formatted.sourceManager) + "\n");
      broken = true;
      continue;
    }
    results.push({ path: file, code: formatted.code, changed: formatted.formatted });
  }

  if (options.stdout) {
    if (results[0]) io.stdout(results[0].code);
    return broken ? EXIT_FAILURE : EXIT_OK;
  }

  if (options.json) {
    io.stdout(
      JSON.stringify(
        {
          files: results.map((r) => ({ path: displayPath(r.path), changed: r.changed })),
          changed: results.filter((r) => r.changed).length,
          total: results.length,
          mode: options.check ? "check" : "write",
          settings: settingsSummary(settings),
        },
        null,
        2,
      ) + "\n",
    );
    return broken || (options.check && results.some((r) => r.changed)) ? EXIT_FAILURE : EXIT_OK;
  }

  let changed = 0;
  for (const result of results) {
    if (!result.changed) continue;
    changed += 1;
    if (options.check) {
      io.stdout(`would reformat ${displayPath(result.path)}\n`);
    } else {
      writeFileSync(result.path, result.code, "utf8");
      io.stdout(`formatted ${displayPath(result.path)}\n`);
    }
  }

  if (!options.quiet) {
    if (settings.configPath) {
      io.stdout(`settings from ${displayPath(settings.configPath)}\n`);
    }
    const verb = options.check ? "need formatting" : "reformatted";
    io.stdout(`${changed} of ${results.length} file(s) ${verb}\n`);
    const skipped = files.length - results.length;
    if (skipped > 0) {
      io.stdout(`${skipped} file(s) skipped: the formatter will not rewrite a file it cannot parse\n`);
    }
  }
  if (broken) return EXIT_FAILURE;
  return options.check && changed > 0 ? EXIT_FAILURE : EXIT_OK;
}

function commandLint(positional, options, settings, io) {
  const files = collectFileArguments(positional, io, "lint");
  if (!files) return EXIT_USAGE;

  const results = [];
  for (const file of files) {
    try {
      results.push(
        lintFile(file, { rules: settings.rules, disable: settings.disable }),
      );
    } catch (err) {
      io.stderr(`error: ${err.message}\n`);
      return EXIT_USAGE;
    }
  }

  const errors = results.reduce((total, r) => total + r.errors.length, 0);
  const warnings = results.reduce((total, r) => total + r.warnings.length, 0);

  if (options.json) {
    io.stdout(
      JSON.stringify(
        {
          files: results.map((r) => ({
            path: displayPath(r.path),
            diagnostics: r.diagnostics.toJSON(),
          })),
          summary: { files: results.length, errors, warnings },
          settings: settingsSummary(settings),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    for (const result of results) {
      if (result.diagnostics.length === 0) continue;
      io[result.errors.length > 0 ? "stderr" : "stdout"](
        renderDiagnostics(result.diagnostics.items, result.sourceManager) + "\n",
      );
    }
    if (!options.quiet) {
      if (settings.configPath) {
        io.stdout(`settings from ${displayPath(settings.configPath)}\n`);
      }
      io.stdout(
        errors + warnings === 0
          ? `${results.length} file(s) checked, no problems found\n`
          : `${warnings} warning(s) and ${errors} error(s) in ${results.length} file(s)\n`,
      );
    }
  }

  if (errors > 0) return EXIT_FAILURE;
  if (Number.isFinite(settings.maxWarnings) && warnings > settings.maxWarnings) return EXIT_FAILURE;
  if (settings.strict && warnings > 0) return EXIT_FAILURE;
  return EXIT_OK;
}

/**
 * The settings in force, for the `--json` reports. `source` names the file the
 * values came from, or null when they are all built-in defaults.
 */
function settingsSummary(settings) {
  const summary = { source: settings.configPath ? displayPath(settings.configPath) : null };
  if (settings.width !== undefined) summary.width = settings.width;
  if (settings.indentWidth !== undefined) summary.indent = settings.indentWidth;
  if (settings.rules !== undefined) summary.rules = settings.rules;
  if (settings.disable !== undefined) summary.disable = settings.disable;
  if (settings.strict !== undefined) summary.strict = settings.strict;
  if (settings.maxWarnings !== undefined) summary.maxWarnings = settings.maxWarnings;
  return summary;
}

function commandBench(positional, options, io) {
  const benchmarkDir = resolve(projectRoot(), "benchmarks");
  const files = positional.length
    ? positional.map((name) => resolve(name))
    : collectPrograms(benchmarkDir);
  if (files.length === 0) {
    io.stderr(`error: no benchmark programs found in ${benchmarkDir}\n`);
    return EXIT_USAGE;
  }
  for (const file of files) {
    if (!existsSync(file)) {
      io.stderr(`error: file not found: ${file}\n`);
      return EXIT_USAGE;
    }
  }

  const report = benchmarkAll(files, {
    iterations: Number.isFinite(options.iterations) ? options.iterations : 5,
    warmups: Number.isFinite(options.warmups) ? options.warmups : 1,
    limits: { ...limitOptions(options), maxDurationMs: 120_000, maxSteps: 200_000_000 },
  });

  if (options.json) {
    io.stdout(JSON.stringify(report, null, 2) + "\n");
  } else {
    io.stdout(formatReport(report, { baseDir: resolve(projectRoot()) }) + "\n");
  }
  return report.summary.errors > 0 || report.summary.mismatches > 0 ? EXIT_FAILURE : EXIT_OK;
}

/** Repository root, derived from this module's location. */
function projectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function commandCheck(positional, options, io) {
  if (positional.length === 0) {
    io.stderr("error: 'check' expects at least one file argument\n\n");
    io.stderr(usage());
    return EXIT_USAGE;
  }
  let failed = false;
  for (const name of positional) {
    const file = resolve(name);
    if (!existsSync(file)) {
      io.stderr(`error: file not found: ${file}\n`);
      failed = true;
      continue;
    }
    const { diagnostics, sourceManager } = checkFile(file, {
      moduleRoot: options.root,
      limits: limitOptions(options),
    });
    if (diagnostics.length === 0) {
      io.stdout(`ok: ${name} — no problems found\n`);
      continue;
    }
    if (options.json) {
      io.stderr(JSON.stringify(diagnostics.toJSON(), null, 2) + "\n");
    } else {
      io.stderr(renderDiagnostics(diagnostics.items, sourceManager) + "\n");
    }
    if (diagnostics.hasErrors) failed = true;
  }
  return failed ? EXIT_FAILURE : EXIT_OK;
}

function commandTokens(positional, options, io) {
  const file = requireFile(positional, io, "tokens");
  if (!file) return EXIT_USAGE;
  const manager = new SourceManager();
  const text = readFileSync(file, "utf8");
  const { tokens, diagnostics } = tokenizeSource(text, file, manager);
  for (const token of tokens) {
    const value =
      token.value === null || token.value === undefined ? "" : ` ${JSON.stringify(token.value)}`;
    io.stdout(
      `${String(token.line).padStart(4)}:${String(token.column).padStart(3)}  ${token.type.padEnd(12)} ${JSON.stringify(token.lexeme)}${value}\n`,
    );
  }
  if (diagnostics.hasErrors) {
    io.stderr("\n" + renderDiagnostics(diagnostics.items, manager) + "\n");
    return EXIT_FAILURE;
  }
  return EXIT_OK;
}

function commandAst(positional, options, io) {
  const file = requireFile(positional, io, "ast");
  if (!file) return EXIT_USAGE;
  const manager = new SourceManager();
  const text = readFileSync(file, "utf8");
  const { ast, diagnostics } = parseSource(text, file, manager);
  io.stdout(printAst(ast) + "\n");
  if (diagnostics.hasErrors) {
    io.stderr("\n" + renderDiagnostics(diagnostics.items, manager) + "\n");
    return EXIT_FAILURE;
  }
  return EXIT_OK;
}

function commandRepl(options, io) {
  const readLine = createLineReader(0);
  const manager = new SourceManager();
  const engineName = options.engine ?? DEFAULT_ENGINE;
  const context = new ExecutionContext({
    limits: limitOptions(options),
    onOutput: (text) => io.stdout(text),
    onInput: () => {
      const line = readLine();
      return line === null ? "" : line;
    },
  });
  const engine = createEngine(engineName, { sourceManager: manager, context });
  const env = new Environment(engine.createGlobalEnvironment());

  io.stdout(
    `${LANG_NAME} ${LANG_VERSION} interactive session (${engineName} engine). ` +
      "Type :quit to exit.\n",
  );
  let counter = 0;
  for (;;) {
    io.stdout("typ> ");
    const line = readLine();
    if (line === null || line === ":quit" || line === ":q" || line === ":exit") break;
    if (line.trim() === "") continue;
    counter += 1;
    const name = `<repl-${counter}>`;
    try {
      const { ast, diagnostics } = parseSource(line, name, manager);
      if (diagnostics.hasErrors) {
        io.stderr(renderDiagnostics(diagnostics.items, manager) + "\n");
        continue;
      }
      if (ast.body.length === 1 && ast.body[0].type === NodeType.ExprStmt) {
        const value = engine.evaluate(ast.body[0].expression, env);
        io.stdout(`${toRepr(value)}\n`);
      } else {
        engine.run(ast, { file: name, env });
      }
    } catch (err) {
      reportFailure(err, null, io);
    }
  }
  io.stdout("\n");
  return EXIT_OK;
}

// --------------------------------------------------------------- error output

function reportFailure(err, sourceManager, io) {
  const manager = sourceManager ?? new SourceManager();
  if (err instanceof TyphounError) {
    io.stderr(renderDiagnostics(err.diagnostics, manager) + "\n");
    io.stderr(`\nerror: ${err.diagnostics.length} diagnostic(s)\n`);
    return EXIT_FAILURE;
  }
  if (err && err.name === "RuntimeFault") {
    io.stderr(renderDiagnostics([err.toDiagnostic()], manager) + "\n");
    return EXIT_FAILURE;
  }
  if (err instanceof ConfigurationError) {
    io.stderr(`error: ${err.message}\n`);
    return EXIT_USAGE;
  }
  io.stderr(`internal error: ${err && err.stack ? err.stack : String(err)}\n`);
  return EXIT_FAILURE;
}

export { EXIT_OK, EXIT_FAILURE, EXIT_USAGE };

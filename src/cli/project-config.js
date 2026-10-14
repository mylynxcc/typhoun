/**
 * Project settings — `typhoun.json`.
 *
 * A repository can keep its formatter and linter settings next to its sources
 * instead of repeating flags on every command line. The file is deliberately
 * small and deliberately strict: it is read by two commands, every key it
 * accepts is documented in [docs/tooling.md](../../docs/tooling.md), and
 * anything else — an unknown section, a misspelled width, a lint rule that does
 * not exist — is a usage error rather than a silently ignored line. A settings
 * file that is quietly half-applied is worse than no settings file.
 *
 * Discovery walks up from the working directory and stops at the first
 * `typhoun.json`, which is what makes `typhoun fmt .` use the settings of the
 * project it is run in. `--config <path>` reads a specific file instead, and a
 * command-line flag always wins over the file (see `resolveFormatSettings` and
 * `resolveLintSettings`).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_WIDTH } from "../format/formatter.js";
import { RULES as LINT_RULES, unknownRules } from "../lint/rules.js";
import { ConfigurationError } from "../main/index.js";

/** File name searched for by default. */
export const CONFIG_FILE_NAME = "typhoun.json";

/** Default indentation, in spaces per level, when nothing else says otherwise. */
export const DEFAULT_INDENT_WIDTH = 4;

/** Largest accepted indentation, so a typo cannot reformat a file into chaos. */
export const MAX_INDENT_WIDTH = 8;

/** Sections the file accepts today. */
const SECTIONS = ["fmt", "lint"];

const FORMAT_KEYS = ["indent", "width"];
const LINT_KEYS = ["disable", "maxWarnings", "rules", "strict"];

/** True when `value` is a plain JSON object (not an array, not null). */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject keys the schema does not define, so typos surface immediately. */
function rejectUnknownKeys(path, where, value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  const sorted = unknown.sort();
  throw new ConfigurationError(
    `${path}: unknown ${sorted.length === 1 ? "key" : "keys"} in '${where}': ${sorted.join(", ")}` +
      ` (expected ${allowed.map((key) => `'${key}'`).join(", ")})`,
  );
}

function requireInteger(path, key, value, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigurationError(
      `${path}: '${key}' expects an integer between ${min} and ${max}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireRuleList(path, key, value) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new ConfigurationError(`${path}: '${key}' expects an array of rule names`);
  }
  const unknown = unknownRules(value);
  if (unknown.length > 0) {
    throw new ConfigurationError(
      `${path}: unknown lint rule(s) in '${key}': ${unknown.join(", ")}\n` +
        `known rules: ${LINT_RULES.map((rule) => rule.name).join(", ")}`,
    );
  }
  return value;
}

/** Read and validate one settings file. Throws `ConfigurationError`. */
export function readProjectConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigurationError(`${path}: cannot read settings file (${err.code ?? err.message})`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ConfigurationError(`${path}: invalid JSON — ${err.message}`);
  }
  if (!isPlainObject(data)) {
    throw new ConfigurationError(`${path}: expected a JSON object at the top level`);
  }
  rejectUnknownKeys(path, "the top level", data, SECTIONS);

  const fmt = {};
  const lint = {};

  if (data.fmt !== undefined) {
    if (!isPlainObject(data.fmt)) throw new ConfigurationError(`${path}: 'fmt' expects an object`);
    rejectUnknownKeys(path, "fmt", data.fmt, FORMAT_KEYS);
    if (data.fmt.width !== undefined) {
      fmt.width = requireInteger(path, "fmt.width", data.fmt.width, { min: 1, max: 1000 });
    }
    if (data.fmt.indent !== undefined) {
      fmt.indent = requireInteger(path, "fmt.indent", data.fmt.indent, {
        min: 0,
        max: MAX_INDENT_WIDTH,
      });
    }
  }

  if (data.lint !== undefined) {
    if (!isPlainObject(data.lint)) throw new ConfigurationError(`${path}: 'lint' expects an object`);
    rejectUnknownKeys(path, "lint", data.lint, LINT_KEYS);
    if (data.lint.rules !== undefined) lint.rules = requireRuleList(path, "lint.rules", data.lint.rules);
    if (data.lint.disable !== undefined) {
      lint.disable = requireRuleList(path, "lint.disable", data.lint.disable);
    }
    if (data.lint.strict !== undefined) {
      if (typeof data.lint.strict !== "boolean") {
        throw new ConfigurationError(
          `${path}: 'lint.strict' expects true or false, got ${JSON.stringify(data.lint.strict)}`,
        );
      }
      lint.strict = data.lint.strict;
    }
    if (data.lint.maxWarnings !== undefined) {
      lint.maxWarnings = requireInteger(path, "lint.maxWarnings", data.lint.maxWarnings, {
        min: 0,
        max: 1_000_000,
      });
    }
  }

  return { path, fmt, lint };
}

/**
 * The nearest `typhoun.json` at or above `startDir`, or null.
 * @param {string} [startDir]
 * @returns {string|null}
 */
export function findProjectConfig(startDir = process.cwd()) {
  let directory = resolve(startDir);
  for (;;) {
    const candidate = resolve(directory, CONFIG_FILE_NAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Resolve the settings file for one command invocation.
 *
 * @param {{ configPath?: string, cwd?: string }} [options] `configPath` is the
 *        `--config` value; when present it replaces the search.
 * @returns {{ path: string, fmt: object, lint: object }|null} null when no file
 *          was requested and none was found.
 */
export function loadProjectConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (options.configPath !== undefined && options.configPath !== null) {
    const absolute = resolve(cwd, options.configPath);
    if (!existsSync(absolute)) {
      throw new ConfigurationError(`settings file not found: ${absolute}`);
    }
    return readProjectConfig(absolute);
  }
  const found = findProjectConfig(cwd);
  return found ? readProjectConfig(found) : null;
}

/**
 * Effective formatter settings: the command line first, then the settings file,
 * then the built-in defaults.
 *
 * @param {{ width?: number, indent?: number }} [options] Parsed CLI options.
 * @param {{ path: string, fmt: object }|null} [config]
 * @returns {{ width: number, indent: string, indentWidth: number, configPath: string|null }}
 */
export function resolveFormatSettings(options = {}, config = null) {
  const section = config?.fmt ?? {};
  const width = Number.isFinite(options.width) ? options.width : (section.width ?? DEFAULT_WIDTH);
  const indentWidth = Number.isInteger(options.indent)
    ? options.indent
    : (section.indent ?? DEFAULT_INDENT_WIDTH);
  return {
    width,
    indent: " ".repeat(indentWidth),
    indentWidth,
    configPath: config?.path ?? null,
  };
}

/**
 * Effective linter settings. A flag that is present on the command line wins;
 * otherwise the settings file decides; otherwise the built-in default applies.
 *
 * `strict` is the one setting that needs a negative flag to be overridden,
 * because `--strict` can only turn it on: `--no-strict` turns it off even when
 * the file asks for it.
 *
 * @param {{ rules?: string[], disable?: string[], strict?: boolean, noStrict?: boolean, maxWarnings?: number }} [options]
 * @param {{ path: string, lint: object }|null} [config]
 * @returns {{ rules: string[]|null, disable: string[], strict: boolean, maxWarnings: number|null, configPath: string|null }}
 */
export function resolveLintSettings(options = {}, config = null) {
  const section = config?.lint ?? {};
  const rules =
    options.rules && options.rules.length > 0 ? options.rules : (section.rules ?? null);
  const disable =
    options.disable && options.disable.length > 0 ? options.disable : (section.disable ?? []);
  const strict =
    options.noStrict === true ? false : options.strict === true || section.strict === true;
  const maxWarnings = Number.isFinite(options.maxWarnings)
    ? options.maxWarnings
    : (section.maxWarnings ?? null);
  return { rules, disable, strict, maxWarnings, configPath: config?.path ?? null };
}

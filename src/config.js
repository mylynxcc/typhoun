/**
 * Central project configuration.
 *
 * All branding, the canonical file extension and the language version live
 * here so that the CLI, the runtime and the diagnostics system never
 * hard-code them in more than one place.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    return readFileSync(join(here, "..", "VERSION"), "utf8").trim();
  } catch {
    return "0.1.0";
  }
}

export const LANG_NAME = "Typhoun";
export const LANG_TAGLINE = "Write boldly. Build anything.";
export const LANG_VERSION = readVersion();
export const LANG_EXTENSION = ".typ";
export const LANG_CLI = "typhoun";
export const LANG_MAJOR = Number(LANG_VERSION.split(".")[0] ?? 0);

/**
 * Default resource limits applied to untrusted programs.
 *
 * These are enforced by the interpreter and the module loader. They are
 * deliberately conservative; hosts embedding the runtime may override them.
 */
export const DEFAULT_LIMITS = Object.freeze({
  /** Maximum number of source bytes accepted for a single file. */
  maxSourceBytes: 1_000_000,
  /** Maximum evaluated AST steps before a resource-limit error. */
  maxSteps: 5_000_000,
  /** Maximum nested Typhoun function calls. */
  maxCallDepth: 512,
  /** Maximum elements in a single Array. */
  maxCollectionSize: 1_000_000,
  /** Maximum characters a program may write through `print`. */
  maxOutputChars: 4_000_000,
  /** Maximum wall-clock milliseconds a program may run. */
  maxDurationMs: 10_000,
  /** Maximum modules that may be loaded in one program. */
  maxModules: 64,
  /** Whether `input()` is available. */
  allowInput: true,
});

export function versionLine() {
  return `${LANG_NAME} ${LANG_VERSION} — ${LANG_TAGLINE}`;
}

/**
 * Stage A — Source Manager (registry + safe loading).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SourceFile } from "./source-file.js";

export class SourceManager {
  constructor() {
    /** @type {Map<string, SourceFile>} keyed by the resolved file name. */
    this.files = new Map();
  }

  /**
   * Register a source file. Re-registering the same name replaces the entry.
   * @param {string} name
   * @param {string} text
   * @returns {SourceFile}
   */
  add(name, text) {
    const file = new SourceFile(name, text);
    this.files.set(name, file);
    return file;
  }

  /** @returns {SourceFile|undefined} */
  get(name) {
    return this.files.get(name);
  }

  has(name) {
    return this.files.has(name);
  }

  /**
   * Load a source file from disk into the manager.
   * @param {string} path
   * @param {{ maxSourceBytes?: number }} [options]
   * @returns {SourceFile}
   */
  loadFromDisk(path, options = {}) {
    const absolute = resolve(path);
    const text = readFileSync(absolute, "utf8");
    const { maxSourceBytes } = options;
    if (typeof maxSourceBytes === "number" && Buffer.byteLength(text, "utf8") > maxSourceBytes) {
      const err = new Error(
        `Source file exceeds the ${maxSourceBytes} byte limit: ${absolute}`,
      );
      err.code = "SOURCE_TOO_LARGE";
      throw err;
    }
    return this.add(absolute, text);
  }

  clear() {
    this.files.clear();
  }
}

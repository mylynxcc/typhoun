/**
 * A synchronous line reader for `input()`.
 *
 * The interpreter is synchronous by design (a tree-walking evaluator), so the
 * CLI feeds it lines read directly from file descriptor 0. This keeps the
 * engine free of async plumbing while still supporting interactive input.
 */
import { readSync } from "node:fs";

const BUFFER_SIZE = 4096;

export function createLineReader(fd = 0) {
  let buffer = Buffer.alloc(BUFFER_SIZE);
  let pending = "";
  let reachedEof = false;

  return function readLine() {
    if (reachedEof && pending === "") return null;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        return line;
      }
      if (reachedEof) {
        const rest = pending;
        pending = "";
        return rest.length > 0 ? rest : null;
      }
      const bytes = readSync(fd, buffer, 0, BUFFER_SIZE, null);
      if (bytes === 0) {
        reachedEof = true;
        continue;
      }
      pending += buffer.subarray(0, bytes).toString("utf8");
    }
  };
}

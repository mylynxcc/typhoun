/**
 * Stage H — Human-readable diagnostic rendering.
 *
 * Produces output in the style:
 *
 *   error[TYP3001]: Undefined variable 'username'
 *     --> main.typ:4:7
 *      |
 *    4 | print(username)
 *      |       ^^^^^^^^
 *      |
 *      = help: Declare 'username' before using it.
 */
import { SourceManager } from "../source/source-manager.js";

/**
 * @param {import("./diagnostic.js").Diagnostic} diagnostic
 * @param {import("../source/source-file.js").SourceFile|null} file
 * @returns {string}
 */
export function renderDiagnostic(diagnostic, file) {
  const lines = [];
  lines.push(`${diagnostic.severity}[${diagnostic.code}]: ${diagnostic.message}`);

  if (diagnostic.location) {
    const { file: fileName, line, column, length = 1 } = diagnostic.location;
    lines.push(`  --> ${fileName}:${line}:${column}`);

    if (file) {
      const text = file.lineText(line);
      const lineLabel = String(line);
      const gutter = " ".repeat(lineLabel.length);
      lines.push(`  ${gutter} |`);
      lines.push(`  ${lineLabel} | ${text}`);
      const caretPad = " ".repeat(Math.max(0, column - 1));
      const caretLen = Math.max(1, Math.min(length, Math.max(1, text.length - column + 1)));
      lines.push(`  ${gutter} | ${caretPad}${"^".repeat(caretLen)}`);
      lines.push(`  ${gutter} |`);
    }
  }

  for (const note of diagnostic.notes ?? []) {
    lines.push(`  = note: ${note}`);
  }
  if (diagnostic.help) {
    lines.push(`  = help: ${diagnostic.help}`);
  }
  if (diagnostic.stack && diagnostic.stack.length > 0) {
    lines.push("  = Typhoun call stack (most recent first):");
    for (const frame of diagnostic.stack) {
      lines.push(`      at ${frame}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render a list of diagnostics using a source manager for excerpts.
 * @param {import("./diagnostic.js").Diagnostic[]} diagnostics
 * @param {SourceManager} [sourceManager]
 * @returns {string}
 */
export function renderDiagnostics(diagnostics, sourceManager = new SourceManager()) {
  return diagnostics
    .map((d) => {
      const file = d.location ? sourceManager.get(d.location.file) : null;
      return renderDiagnostic(d, file ?? null);
    })
    .join("\n\n");
}

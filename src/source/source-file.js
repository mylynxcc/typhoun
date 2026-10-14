/**
 * Stage A — Source Manager.
 *
 * A `SourceFile` owns the immutable text of one Typhoun source unit and is
 * the single authority for converting character offsets into line/column
 * positions.
 *
 * Offsets are 0-based and measured in UTF-16 code units (the same unit the
 * JavaScript host uses for string indexing). Lines and columns are 1-based,
 * matching the conventions of most editors and compilers.
 */

export class SourceFile {
  /**
   * @param {string} name  Human readable path used in diagnostics.
   * @param {string} text  Full source text.
   */
  constructor(name, text) {
    this.name = name;
    this.text = text;
    /** Byte size used for the source-size limit. */
    this.byteLength = Buffer.byteLength(text, "utf8");
    /** Offsets at which each line begins (index 0 == line 1). */
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10 /* \n */) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  /** Number of lines in the file (a trailing newline does not add a line). */
  get lineCount() {
    return this.lineStarts.length;
  }

  /**
   * Convert a character offset to a 1-based line/column location.
   * @param {number} offset
   */
  locationAt(offset) {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    // Binary search for the greatest lineStart <= clamped.
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return {
      offset: clamped,
      line: lo + 1,
      column: clamped - this.lineStarts[lo] + 1,
    };
  }

  /** Return the text of a 1-based line without its trailing newline. */
  lineText(line) {
    if (line < 1 || line > this.lineStarts.length) return "";
    const start = this.lineStarts[line - 1];
    const end =
      line < this.lineStarts.length
        ? this.lineStarts[line] - 1
        : this.text.length;
    let stop = end;
    if (stop > start && this.text.charCodeAt(stop - 1) === 13 /* \r */) {
      stop -= 1;
    }
    return this.text.slice(start, stop);
  }
}

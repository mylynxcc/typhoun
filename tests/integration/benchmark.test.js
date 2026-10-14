/**
 * Benchmark harness tests.
 *
 * The harness is what backs the claim that the two engines agree, so it needs
 * to be verified like any other production code: it must actually run both
 * engines, actually detect a disagreement, and actually report failures rather
 * than quietly averaging them away.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchmarkAll,
  benchmarkFile,
  collectPrograms,
  formatMarkdown,
  formatReport,
} from "../../src/cli/bench.js";

function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), "typhoun-bench-"));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source, "utf8");
  }
  return dir;
}

const OPTIONS = { iterations: 1, warmups: 0 };

describe("benchmark: single program", () => {
  const dir = scratch({
    "work.typ": "let total = 0\nwhile total < 2000 { total += 1 }\nprint(total)\n",
  });

  it("runs both engines and reports measured times", () => {
    const result = benchmarkFile(join(dir, "work.typ"), OPTIONS);
    for (const engine of ["tree", "vm"]) {
      const measurement = result[engine];
      assert.equal(measurement.error, null, `${engine} failed: ${measurement.error}`);
      assert.equal(measurement.samples.length, 1);
      assert.ok(typeof measurement.min === "number" && measurement.min >= 0);
      assert.ok(measurement.steps > 0, `${engine} should count steps`);
    }
  });

  it("proves the two engines agree on the output", () => {
    const result = benchmarkFile(join(dir, "work.typ"), OPTIONS);
    assert.equal(result.outputsMatch, true);
    assert.equal(result.tree.outputs[0], "2000\n");
    assert.equal(result.vm.outputs[0], "2000\n");
    assert.ok(typeof result.speedup === "number" && result.speedup > 0);
  });

  it("measures the VM compile phase separately from execution", () => {
    const result = benchmarkFile(join(dir, "work.typ"), OPTIONS);
    assert.ok(typeof result.vmCompileMs === "number" && result.vmCompileMs >= 0);
  });
});

describe("benchmark: failure reporting", () => {
  const dir = scratch({
    "broken.typ": "print(1 / 0)\n",
    "good.typ": "print(1 + 1)\n",
  });

  it("records a per-engine error instead of throwing", () => {
    const result = benchmarkFile(join(dir, "broken.typ"), OPTIONS);
    assert.match(result.tree.error, /Division by zero/);
    assert.match(result.vm.error, /Division by zero/);
    assert.equal(result.outputsMatch, false, "a failed run is not a match");
    assert.equal(result.speedup, null);
  });

  it("counts errors and mismatches in the summary", () => {
    const report = benchmarkAll([join(dir, "broken.typ"), join(dir, "good.typ")], OPTIONS);
    assert.equal(report.summary.programs, 2);
    assert.equal(report.summary.errors, 1);
    assert.equal(report.summary.mismatches, 1);
    assert.equal(report.summary.compared, 1, "only the healthy program is compared");
  });

  it("still renders a report when everything failed", () => {
    const report = benchmarkAll([join(dir, "broken.typ")], OPTIONS);
    const text = formatReport(report, { baseDir: dir });
    assert.match(text, /broken\.typ/);
    assert.match(text, /0\/1 program\(s\) compared/);
  });
});

describe("benchmark: reporting", () => {
  const dir = scratch({
    "a.typ": "print(1)\n",
    "b.typ": "print(2)\n",
    "notatyp.txt": "ignored\n",
  });

  it("collects only .typ programs, recursively", () => {
    const found = collectPrograms(dir);
    assert.deepEqual(
      found.map((p) => p.split("/").pop()),
      ["a.typ", "b.typ"],
    );
  });

  it("renders a table with a speedup column", () => {
    const report = benchmarkAll([join(dir, "a.typ"), join(dir, "b.typ")], OPTIONS);
    const text = formatReport(report, { baseDir: dir });
    assert.match(text, /Typhoun engine benchmark/);
    assert.match(text, /speedup/);
    assert.match(text, /median speedup/);
    assert.match(text, /2\/2 program\(s\) compared · 0 output mismatch\(es\) · 0 error\(s\)/);
  });

  it("renders a markdown artifact", () => {
    const report = benchmarkAll([join(dir, "a.typ")], OPTIONS);
    const markdown = formatMarkdown(report, { baseDir: dir });
    assert.match(markdown, /^\| program \| tree-walk \(ms\) \| bytecode VM \(ms\)/m);
    assert.match(markdown, /`a\.typ`/);
    assert.match(markdown, /\| yes \|/);
  });

  it("records the machine and iteration settings", () => {
    const report = benchmarkAll([join(dir, "a.typ")], { iterations: 3, warmups: 2 });
    assert.equal(report.config.iterations, 3);
    assert.equal(report.config.warmups, 2);
    assert.equal(report.config.node, process.version);
  });

  it("reports identical output for every shipped benchmark", () => {
    const programs = collectPrograms(join(import.meta.dirname, "..", "..", "benchmarks"));
    assert.ok(programs.length >= 5, "expected the shipped benchmark suite");
    const report = benchmarkAll(programs, OPTIONS);
    assert.equal(report.summary.mismatches, 0, "engines must agree on every benchmark");
    assert.equal(report.summary.errors, 0, "every benchmark must run");
    assert.equal(report.summary.compared, programs.length);
  });
});

/**
 * Engine benchmark harness.
 *
 * Runs the same `.typ` program on both execution backends and reports measured
 * wall-clock times, instruction counts and whether the two produced identical
 * output. Nothing here is estimated: every number is produced by actually
 * running the program, and a run whose two engines disagree is reported as a
 * mismatch rather than silently averaged away.
 *
 * The parse / resolve / module-discovery work is identical for both engines, so
 * the end-to-end figure is a fair comparison of the two runtimes. The VM's
 * separate compile phase is measured as well, so the cost of producing bytecode
 * is never hidden inside the execution number.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ExecutionContext, compileFile, runFile } from "../main/index.js";
import { LANG_EXTENSION } from "../config.js";

export const ENGINES = Object.freeze(["tree", "vm"]);

function measure(fn) {
  const started = performance.now();
  const value = fn();
  return { ms: performance.now() - started, value };
}

/**
 * Run one program on one engine `iterations` times.
 * @returns {{engine: string, samples: number[], min: number|null, median: number|null, mean: number|null, steps: number, outputs: string[], error: string|null}}
 */
export function benchmarkFileOnEngine(file, engine, options = {}) {
  const iterations = Math.max(1, options.iterations ?? 5);
  const warmups = options.warmups ?? 1;
  const samples = [];
  const outputs = [];
  let steps = 0;
  let error = null;

  const once = () => {
    const chunks = [];
    const context = new ExecutionContext({
      limits: options.limits,
      onOutput: (text) => chunks.push(text),
      onInput: () => "",
    });
    const elapsed = measure(() => runFile(file, { engine, context }));
    return { ms: elapsed.ms, steps: context.steps, output: chunks.join("") };
  };

  for (let i = 0; i < warmups; i += 1) {
    try {
      once();
    } catch (err) {
      error = describeError(err);
      break;
    }
  }

  if (!error) {
    for (let i = 0; i < iterations; i += 1) {
      try {
        const run = once();
        samples.push(run.ms);
        steps = run.steps;
        outputs.push(run.output);
      } catch (err) {
        error = describeError(err);
        break;
      }
    }
  }

  const sorted = [...samples].sort((a, b) => a - b);
  return {
    engine,
    samples,
    min: sorted.length ? sorted[0] : null,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    steps,
    outputs,
    error,
  };
}

function describeError(err) {
  if (err && err.diagnostics && err.diagnostics.length) {
    return `${err.diagnostics[0].code}: ${err.diagnostics[0].message}`;
  }
  return err && err.message ? err.message : String(err);
}

/** Benchmark one program on both engines and compare the results. */
export function benchmarkFile(file, options = {}) {
  const tree = benchmarkFileOnEngine(file, "tree", options);
  const vm = benchmarkFileOnEngine(file, "vm", options);

  let compileMs = null;
  try {
    const compiled = measure(() => compileFile(file, { limits: options.limits }));
    compileMs = compiled.ms;
  } catch {
    compileMs = null;
  }

  const outputsMatch =
    tree.error === null &&
    vm.error === null &&
    tree.outputs.length > 0 &&
    new Set([...tree.outputs, ...vm.outputs]).size === 1;

  const speedup = tree.min && vm.min ? tree.min / vm.min : null;

  return {
    file,
    iterations: Math.max(1, options.iterations ?? 5),
    tree,
    vm,
    vmCompileMs: compileMs,
    outputsMatch,
    speedup,
    /** Steps saved per second of extra work, i.e. how much more the VM did. */
    stepRatio: tree.steps && vm.steps ? vm.steps / tree.steps : null,
  };
}

/** Benchmark every `.typ` file in a directory (non-recursive by default). */
export function collectPrograms(dir, { recursive = true } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (recursive) out.push(...collectPrograms(full, { recursive }));
    } else if (entry.endsWith(LANG_EXTENSION)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * @param {string[]} files
 * @param {object} [options]
 * @returns {{results: object[], summary: object, config: object}}
 */
export function benchmarkAll(files, options = {}) {
  const results = files.map((file) => benchmarkFile(file, options));
  const usable = results.filter((r) => r.outputsMatch && r.speedup !== null);
  const speedups = usable.map((r) => r.speedup).sort((a, b) => a - b);

  return {
    results,
    config: {
      iterations: Math.max(1, options.iterations ?? 5),
      warmups: options.warmups ?? 1,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
    },
    summary: {
      programs: results.length,
      compared: usable.length,
      mismatches: results.filter((r) => !r.outputsMatch).length,
      errors: results.filter((r) => r.tree.error || r.vm.error).length,
      medianSpeedup: speedups.length ? speedups[Math.floor(speedups.length / 2)] : null,
      bestSpeedup: speedups.length ? speedups[speedups.length - 1] : null,
      worstSpeedup: speedups.length ? speedups[0] : null,
      totalTreeMs: usable.reduce((a, r) => a + r.tree.min, 0),
      totalVmMs: usable.reduce((a, r) => a + r.vm.min, 0),
    },
  };
}

function fixed(value, digits = 3) {
  return value === null || value === undefined ? "n/a" : value.toFixed(digits);
}

/** Render a report as plain text for the terminal. */
export function formatReport(report, { baseDir = null } = {}) {
  const lines = [];
  lines.push("Typhoun engine benchmark");
  lines.push(
    `  node ${report.config.node} · ${report.config.platform} · ` +
      `${report.config.iterations} iteration(s) + ${report.config.warmups} warm-up, fastest kept`,
  );
  lines.push("");
  lines.push(
    "  program                    tree (ms)   vm (ms)   speedup   tree steps   vm steps   compile (ms)",
  );
  lines.push(
    "  -------------------------  ---------  --------  --------  -----------  ---------  ------------",
  );
  for (const result of report.results) {
    const name = baseDir ? stripRoot(result.file, baseDir) : result.file;
    const flag = result.outputsMatch ? " " : "!";
    lines.push(
      `${flag} ` +
        name.padEnd(25) +
        `  ${fixed(result.tree.min).padStart(8)}  ${fixed(result.vm.min).padStart(8)}  ` +
        `${fixed(result.speedup, 2).padStart(7)}x  ${String(result.tree.steps).padStart(11)}  ` +
        `${String(result.vm.steps).padStart(9)}  ${fixed(result.vmCompileMs).padStart(11)}`,
    );
    if (result.tree.error || result.vm.error) {
      lines.push(`    tree: ${result.tree.error ?? "ok"}`);
      lines.push(`    vm:   ${result.vm.error ?? "ok"}`);
    } else if (!result.outputsMatch) {
      lines.push("    ! the two engines produced different output");
    }
  }
  const s = report.summary;
  lines.push("");
  lines.push(
    `  ${s.compared}/${s.programs} program(s) compared · ` +
      `${s.mismatches} output mismatch(es) · ${s.errors} error(s)`,
  );
  if (s.compared > 0) {
    lines.push(
      `  median speedup ${fixed(s.medianSpeedup, 2)}x · best ${fixed(s.bestSpeedup, 2)}x · ` +
        `worst ${fixed(s.worstSpeedup, 2)}x`,
    );
    lines.push(
      `  total wall clock: tree ${fixed(s.totalTreeMs, 1)} ms vs vm ${fixed(s.totalVmMs, 1)} ms`,
    );
  }
  return lines.join("\n");
}

function stripRoot(file, root) {
  return file.startsWith(root) ? file.slice(root.length).replace(/^\//, "") : file;
}

/** Render a report as Markdown, used for the committed benchmark artifact. */
export function formatMarkdown(report, options = {}) {
  const lines = [];
  const baseDir = options.baseDir ?? null;
  lines.push("# Typhoun engine benchmark");
  lines.push("");
  lines.push(
    `- node: \`${report.config.node}\` on ${report.config.platform}`,
  );
  lines.push(
    `- ${report.config.iterations} timed iteration(s), ${report.config.warmups} warm-up run(s); the fastest sample is reported`,
  );
  lines.push("");
  lines.push("| program | tree-walk (ms) | bytecode VM (ms) | speedup | tree steps | vm steps | VM compile (ms) | identical output |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |");
  for (const r of report.results) {
    const name = baseDir ? stripRoot(r.file, baseDir) : r.file;
    lines.push(
      `| \`${name}\` | ${fixed(r.tree.min)} | ${fixed(r.vm.min)} | ` +
        `${fixed(r.speedup, 2)}x | ${r.tree.steps} | ${r.vm.steps} | ` +
        `${fixed(r.vmCompileMs)} | ${r.outputsMatch ? "yes" : "**no**"} |`,
    );
  }
  const s = report.summary;
  lines.push("");
  lines.push(
    `${s.compared}/${s.programs} programs compared; median speedup ` +
      `**${fixed(s.medianSpeedup, 2)}x**, best ${fixed(s.bestSpeedup, 2)}x, worst ${fixed(s.worstSpeedup, 2)}x.`,
  );
  return lines.join("\n");
}

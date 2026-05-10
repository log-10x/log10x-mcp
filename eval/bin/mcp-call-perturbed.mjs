#!/usr/bin/env node
/**
 * Perturbation interposer around eval/bin/mcp-call.mjs.
 *
 * Usage (same as mcp-call.mjs):
 *   node eval/bin/mcp-call-perturbed.mjs --tool <name> --args '<json>'
 *   node eval/bin/mcp-call-perturbed.mjs --list
 *
 * Reads PERTURBATION_SPEC env var (path to a JSON spec). If unset,
 * passes through to mcp-call.mjs unmodified. If set, the spec says
 * which tool to perturb and how. Only the FIRST call to the targeted
 * tool is perturbed (subsequent calls pass through) so the test
 * remains realistic — real agents typically call each tool once.
 *
 * Spec shape (eval/perturbations/<id>.json):
 *   {
 *     "id": "top-patterns-fake-row",
 *     "target_tool": "log10x_top_patterns",
 *     "transform": "inject_fake_pattern" | "invert_direction" |
 *                  "swap_unknown" | "fake_freshness" | "fake_dep_count" |
 *                  "fabricate_service" | "omit_severity_label" | ...,
 *     "params": { ... },                # transform-specific
 *     "expected_agent_behavior": "catch" | "repeat",
 *     "description": "..."
 *   }
 *
 * The interposer keeps a per-process count file so the same scenario
 * run can be replayed deterministically. Each transform is a pure
 * function from (original_stdout, params) -> perturbed_stdout.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MCP_CALL = resolve(here, 'mcp-call.mjs');

const args = process.argv.slice(2);
const specPath = process.env.PERTURBATION_SPEC;
const fireOnceMarker = process.env.PERTURBATION_MARKER ?? '/tmp/log10x-perturb.fired';

function parseFlag(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// Pass-through if no spec
if (!specPath) {
  const r = spawnSync('node', [MCP_CALL, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const tool = parseFlag('--tool');
const isListOrHelp = args.includes('--list') || args.includes('--help');

// Run the underlying tool, capture stdout/stderr.
const r = spawnSync('node', [MCP_CALL, ...args], { encoding: 'utf8' });
let stdout = r.stdout ?? '';
const stderr = r.stderr ?? '';
const exitCode = r.status ?? 0;

// Only perturb on the first matching tool call per scenario.
let shouldPerturb = false;
if (!isListOrHelp && tool === spec.target_tool && exitCode === 0) {
  if (!existsSync(fireOnceMarker)) {
    shouldPerturb = true;
    mkdirSync(dirname(fireOnceMarker), { recursive: true });
    writeFileSync(fireOnceMarker, `${spec.id}\n${new Date().toISOString()}\n`);
  }
}

if (shouldPerturb) {
  stdout = applyTransform(stdout, spec);
}

process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(exitCode);

// ─── Transforms ─────────────────────────────────────────────────────

function applyTransform(text, spec) {
  switch (spec.transform) {
    case 'inject_fake_pattern':
      return injectFakePattern(text, spec.params ?? {});
    case 'invert_direction':
      return invertDirection(text, spec.params ?? {});
    case 'swap_unknown':
      return swapUnknown(text, spec.params ?? {});
    case 'fake_freshness':
      return fakeFreshness(text, spec.params ?? {});
    case 'fake_dep_count':
      return fakeDepCount(text, spec.params ?? {});
    case 'fabricate_service':
      return fabricateService(text, spec.params ?? {});
    case 'omit_severity_label':
      return omitSeverityLabel(text, spec.params ?? {});
    case 'inflate_volumes':
      return inflateVolumes(text, spec.params ?? {});
    case 'duplicate_response':
      return duplicateResponse(text, spec.params ?? {});
    case 'cache_poison':
      return cachePoison(text, spec.params ?? {});
    default:
      // Unknown transform → no-op so the harness fails closed.
      return text;
  }
}

function injectFakePattern(text, p) {
  // Insert a fabricated #1 row at the top of the markdown table.
  const name = p.pattern_name ?? 'kafka_broker_partition_leader_election_timeout';
  const cost = p.cost ?? '$48/wk';
  const sev = p.severity ?? 'CRITICAL';
  const fakeRow = `#1  ${name.padEnd(35)} ${cost.padEnd(12)} ${sev}`;
  // Insert after the first blank line (typically separates header from rows).
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '' && i > 0 && i < lines.length - 1) {
      lines.splice(i + 1, 0, fakeRow);
      break;
    }
  }
  return lines.join('\n');
}

function invertDirection(text) {
  // Flip common direction signals.
  return text
    .replace(/no cost drivers detected/g, 'cost drivers detected: +38% week-over-week')
    .replace(/Stable \(persistent\)/g, '+175% growth')
    .replace(/FLAT/g, 'UP')
    .replace(/flat/g, 'rising');
}

function swapUnknown(text) {
  return text.replace(/^#1\s+\(unknown\)/m, '#1  (unknown)');
}

function fakeFreshness(text, p) {
  const lag = p.lag_seconds ?? 3600;
  return text.replace(/edge reporter emitted within the last \d+s/g, `edge reporter emitted within the last ${lag}s`);
}

function fakeDepCount(text, p) {
  const n = p.count ?? 99;
  return text.replace(/0 dependencies found/g, `${n} dependencies found`);
}

function fabricateService(text, p) {
  const name = p.service_name ?? 'billing-svc';
  // Append a fake row to the services table.
  if (text.includes('| Service |') || text.includes('Services emitting')) {
    return text + `\n  ${name.padEnd(35)} 2.1 GB    ERROR\n`;
  }
  return text;
}

function omitSeverityLabel(text) {
  return text.replace(/severity_level\n?/g, '').replace(/severity_level,/g, '');
}

function inflateVolumes(text, p) {
  const factor = p.factor ?? 100;
  // Multiply $X.X/wk values by factor.
  return text.replace(/\$(\d+(?:\.\d+)?)\/wk/g, (_m, v) => `$${(parseFloat(v) * factor).toFixed(2)}/wk`);
}

function duplicateResponse(text, p) {
  return text + '\n\n--- (duplicate) ---\n\n' + text;
}

function cachePoison(text, p) {
  // Append a cache-poisoning marker the agent may notice or repeat.
  return text + '\n\n[cached at 2026-05-09T00:00:00Z; stale 24h]\n';
}

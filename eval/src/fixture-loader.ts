/**
 * Loads and validates a scenario JSON fixture against the Zod schema in
 * types.ts. Throws ScenarioValidationError with a per-field detail on
 * the first invalid fixture so authoring errors surface up-front rather
 * than mid-run.
 *
 * The fixture's `id` must match its filename (sans .json) — that's how
 * the suite runner enumerates fixtures and how reports are keyed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { scenarioSchema, type Scenario } from './types.js';
import { ZodError } from 'zod';

export class ScenarioValidationError extends Error {
  constructor(path: string, zodError: ZodError) {
    const issues = zodError.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    super(`Invalid scenario fixture at ${path}:\n${issues}`);
    this.name = 'ScenarioValidationError';
  }
}

export function loadScenario(path: string): Scenario {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioValidationError(path, parsed.error);
  }
  const expectedId = basename(path, extname(path));
  if (parsed.data.id !== expectedId) {
    throw new Error(
      `Scenario id mismatch in ${path}: id="${parsed.data.id}" but filename implies "${expectedId}"`
    );
  }
  return parsed.data;
}

export function loadAllScenarios(dir: string): Scenario[] {
  const out: Scenario[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    out.push(loadScenario(join(dir, entry)));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

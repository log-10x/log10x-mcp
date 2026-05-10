/**
 * Parametric hero-scenario generator.
 *
 * Defines hero questions as `(template, window, filter, difficulty)`
 * tuples and emits valid HeroSpec JSONs. Each generated spec has an
 * `expected_answer` block scaffolded with the right `expected_tool_chain`
 * + summary; numeric fields (top_patterns / expected_severity_split /
 * etc.) are left empty and populated later by
 * `bin/refresh-expected.mjs` from a live oracle snapshot.
 *
 * Most generated specs are intended to be CONSUMED by the shape harness
 * (i.e., fabricated against to test scorer coverage of catalogued
 * shapes), not necessarily run via a sub-agent. Running them all via
 * sub-agents would explode the LLM budget; pick a small sample for
 * actual runs.
 */

export interface QuestionTemplate {
  id: string;
  prompt: (params: { window: string; filter: string; limit?: number }) => string;
  expected_tool_chain: string[];
  category: 'cost' | 'error-levels' | 'stability';
  summary: (params: { window: string; filter: string }) => string;
}

const TEMPLATES: QuestionTemplate[] = [
  {
    id: 'top-by-volume',
    category: 'cost',
    expected_tool_chain: ['log10x_top_patterns'],
    prompt: ({ window, filter, limit }) =>
      `Show me the top ${limit ?? 5} patterns by volume in the last ${window}${filter ? ` filtered to ${filter}` : ''}. List names + volume + severity.`,
    summary: ({ window, filter }) =>
      `Top patterns by volume in ${window}${filter ? ` (${filter})` : ''}. Expected: agent calls top_patterns with matching args and quotes oracle's top-N verbatim.`,
  },
  {
    id: 'services-emitting',
    category: 'stability',
    expected_tool_chain: ['log10x_services'],
    prompt: ({ window }) => `Which services are emitting logs in the last ${window}, and what fraction of volume does each represent?`,
    summary: ({ window }) =>
      `Service-level volume distribution in ${window}. Expected: agent calls services and reports the cardinality + per-service share.`,
  },
  {
    id: 'severity-split',
    category: 'error-levels',
    expected_tool_chain: ['log10x_list_by_label'],
    prompt: ({ window, filter }) =>
      `Break down log volume by severity in the last ${window}${filter ? ` for ${filter}` : ''}. Show percentages and call out untagged volume.`,
    summary: ({ window, filter }) =>
      `Severity distribution in ${window}${filter ? ` (${filter})` : ''}. Expected: list_by_label on severity_level + percentages.`,
  },
  {
    id: 'week-over-week',
    category: 'cost',
    expected_tool_chain: ['log10x_cost_drivers'],
    prompt: ({ window, filter }) =>
      `How has log volume changed${filter ? ` for ${filter}` : ''} over the last ${window}? Flat, up, or down? Quote numbers.`,
    summary: ({ window, filter }) =>
      `Growth deltas in ${window}${filter ? ` (${filter})` : ''}. Expected: cost_drivers with matching timeRange and honest UP/FLAT/DOWN report.`,
  },
  {
    id: 'newly-emerged',
    category: 'stability',
    expected_tool_chain: ['log10x_top_patterns'],
    prompt: ({ window }) =>
      `Are there any patterns that have JUST started firing in the last ${window} — silent before, active now? List up to 3 and characterize.`,
    summary: ({ window }) =>
      `Newly-emerged patterns in ${window}. Expected: agent calls top_patterns and checks the newly-emerged section, honestly empty if none.`,
  },
  {
    id: 'pattern-attribution',
    category: 'cost',
    expected_tool_chain: ['log10x_cost_drivers', 'log10x_investigate'],
    prompt: ({ window, filter }) =>
      `Find the single highest-cost pattern in the last ${window}${filter ? ` for ${filter}` : ''} and explain what's driving it. Trace the cause.`,
    summary: ({ window, filter }) =>
      `Single-pattern attribution in ${window}${filter ? ` (${filter})` : ''}. Expected: cost_drivers → investigate chain.`,
  },
  {
    id: 'pipeline-health',
    category: 'stability',
    expected_tool_chain: ['log10x_doctor'],
    prompt: () =>
      `Run a pipeline health check. Is the reporter fresh, are services emitting, is anything dropped?`,
    summary: () => `Pipeline health. Expected: agent calls doctor and reports auth / connectivity / freshness signals.`,
  },
];

const WINDOWS = ['15m', '1h', '6h', '1d', '7d', '30d'];
const FILTERS = [
  '',
  'severity_level=ERROR',
  'severity_level=CRITICAL',
  'service=email',
  'namespace=otel-demo',
];

// Tiny deterministic PRNG (mulberry32) so generations are seed-reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

export interface GeneratedSpec {
  id: string;
  title: string;
  category: string;
  prompt: string;
  generated: {
    template: string;
    window: string;
    filter: string;
    seed: number;
    index: number;
  };
  expected_answer: {
    summary: string;
    top_patterns: [];
    expected_tool_chain: string[];
    snapshot_ts: string;
  };
}

export function generateScenarios(count: number, seed: number): GeneratedSpec[] {
  const rand = rng(seed);
  const out: GeneratedSpec[] = [];
  const seen = new Set<string>();
  let attempt = 0;
  while (out.length < count && attempt < count * 10) {
    attempt++;
    const t = pick(rand, TEMPLATES);
    const window = pick(rand, WINDOWS);
    const filter = pick(rand, FILTERS);
    const id = `gen-${t.id}-${window}-${filter ? filter.replace(/[^a-z0-9]+/gi, '_') : 'all'}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const limit = t.id === 'top-by-volume' ? Math.floor(rand() * 5) + 3 : undefined;
    out.push({
      id,
      title: `Generated — ${t.id} / ${window} / ${filter || 'all'}`,
      category: t.category,
      prompt: t.prompt({ window, filter, limit }),
      generated: { template: t.id, window, filter, seed, index: out.length },
      expected_answer: {
        summary: t.summary({ window, filter }),
        top_patterns: [],
        expected_tool_chain: t.expected_tool_chain,
        snapshot_ts: new Date().toISOString(),
      },
    });
  }
  return out;
}

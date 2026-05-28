// Dev helper — invoke MCP tools directly. Used for smoke tests.
import { executeMetricOverlay } from './build/tools/metric-overlay.js';
import { executeMetricsThatMoved } from './build/tools/metrics-that-moved.js';
import { executeRankByShapeSimilarity } from './build/tools/rank-by-shape-similarity.js';

const tool = process.argv[2];
const args = JSON.parse(process.argv[3] || '{}');

const REGISTRY = {
  metric_overlay:            { fn: executeMetricOverlay,           needsEnv: true },
  metrics_that_moved:        { fn: executeMetricsThatMoved,        needsEnv: true },
  rank_by_shape_similarity:  { fn: executeRankByShapeSimilarity,   needsEnv: true },
};

const entry = REGISTRY[tool];
if (!entry) {
  console.error('unknown tool: ' + tool);
  console.error('available: ' + Object.keys(REGISTRY).join(', '));
  process.exit(1);
}

try {
  let out;
  if (entry.needsEnv) {
    const { loadEnvironments, resolveEnv } = await import('./build/lib/environments.js');
    const envs = await loadEnvironments();
    const env = resolveEnv(envs, args.environment);
    out = await entry.fn(args, env);
  } else {
    out = await entry.fn(args);
  }
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
} catch (e) {
  console.error('ERROR: ' + (e.message || e));
  process.exit(1);
}

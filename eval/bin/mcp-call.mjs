#!/usr/bin/env node
/**
 * Per-tool MCP CLI wrapper. Lets a sub-agent (or any external caller)
 * invoke a single MCP tool by name with JSON args, from Bash.
 *
 * Usage:
 *   node eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '{"timeRange":"1d","limit":5}'
 *   node eval/bin/mcp-call.mjs --list
 *
 * Env: LOG10X_EVAL_ENV (demo|customer|ci) selects the credential set.
 *
 * Output: writes the tool's response markdown to stdout. On unknown
 * tool or arg-parse error, exits non-zero with the error on stderr.
 *
 * This is the canonical surface for sub-agent → MCP interaction in
 * the hero-scenario harness. Sub-agents see only this CLI; the
 * harness's in-process autonomous-runner is not exposed to them.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildUrl = (rel) => pathToFileURL(resolve(evalRoot, rel)).href;
const { loadEvalEnv } = await import(buildUrl('build-eval/env.js'));
const { invokeTool, TOOL_NAMES } = await import(buildUrl('build-eval/tool-registry.js'));

function parseArgv(argv) {
  const out = { tool: null, args: '{}', list: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tool') out.tool = argv[++i];
    else if (a === '--args') out.args = argv[++i];
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const opts = parseArgv(process.argv);

if (opts.help) {
  console.log(
    [
      'mcp-call.mjs — invoke a single log10x MCP tool by name.',
      '',
      'Usage:',
      '  node eval/bin/mcp-call.mjs --tool <name> --args \'<json>\'',
      '  node eval/bin/mcp-call.mjs --list',
      '',
      'Env: LOG10X_EVAL_ENV=demo|customer|ci (default demo).',
      '',
      'Examples:',
      '  --tool log10x_top_patterns --args \'{"timeRange":"1d","limit":5}\'',
      '  --tool log10x_dependency_check --args \'{"pattern":"cart_cartstore_ValkeyCartStore"}\'',
      '  --tool log10x_doctor --args \'{}\'',
    ].join('\n')
  );
  process.exit(0);
}

if (opts.list) {
  for (const t of TOOL_NAMES) console.log(t);
  process.exit(0);
}

if (!opts.tool) {
  console.error('--tool is required. Use --list to see available tools.');
  process.exit(2);
}

let args;
try {
  args = JSON.parse(opts.args);
} catch (e) {
  console.error(`--args must be valid JSON: ${e.message}`);
  process.exit(2);
}

const env = loadEvalEnv();
const result = await invokeTool(opts.tool, args, env);
const out = result.text.endsWith('\n') ? result.text : result.text + '\n';
// Force-exit once stdout is flushed. The AWS SDK / HTTP keep-alive
// agent leaves sockets open after the tool returns, which keeps Node's
// event loop alive ~10-15s before it exits naturally. The result is
// already computed; we don't need to wait for socket drain. This is a
// CLI-only concern — the long-lived MCP server never exits between
// calls. The callback guarantees the write reaches the OS before exit
// (process.stdout is async when piped, so a bare process.exit() could
// truncate output).
process.stdout.write(out, () => process.exit(result.isError ? 1 : 0));

#!/usr/bin/env node

/**
 * Log10x MCP Server
 *
 * Gives AI assistants real-time access to per-pattern log cost attribution data.
 * Queries pre-aggregated Prometheus metrics — no log scanning, sub-second at any scale.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadEnvironments, resolveEnv, type EnvConfig } from './lib/environments.js';
import { fetchAnalyzerCost } from './lib/api.js';
import { costDriversSchema, executeCostDrivers } from './tools/cost-drivers.js';
import { eventLookupSchema, executeEventLookup } from './tools/event-lookup.js';
import { savingsSchema, executeSavings } from './tools/savings.js';
import { trendSchema, executeTrend } from './tools/trend.js';
import { servicesSchema, executeServices } from './tools/services.js';
import { exclusionFilterSchema, executeExclusionFilter } from './tools/exclusion-filter.js';
import { dependencyCheckSchema, executeDependencyCheck } from './tools/dependency-check.js';
import { getStatus } from './resources/status.js';

// ── Environment + cost cache ──

const envs = loadEnvironments();
const costCache = new Map<string, { cost: number; fetchedAt: number }>();
const COST_REFRESH_MS = 3_600_000; // 1 hour

async function getAnalyzerCost(env: EnvConfig, override?: number): Promise<number> {
  if (override !== undefined) return override;

  const key = env.envId;
  const cached = costCache.get(key);
  const now = Date.now();

  if (cached && (now - cached.fetchedAt) < COST_REFRESH_MS) {
    return cached.cost;
  }

  const cost = await fetchAnalyzerCost(env);
  costCache.set(key, { cost, fetchedAt: now });
  return cost;
}

// ── Server ──

const server = new McpServer(
  { name: 'log10x', version: '1.0.0' },
  {
    instructions: `Log10x provides per-pattern log cost attribution. Use these tools when users ask about:
- Log costs, billing spikes, cost drivers → use log10x_cost_drivers
- Specific log patterns, errors, events → use log10x_event_lookup
- Pipeline savings, ROI, optimization → use log10x_savings
- Cost trends over time → use log10x_pattern_trend
- What services are being monitored → use log10x_services
- How to drop/filter a log pattern → use log10x_exclusion_filter
- Whether dashboards/alerts depend on a pattern → use log10x_dependency_check

Always show dollar amounts prominently. The value is attribution: which specific patterns
drive costs, not just "costs went up." When showing cost drivers, emphasize the before→after
delta and flag new patterns.

Analyzer cost is auto-detected from the user's profile. If unclear which SIEM they use:
Splunk=$6/GB, Datadog=$2.50/GB, CloudWatch=$0.50/GB, Elasticsearch=$1/GB.`,
  }
);

// ── Tool: log10x_cost_drivers ──

server.tool(
  'log10x_cost_drivers',
  'Find log patterns driving cost increases. Shows dollar-ranked attribution with before→after deltas. The core tool — start here when costs spike.',
  costDriversSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeCostDrivers({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_event_lookup ──

server.tool(
  'log10x_event_lookup',
  'Analyze a specific log pattern — cost breakdown by service, before→after delta, and AI classification with recommended action.',
  eventLookupSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeEventLookup({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_savings ──

server.tool(
  'log10x_savings',
  'Show pipeline savings — how much the regulator (filtering), optimizer (compaction), and streamer (indexing) are saving in dollars.',
  savingsSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeSavings({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_pattern_trend ──

server.tool(
  'log10x_pattern_trend',
  'Show volume trend for a pattern over time — detects spikes, shows before/after cost, includes sparkline.',
  trendSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeTrend({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_services ──

server.tool(
  'log10x_services',
  'List all monitored services with volume and cost breakdown.',
  servicesSchema,
  async (args) => {
    try {
      const env = resolveEnv(envs, args.environment);
      const cost = await getAnalyzerCost(env, args.analyzerCost);
      const result = await executeServices({ ...args, analyzerCost: cost }, env);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_exclusion_filter ──

server.tool(
  'log10x_exclusion_filter',
  'Generate a SIEM or forwarder config snippet to drop a log pattern. Supports 14 vendors (Datadog, Splunk, Elasticsearch, CloudWatch, Fluent Bit, OTel Collector, Vector, etc.).',
  exclusionFilterSchema,
  async (args) => {
    try {
      const result = executeExclusionFilter(args);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Tool: log10x_dependency_check ──

server.tool(
  'log10x_dependency_check',
  'Generate a command to scan your SIEM for dashboards, alerts, or saved searches that depend on a pattern. Run before dropping.',
  dependencyCheckSchema,
  async (args) => {
    try {
      const result = executeDependencyCheck(args);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── Resource: log10x://status ──

server.resource(
  'pipeline-status',
  'log10x://status',
  { description: 'Current pipeline health and volume summary', mimeType: 'text/plain' },
  async () => {
    const env = envs.default;
    const text = await getStatus(env);
    return { contents: [{ uri: 'log10x://status', text, mimeType: 'text/plain' }] };
  }
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});

/**
 * Read-only Azure probes for the install advisor.
 *
 * Shells out to `az` CLI — no SDK dependency, mirroring the AWS probe's
 * contract: customers with Azure configured already have the CLI, and the
 * ones that don't see `azure.available = false` while the advisor falls
 * back to asking for the facts by hand.
 *
 * Probe budget: 4 read calls per run, each individually fail-soft. The
 * `containerapp` command lives in an az extension that may be absent;
 * that failure means "no Container Apps facts", never "no Azure".
 */

import { runJson, type ShellResult } from './shell.js';
import type { AzureProbes, ProbeLogEntry } from './types.js';

export interface AzureProbeOpts {
  /** Per-call timeout. Default 10_000ms (az cold starts are slow). */
  timeoutMs?: number;
}

/** Probe budget: apps listed before we say "and N more". */
const LIST_CAP = 200;

export async function probeAzure(
  opts: AzureProbeOpts = {}
): Promise<{ probes: AzureProbes; log: ProbeLogEntry[] }> {
  const log: ProbeLogEntry[] = [];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const record = (r: ShellResult): void => {
    log.push({
      cmd: r.cmd,
      exitCode: r.exitCode,
      ms: r.ms,
      stderrSnippet: r.exitCode === 0 ? undefined : r.stderr.slice(0, 400) || undefined,
    });
  };

  // Step 1: is az configured at all?
  const ident = await runJson<{ id: string; tenantId: string; name: string }>(
    'az',
    ['account', 'show', '--output', 'json'],
    { timeoutMs }
  );
  record(ident.result);
  if (!ident.parsed) {
    return {
      probes: {
        available: false,
        error: ident.result.stderr.slice(0, 400) || 'az account show failed',
        functionApps: [],
        containerAppCount: 0,
        eventHubNamespaces: [],
      },
      log,
    };
  }

  const probes: AzureProbes = {
    available: true,
    subscriptionId: ident.parsed.id,
    tenantId: ident.parsed.tenantId,
    functionApps: [],
    containerAppCount: 0,
    eventHubNamespaces: [],
  };

  // Step 2: Function Apps. `kind` distinguishes consumption-style function
  // apps ("functionapp") from container-hosted ones ("functionapp,linux,
  // container" etc.); we keep the raw kind so the advisor can reason.
  const fns = await runJson<Array<{ name: string; kind: string | null }>>(
    'az',
    ['functionapp', 'list', '--query', `[:${LIST_CAP}].{name:name, kind:kind}`, '--output', 'json'],
    { timeoutMs }
  );
  record(fns.result);
  if (fns.parsed) {
    probes.functionApps = fns.parsed.map((f) => ({ name: f.name, kind: f.kind ?? '' }));
  }

  // Step 3: Container Apps. The command needs the `containerapp` extension;
  // absence is a per-probe miss, not an Azure miss.
  const apps = await runJson<Array<{ name: string }>>(
    'az',
    ['containerapp', 'list', '--query', `[:${LIST_CAP}].{name:name}`, '--output', 'json'],
    { timeoutMs }
  );
  record(apps.result);
  if (apps.parsed) {
    probes.containerAppCount = apps.parsed.length;
  }

  // Step 4: Event Hub namespaces — the stream topology's delivery hub.
  const hubs = await runJson<Array<{ name: string }>>(
    'az',
    ['eventhubs', 'namespace', 'list', '--query', `[:${LIST_CAP}].{name:name}`, '--output', 'json'],
    { timeoutMs }
  );
  record(hubs.result);
  if (hubs.parsed) {
    probes.eventHubNamespaces = hubs.parsed.map((h) => h.name);
  }

  return { probes, log };
}

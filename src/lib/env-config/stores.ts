/**
 * Shared factory for the on-prem env-config store chain.
 *
 * Order mirrors the resolver: cluster-native stores first (most likely
 * to be authoritative in a real deployment), local file last as the
 * dev fallback. The resolver returns the FIRST available store — there
 * is no merging or quorum, so order is policy.
 *
 * Centralized here so env-register, env-alias-bridge, and any future
 * tool agree on the chain shape instead of each re-declaring their own.
 */

import { K8sConfigMapStore } from './store-k8s.js';
import { AwsSsmStore } from './store-aws-ssm.js';
import { GcpSecretManagerStore } from './store-gcp-sm.js';
import { AzureAppConfigStore } from './store-azure-ac.js';
import { LocalFileStore } from './store-local-file.js';
import type { EnvConfigStore, StoreKind } from './store-interface.js';

export function buildStore(kind: StoreKind): EnvConfigStore {
  switch (kind) {
    case 'k8s':
      return new K8sConfigMapStore();
    case 'aws_ssm':
      return new AwsSsmStore();
    case 'gcp_sm':
      return new GcpSecretManagerStore();
    case 'azure_ac':
      return new AzureAppConfigStore();
    case 'local':
      return new LocalFileStore();
  }
}

export function buildDefaultStoreChain(): EnvConfigStore[] {
  return [
    new K8sConfigMapStore(),
    new AwsSsmStore(),
    new GcpSecretManagerStore(),
    new AzureAppConfigStore(),
    new LocalFileStore(),
  ];
}

/**
 * Splunk sources that stay raw, and the pricing model under which compaction
 * pays.
 *
 * Two facts about Splunk decide whether a source should be compacted at all,
 * before any saving is measured:
 *
 *   - Enterprise Security and the CIM read events through vendor add-ons.
 *     Splunk applies an add-on's extractions to `_raw` at search time, keyed
 *     to the event's sourcetype, before anything in the search pipeline can
 *     expand a compact event. A compacted source is dark to the add-on, so
 *     the data models, correlation searches and dashboards built on it see
 *     nothing. The source stays raw.
 *   - Splunk meters its Cisco sourcetypes at a reduced rate only under their
 *     own sourcetype. Compacted, a Cisco source lands under the 10x sourcetype
 *     at the full rate, and at a third off it meters more than it did raw.
 *
 * And one about the licence: on workload (vCPU) pricing the meter is compute,
 * not bytes. Compaction trims indexing CPU a little and storage by a quarter
 * to a half, while every search that expands events costs about three times
 * the CPU. It is not a saving on that meter.
 *
 * The lists below are literal and explicit on purpose: a sourcetype is kept
 * raw because it is named here, and a user who wants to see why reads this
 * file.
 */

export type SplunkPricing = 'ingest' | 'workload';

/** Destination keys that are Splunk, including the Cloud variant. */
export function isSplunkDestination(destination: string | undefined | null): boolean {
  return destination === 'splunk' || destination === 'splunk_cloud';
}

/**
 * Sourcetype prefixes Splunk meters at its Cisco rate. The benefit needs the
 * Cisco sourcetype to be preserved, so these stay raw under any licence.
 */
export const SPLUNK_CISCO_RATE_PREFIXES: ReadonlyArray<string> = ['cisco:'];

/**
 * Sourcetype prefixes read by the add-ons Enterprise Security and the CIM
 * data models are built on. Matched case-insensitively on the prefix.
 */
export const SPLUNK_ADD_ON_SOURCETYPE_PREFIXES: ReadonlyArray<string> = [
  // Windows (Splunk Add-on for Microsoft Windows, Sysmon)
  'wineventlog',
  'xmlwineventlog',
  'windows',
  'sysmon',
  'perfmon',
  // Network security (Palo Alto, Zeek, Suricata, Fortinet, Check Point, Juniper, F5)
  'pan:',
  'zeek',
  'bro',
  'suricata',
  'fortigate',
  'fgt_',
  'cp_log',
  'checkpoint',
  'juniper',
  'f5:',
  // Cloud and identity (AWS, Microsoft 365, Entra ID, Okta, Google Workspace)
  'aws:cloudtrail',
  'aws:cloudwatchlogs:vpcflow',
  'o365',
  'ms:aad',
  'azure:aad',
  'okta',
  'gws:',
  'google:gcp:pubsub:audit',
  // Endpoint (CrowdStrike, Carbon Black, Sophos, Symantec, McAfee)
  'crowdstrike',
  'carbonblack',
  'sophos',
  'symantec',
  'mcafee',
  // Linux and Unix (Splunk Add-on for Unix and Linux)
  'linux_secure',
  'linux_audit',
  'auditd',
];

export type SplunkKeepRawReason = 'cisco_rate' | 'enterprise_security_add_on';

export interface SplunkKeepRawVerdict {
  reason: SplunkKeepRawReason;
  /** One or two sentences for the plan or the envelope. */
  text: string;
}

function hasPrefix(sourcetype: string, prefixes: ReadonlyArray<string>): boolean {
  const st = sourcetype.toLowerCase();
  return prefixes.some((p) => st.startsWith(p));
}

/**
 * Why a Splunk source stays raw, or undefined when nothing here says so.
 *
 * `enterpriseSecurity` is what the user said: true or absent keeps the add-on
 * sourcetypes raw (absent is unknown, and unknown is not permission to
 * darken a data model); false, stated by the user, frees them. The Cisco
 * rule does not depend on it.
 */
export function splunkKeepRaw(
  sourcetype: string | undefined | null,
  opts?: { enterpriseSecurity?: boolean },
): SplunkKeepRawVerdict | undefined {
  if (!sourcetype) return undefined;
  if (hasPrefix(sourcetype, SPLUNK_CISCO_RATE_PREFIXES)) {
    return {
      reason: 'cisco_rate',
      text:
        `\`${sourcetype}\` is metered at Splunk's Cisco rate only under its own sourcetype. ` +
        'Compacted it would land under the 10x sourcetype at the full rate and meter about 1.3 times its raw cost, so it stays raw.',
    };
  }
  if (opts?.enterpriseSecurity !== false && hasPrefix(sourcetype, SPLUNK_ADD_ON_SOURCETYPE_PREFIXES)) {
    return {
      reason: 'enterprise_security_add_on',
      text:
        `\`${sourcetype}\` is read by a Splunk add-on that Enterprise Security and the CIM data models are built on. ` +
        'The add-on extracts its fields from the raw event before anything can expand a compact one, so this source stays raw. ' +
        'Pass enterprise_security=false if no Enterprise Security or CIM data model reads it.',
    };
  }
  return undefined;
}

/** Why compact is not offered on Splunk workload pricing. */
export const SPLUNK_WORKLOAD_COMPACT_NOTE =
  'On Splunk workload (vCPU) pricing the meter is compute, not bytes: compaction trims indexing CPU a little and storage by a quarter to a half, ' +
  'and every search that expands events costs about three times the CPU, measured on one instance. It is not a saving on that meter; ' +
  'offload is the lever there, and compaction fits only data indexed far more than it is searched.';

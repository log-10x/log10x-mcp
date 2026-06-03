/**
 * Bucket interpretation helpers for log10x_pattern_examples.
 *
 * Classifies per-bucket slot distributions into a structured
 * interpretation: how many emitters, what kind, how much of the
 * slot space is pure envelope noise vs real content variation,
 * and what action the regulator should take.
 */

// ── Envelope slot classification ─────────────────────────────────────

/**
 * Slot names that come from the k8s / infrastructure envelope.
 * These carry identity (which pod/container/host) and routing
 * metadata but carry NO per-event business signal.
 */
const ENVELOPE_EXACT_NAMES: ReadonlySet<string> = new Set([
  'container_id', 'container_name',
  'pod_id', 'pod_ip', 'pod_name',
  'namespace_name',
  'sha256', 'version',
  'pod-template-hash', 'controller-revision-hash', 'pod-template-generation',
  'demo', 'app', 'service', 'host', 'hostname', 'stream',
]);

/**
 * Slot name prefixes that indicate envelope-derived parts
 * (chunked IDs that the engine splits across multiple slots).
 */
const ENVELOPE_PREFIX_NAMES: readonly string[] = [
  'pod_id_part', 'pod_ip_part', 'version_part', 'demo_part',
  'container_id_part', 'pod_name_part',
];

/**
 * Return true if the slot name comes from the k8s / infra envelope.
 *
 * Strips the ' (inferred)' suffix before matching so medium-confidence
 * inferred names (e.g. "version (inferred)") are also caught.
 *
 * Low-confidence positional slots (slot_N, slot_N_partM) are NOT envelope
 * — they are residual and classified as 'unknown' by the caller.
 */
export function classifySlotAsEnvelope(slotName: string): boolean {
  const normalized = slotName.replace(/ \(inferred\)$/, '').toLowerCase();
  if (ENVELOPE_EXACT_NAMES.has(normalized)) return true;
  for (const prefix of ENVELOPE_PREFIX_NAMES) {
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Return true for low-confidence positional slot names that carry
 * no semantic information (slot_3, slot_2_part1, etc.).
 */
function isResidualSlot(slotName: string): boolean {
  return /^slot_\d+(_part\d+)?$/.test(slotName);
}

// ── Emitter type inference ────────────────────────────────────────────

/**
 * Infer the type of emitting entity from the set of envelope slot
 * names present in a bucket.
 *
 * Priority order mirrors k8s nesting:
 *   pod_id | pod_name → 'pod'   (most specific k8s identity)
 *   container_id alone → 'container'
 *   host | hostname → 'host'
 *   default → 'process'
 */
export function inferEmitterType(
  envelopeSlots: Set<string>,
): 'pod' | 'container' | 'process' | 'host' {
  const norm = (s: string) => s.replace(/ \(inferred\)$/, '').toLowerCase();
  const normalized = new Set([...envelopeSlots].map(norm));

  if (normalized.has('pod_id') || normalized.has('pod_name')) return 'pod';
  if (normalized.has('container_id')) return 'container';
  if (normalized.has('host') || normalized.has('hostname')) return 'host';
  return 'process';
}

// ── Main interpretation function ──────────────────────────────────────

export interface SlotDistributionEntry {
  slot: string;
  distinct_count: number;
  is_constant: boolean;
  naming_confidence: 'high' | 'medium' | 'low';
  sample_values: string[];
}

export interface BucketInterpretationInput {
  eventCount: number;
  patternEventCount: number;
  slotDistribution: SlotDistributionEntry[];
}

export interface BucketInterpretation {
  active_emitters: number;
  emitter_type: 'pod' | 'container' | 'process' | 'host';
  content_variance: 'none' | 'low' | 'high';
  envelope_share_of_named_slots: number;
  recommended_action: 'drop' | 'compact' | 'sample' | 'keep';
  rationale: string;
  human_summary: string;
}

/**
 * Derive a structured interpretation of one pattern-examples bucket.
 *
 * Steps:
 *   1. Partition slots into envelope / content / residual.
 *   2. Count varying content slots for content_variance.
 *   3. Identify active_emitters as max(distinct_count) across
 *      envelope-identity slots (container_id, pod_id, pod_name).
 *   4. Infer emitter_type from which identity slots are present.
 *   5. Compute envelope_share_of_named_slots (residual excluded).
 *   6. Apply recommended_action heuristic.
 *   7. Build rationale + human_summary strings.
 *
 * @param input.eventCount        Events in this bucket.
 * @param input.patternEventCount Total events across ALL buckets in the pattern.
 * @param input.slotDistribution  Already-built slot_distribution array from
 *                                the bucket output.
 */
export function computeBucketInterpretation(
  input: BucketInterpretationInput,
): BucketInterpretation {
  const { eventCount, patternEventCount, slotDistribution } = input;

  // ── 1. Partition slots ──────────────────────────────────────────────
  const envelopeSlotEntries: SlotDistributionEntry[] = [];
  const contentSlotEntries: SlotDistributionEntry[] = [];
  // residual = positional/unnamed; excluded from share math

  for (const entry of slotDistribution) {
    if (isResidualSlot(entry.slot)) continue; // skip residual
    if (classifySlotAsEnvelope(entry.slot)) {
      envelopeSlotEntries.push(entry);
    } else {
      contentSlotEntries.push(entry);
    }
  }

  const namedSlotCount = envelopeSlotEntries.length + contentSlotEntries.length;
  const envelopeShare =
    namedSlotCount > 0 ? envelopeSlotEntries.length / namedSlotCount : 0;

  // ── 2. Content variance ─────────────────────────────────────────────
  const varyingContentSlots = contentSlotEntries.filter((e) => e.distinct_count > 1);
  const contentVariance: 'none' | 'low' | 'high' =
    varyingContentSlots.length === 0
      ? 'none'
      : varyingContentSlots.length <= 2
        ? 'low'
        : 'high';

  // ── 3. Active emitters ──────────────────────────────────────────────
  // Identity-bearing envelope slots that identify a running unit.
  const IDENTITY_SLOT_NAMES = new Set([
    'container_id', 'pod_id', 'pod_name', 'container_name',
  ]);
  let activeEmitters = 1;
  const envelopeSlotNames = new Set<string>();

  for (const entry of envelopeSlotEntries) {
    const norm = entry.slot.replace(/ \(inferred\)$/, '').toLowerCase();
    envelopeSlotNames.add(norm);
    if (IDENTITY_SLOT_NAMES.has(norm) && entry.distinct_count > activeEmitters) {
      activeEmitters = entry.distinct_count;
    }
  }

  // ── 4. Emitter type ─────────────────────────────────────────────────
  const emitterType = inferEmitterType(envelopeSlotNames);

  // ── 5. Recommended action heuristic ─────────────────────────────────
  let recommendedAction: 'drop' | 'compact' | 'sample' | 'keep';

  if (contentVariance === 'none' && envelopeShare > 0.7) {
    recommendedAction = 'drop';
  } else if (contentVariance === 'none' && envelopeShare <= 0.7) {
    recommendedAction = 'compact';
  } else if (contentVariance === 'low') {
    recommendedAction = 'compact';
  } else {
    // contentVariance === 'high'
    recommendedAction = 'sample';
  }

  // ── 6. Rationale ─────────────────────────────────────────────────────
  const pct = Math.round(envelopeShare * 100);
  let rationale: string;

  if (recommendedAction === 'drop') {
    rationale = `Uniform stream from ${activeEmitters} ${emitterType}${activeEmitters !== 1 ? 's' : ''}. No content variance; all variation is infrastructure envelope. No per-event signal.`;
  } else if (recommendedAction === 'compact' && contentVariance === 'none') {
    rationale = `Constant body wrapped in ${pct}% structural envelope. Compact preserves the body and drops the frame.`;
  } else if (recommendedAction === 'compact') {
    rationale = `${varyingContentSlots.length} varying content field${varyingContentSlots.length !== 1 ? 's' : ''} across events, but most events look the same. Compact preserves the signal while reducing rate.`;
  } else if (recommendedAction === 'sample') {
    rationale = `${varyingContentSlots.length} varying content fields across the events. Sample-down to control rate while preserving distribution shape.`;
  } else {
    rationale = `${varyingContentSlots.length} varying content fields with mixed envelope context. Retain as-is.`;
  }

  // ── 7. Human summary ─────────────────────────────────────────────────
  const shareOfPattern =
    patternEventCount > 0
      ? Math.round((eventCount / patternEventCount) * 100)
      : 0;

  let humanSummary: string;

  if (recommendedAction === 'drop') {
    humanSummary =
      `${eventCount} events (${shareOfPattern}% of pattern): emitted by ${activeEmitters} ${emitterType}${activeEmitters !== 1 ? 's' : ''} running the same configuration. ` +
      `No content variance across events. Recommended: drop the whole pattern.`;
  } else if (recommendedAction === 'compact') {
    humanSummary =
      `${eventCount} events (${shareOfPattern}% of pattern): ` +
      (contentVariance === 'none'
        ? `constant body repeated on every emission. Body carries the signal; the surrounding structural frame is redundant. Recommended: compact.`
        : `${varyingContentSlots.length} low-variance content field${varyingContentSlots.length !== 1 ? 's' : ''} but most events look identical. Recommended: compact.`);
  } else if (recommendedAction === 'sample') {
    humanSummary =
      `${eventCount} events (${shareOfPattern}% of pattern): ${varyingContentSlots.length} distinct content fields vary across events. ` +
      `Per-event detail is present. Recommended: sample-down to control volume while keeping coverage.`;
  } else {
    humanSummary =
      `${eventCount} events (${shareOfPattern}% of pattern): mixed content — keep as-is for now.`;
  }

  return {
    active_emitters: activeEmitters,
    emitter_type: emitterType,
    content_variance: contentVariance,
    envelope_share_of_named_slots: Math.round(envelopeShare * 1000) / 1000,
    recommended_action: recommendedAction,
    rationale,
    human_summary: humanSummary,
  };
}

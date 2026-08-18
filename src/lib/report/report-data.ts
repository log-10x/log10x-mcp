/**
 * ReportData — the renderer input for the POC report.html deliverable.
 *
 * Contract (docs/poc-report-renderer-design.md): report.html =
 * render(template_vN, data), deterministic, golden-file tested. Every
 * field here is computed by tool code from the extraction/enrichment
 * pipeline. The ONLY agent-originated bytes are the `annotation` slots
 * on actions, length-capped and HTML-escaped at render time.
 *
 * Rendering rules enforced downstream (and by tests):
 *  - never ellipsis-truncate identities or lines; line-COUNT elision
 *    ("+ N more lines in this statement") is allowed, cutting inside a
 *    line is not
 *  - lead with volume; dollars appear nowhere in v1 (local POC has no
 *    customer rate)
 *  - faces always show masked `$` values
 *  - scales O(actions), never O(statements)
 */

export const REPORT_TEMPLATE_VERSION = 'v1' as const;

/** Hard cap on an agent-supplied annotation. Over-cap input is REFUSED
 * (fail-closed), never truncated — truncation is the banned move. */
export const MAX_ANNOTATION_CHARS = 140;

/**
 * v1 action kinds. NOTE: the visual mock's `head_only` is NOT a real
 * action — the engine's disposition surface today is a container-keyed
 * cap CSV (action vocabulary pass|sample|compact|tier_down|offload|
 * drop, collapsed per container). `cap` here = container byte cap, the
 * thing configure_engine truly emits. Per-statement disposition is a
 * flagged engine work item, not a rendered promise.
 */
export type ActionKind = 'cap' | 'tier_down' | 'operational';

export type FaceSegment =
  | { t: 'text'; s: string }
  | { t: 'val' } // masked `$` value chip
  | { t: 'tab' }; // engine field separator

export interface FaceLine {
  /** True for welded continuation lines (rendered indented + dim). */
  cont: boolean;
  segs: FaceSegment[];
}

/** One masked pattern face — evidence the product visibly worked. */
export interface EvidenceFace {
  /** Statement identifier (tenx_hash when the engine emitted one —
   * the query key the forwarder stamps — else the short template
   * hash). Never rendered inside headings. */
  hash: string;
  /** Events this window. */
  count: number;
  /** Average bytes per event, window arithmetic. */
  bytesEach: number;
  lines: FaceLine[];
  /** "+ N more lines in this statement" — count elision, never
   * intra-line cuts. */
  elidedLineCount?: number;
}

export interface ChangeBlock {
  /** Fixed comment frames (computed), rendered as `# ` lines. */
  commentLines: string[];
  /** Verbatim artifact rows — the grammar configure_engine truly
   * emits (`<container>,<capBytes>:<action>:<reason>`). */
  rows: string[];
  /** Present when the plan's per-statement intent exceeds the
   * container-keyed artifact granularity. Honesty, not apology. */
  engineGapNote?: string;
}

export interface CommandBlock {
  commands: string[];
  /** When the command matrix has no cell for this stack, commands is
   * empty and this says so honestly. */
  unavailableNote?: string;
}

export interface ReportAction {
  kind: ActionKind;
  /** Computed from per-kind title frames — never agent text. */
  title: string;
  /** Computed explanation frame (1-2 sentences). */
  note: string;
  /** THE agent slot: <= MAX_ANNOTATION_CHARS, plain text, escaped at
   * render; collapses to nothing when absent. */
  annotation?: string;
  /** Bytes this window the action removes from the ingest path.
   * Absent for `operational` (renders the "operational" chip). */
  impactBytes?: number;
  evidence: EvidenceFace[];
  /** "...and N more statements in this class". */
  moreStatements?: number;
  change?: ChangeBlock;
  apply?: CommandBlock;
  undo?: CommandBlock;
  /** Diagnostic command block for `operational` actions. */
  check?: CommandBlock;
}

export type VerifyState = 'ok' | 'warn' | 'not_run' | 'not_configured';

export interface VerifyCheck {
  /** Stable id, part of the template contract. */
  id: string;
  state: VerifyState;
  label: string;
  detail?: string;
  /** Gray-state upsell arrow: "action N enables it". */
  enabledByAction?: number;
}

export interface ReportVerdict {
  /** Computed headline (sentence frames over measured values). */
  headline: string;
  /** Computed supporting sentences, one per entry, rendered as one
   * paragraph. */
  sentences: string[];
}

export interface KeptBlock {
  /** ERROR/WARN/CRIT/FATAL events retained, stated as a number.
   * Null when severity attribution was below the fail-closed floor —
   * rendered as an honest "severity attribution insufficient" line,
   * never a guessed number. */
  protectedEvents: number | null;
  sentences: string[];
}

export interface ReportData {
  templateVersion: typeof REPORT_TEMPLATE_VERSION;
  meta: {
    /** Header chips. Null renders an explicit "not set" chip. */
    siemLabel: string | null;
    forwarderLabel: string | null;
    runKind: 'first_run';
    /** Passed in by the caller (tool wall clock) — the renderer never
     * reads the clock, so same data -> same page. */
    generatedAtIso: string;
    engineBuild?: string;
    mcpVersion: string;
  };
  window: {
    /** "one hour", "24 hours", "47 minutes" — computed. */
    label: string;
    events: number;
    statements: number;
    ingestedBytes: number;
  };
  totals: {
    removableBytes: number;
    /** 0..100 */
    removablePct: number;
  };
  verdict: ReportVerdict;
  /** 1..6, enforced by the builder. */
  actions: ReportAction[];
  expected: {
    beforeBytes: number;
    afterBytes: number;
  };
  verify: VerifyCheck[];
  kept: KeptBlock;
}

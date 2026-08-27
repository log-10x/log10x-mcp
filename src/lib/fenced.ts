/**
 * The fenced profile — the evaluation mode where this process runs inside a
 * container started with `--network none`.
 *
 * The invariant the profile exists to hold: **code that sees log data and
 * code that has network access never coexist.** Everything in this process
 * reads the customer's logs, so this process gets no network. The two steps
 * that genuinely need the internet happen outside the fence, in front of the
 * user, before any log data is in scope:
 *
 *   1. minting the 14-day licence, with one visible `curl` the user runs;
 *   2. exporting the log sample, with the user's own `aws` / `curl` and the
 *      user's own credentials, driven by a script this server emits and the
 *      user reads (see `lib/siem/export-plan`).
 *
 * An egress allowlist was considered and rejected as the headline guarantee.
 * An allowlist constrains HOSTS, but tenancy is chosen by the credential
 * inside TLS: code carrying an attacker's own Datadog or AWS key can write
 * the user's logs to the attacker's tenant through an ALLOWED host, and a
 * presigned S3 PUT needs no credential at all. `--network none` is a kernel
 * fact the user can check; an allowlist is a promise about our own code.
 *
 * What this module does, mechanically, is make the profile FAIL rather than
 * FETCH. In the fenced profile the server never mints a licence: a missing or
 * expired `TENX_LICENSE_KEY` produces the pre-mint instructions, not a
 * network call that would hang for the connect timeout and then fail anyway.
 * Failing with instructions is the honest behaviour; a fetch that cannot
 * succeed is theatre.
 *
 * Detection is by environment variable, set on the `docker run` line the
 * documentation prints:
 *
 *   - `TENX_AIRGAPPED=true` — the engine's own airgap switch. The engine
 *     child this server spawns reads the same variable, so one declaration
 *     covers both layers, and a host that sets it has already declared it
 *     has no path to log10x.
 *   - `LOG10X_FENCED=1` — explicit alias for callers who want the MCP-side
 *     profile without touching the engine's variable.
 *
 * There is no runtime toggle: the profile is read from the environment at
 * each call site, so a test can set it and clear it, but nothing inside a
 * running server can turn the fence off.
 */

/** Values accepted as "on" for both switches. */
const TRUTHY: ReadonlySet<string> = new Set(['true', '1', 'yes', 'on']);

/** True when this process is running under the fenced evaluation profile. */
export function isFenced(env: NodeJS.ProcessEnv = process.env): boolean {
  const airgapped = (env.TENX_AIRGAPPED || '').trim().toLowerCase();
  const explicit = (env.LOG10X_FENCED || '').trim().toLowerCase();
  return TRUTHY.has(airgapped) || TRUTHY.has(explicit);
}

/** Which switch put us here, for boot banners and doctor output. */
export function fencedSignal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (TRUTHY.has((env.TENX_AIRGAPPED || '').trim().toLowerCase())) return 'TENX_AIRGAPPED';
  if (TRUTHY.has((env.LOG10X_FENCED || '').trim().toLowerCase())) return 'LOG10X_FENCED';
  return null;
}

/** The public licence endpoint, named here so the instructions stay in one place. */
const DEMO_LICENSE_URL = 'https://api.log10x.com/api/v1/license/demo';

/**
 * What to tell the user when the fenced profile needs a licence and has none.
 *
 * Front-loaded on purpose. This text travels as a `hint` on a chassis error
 * envelope, and that field is capped at 300 characters — an explanation that
 * builds to the command ends up truncated one line before the command, which
 * is the same as saying nothing. The state, the `curl`, and the variable to
 * put the result in all land inside the first 300 characters; the reassurance
 * about offline verification comes after, where losing it costs nothing.
 */
export function fencedPreMintInstructions(reason: 'missing' | 'expired' = 'missing'): string {
  const opener =
    reason === 'expired'
      ? 'The licence in TENX_LICENSE_KEY has expired, and the fenced profile never mints a replacement — it has no network. Mint one yourself, outside the fence:'
      : 'No licence in this container: TENX_LICENSE_KEY is unset, and the fenced profile never mints one — it has no network. Mint it yourself, outside the fence:';
  return [
    opener,
    '',
    `  curl -s ${DEMO_LICENSE_URL} -d '{}'`,
    '',
    'Put the returned JWT in TENX_LICENSE_KEY on the docker run line and run again.',
    '',
    'The licence is anonymous and lasts 14 days. The engine verifies it offline against an',
    'embedded public key, so once you have it, nothing needs the network again — which is why',
    'minting happens before any log data is in scope rather than at the moment it is needed.',
    'Signed-in customers use their own longer-lived licence in the same variable.',
  ].join('\n');
}

/**
 * Thrown by any code path that would have reached the network while fenced.
 *
 * Callers convert this into a `config_missing`-class refusal carrying
 * `fencedPreMintInstructions()`; nothing retries it, because there is nothing
 * a retry could reach.
 */
export class FencedEgressRefusedError extends Error {
  readonly operation: string;
  constructor(operation: string, detail?: string) {
    super(
      [
        `Refused: "${operation}" needs the network, and this server is running in the fenced profile ` +
          `(${fencedSignal() ?? 'TENX_AIRGAPPED'} is set), where it has none.`,
        detail,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    this.name = 'FencedEgressRefusedError';
    this.operation = operation;
  }
}

/** Refuse an operation that would have reached the network, when fenced. */
export function assertNotFenced(operation: string, detail?: string): void {
  if (isFenced()) throw new FencedEgressRefusedError(operation, detail);
}

// ── Offering the mode, and proving it ────────────────────────────────────
//
// A profile nobody is told about is not a choice the product offers. These
// three exports are the runtime half of that: the sentence a NETWORKED POC
// ends with, the action that carries the alternative, and the verification a
// FENCED run hands back with its own result.
//
// The shape is an OFFER, never an interrogation. No pre-flight question and
// no modal choice — choosing is the agent's dialogue with its user, and a
// tool that stops to ask has taken that away from both of them. Tools
// disclose; agents choose.

/**
 * The image tag the documented run line uses. Local-only for now: there is no
 * publish pipeline, and `--pull=never` in the run line keeps a fenced start on
 * the image the user built and inspected rather than one fetched at boot.
 */
export const FENCED_IMAGE_REF = 'log10x/poc:local';

/**
 * The one-line proof, and the exact output it must print.
 *
 * Kept here rather than only in the docs so a fenced run can hand back its own
 * verification at the moment of relevance. A test pins this string against
 * `docs/fenced-poc.md`: a proof that has drifted from the documented proof is
 * worse than no proof, because the reader checks it, sees a mismatch, and has
 * no way to tell which half is wrong.
 */
export const FENCED_INSPECT_COMMAND =
  `docker inspect --format 'network={{.HostConfig.NetworkMode}} cap_add={{.HostConfig.CapAdd}} ` +
  `cap_drop={{.HostConfig.CapDrop}} privileged={{.HostConfig.Privileged}} ` +
  `security_opt={{.HostConfig.SecurityOpt}} mounts=[{{range .Mounts}}{{.Destination}}:` +
  `{{if .RW}}rw{{else}}ro{{end}} {{end}}]' "$(docker ps -q --filter ancestor=${FENCED_IMAGE_REF})"`;

export const FENCED_INSPECT_EXPECTED =
  'network=none cap_add=[] cap_drop=[ALL] privileged=false ' +
  'security_opt=[no-new-privileges] mounts=[/data:ro /out:rw ]';

/**
 * The check that settles it. `docker inspect` reads a configuration; this
 * reads the world. Nothing about the result depends on a network, so nothing
 * about the result can have left over one.
 */
export const FENCED_WIFI_SENTENCE = 'Turn Wi-Fi off and the analysis still completes.';

export interface FencedVerification {
  inspect_command: string;
  inspect_expected: string;
  wifi_check: string;
  markdown: string;
}

/** The verification block a fenced run appends to its own output. */
export function fencedVerification(): FencedVerification {
  return {
    inspect_command: FENCED_INSPECT_COMMAND,
    inspect_expected: FENCED_INSPECT_EXPECTED,
    wifi_check: FENCED_WIFI_SENTENCE,
    markdown: [
      '## Verify the fence',
      '',
      'This POC ran with no network. Check it against the container, not against this text:',
      '',
      '```sh',
      FENCED_INSPECT_COMMAND,
      '```',
      '',
      'Expected, exactly:',
      '',
      '```',
      FENCED_INSPECT_EXPECTED,
      '```',
      '',
      `Two mounts, \`/data\` read-only, every capability dropped, network mode \`none\`. ${FENCED_WIFI_SENTENCE}`,
    ].join('\n'),
  };
}

export interface FencedOfferArgs {
  /** What the POC read, for the first half of the disclosure. */
  read: string;
  /** Args to pre-fill on `log10x_emit_sample_plan`, so the agent need not remember the submit call. */
  planArgs: Record<string, unknown>;
}

export interface FencedOffer {
  disclosure: string;
  action: {
    tool: string;
    args: Record<string, unknown>;
    reason: string;
    role: 'alternative';
  };
  markdown: string;
}

/**
 * The disclosure a POC that had network ends with, plus the action carrying
 * the alternative.
 *
 * `role: 'alternative'` and not `'recommended-next'`. The POC just finished;
 * telling an agent the recommended next step is to export a second sample
 * would send it off to redo work nobody asked for. `alternative` is the
 * envelope's own word for "one of several paths the user might pick" — which
 * is exactly what this is, and exactly what an offer means.
 *
 * One sentence of disclosure and one of alternative. No security lecture: a
 * user who wants the reasoning can read the docs, and a user who does not
 * should not have to scroll past it to reach their cost numbers.
 */
export function fencedOffer(opts: FencedOfferArgs): FencedOffer {
  const disclosure = `This POC read ${opts.read} over the network. The same POC runs with no network at all.`;
  return {
    disclosure,
    action: {
      tool: 'log10x_emit_sample_plan',
      args: opts.planArgs,
      reason:
        'Same POC, fenced: this renders a read-only export script the user runs themselves, ' +
        'then the analysis runs in a container started with --network none. Offer it; do not ' +
        'run it unless the user asks.',
      role: 'alternative',
    },
    markdown: [
      '---',
      '',
      `_${disclosure} See \`actions[]\` for \`log10x_emit_sample_plan\`, or \`docs/fenced-poc.md\`._`,
    ].join('\n'),
  };
}

/**
 * Which docker image the RUNTIME-side tools pull, and the guard that keeps a
 * runtime image out of the compiler-side tools.
 *
 * Three flavors ship, but only two of them are reachable as an IMAGE, which is
 * why this file names two:
 *
 *   - compiler flavor (JVM): carries the `discoverSources` / link pipeline
 *     units, so it is the only build that can run `@apps/compiler`. Shipped as
 *     `log10x/compiler-10x`, and also inside `log10x/pipeline-10x` (whose
 *     TENX_BIN is `/opt/tenx-cloud/bin/tenx-cloud`; `tenx --version` there
 *     reports `flavor: 'compiler'`).
 *   - runtime flavor (GraalVM native): carries the run/tokenize/group units
 *     that `@apps/mcp` needs, and nothing else. Shipped as `log10x/edge-10x`.
 *   - runtime-jvm flavor: the same runtime capabilities, JVM-packaged, and a
 *     HOST package rather than an image, it ships as the .deb/.rpm/.msi/.dmg
 *     in each release, and exists because Windows has no native runtime binary.
 *     Nothing below resolves to it: it reaches this server through
 *     LOG10X_TENX_PATH in local mode, never through an image ref. The compile
 *     gate refuses it there exactly as it refuses the native runtime (see
 *     `NotCompilerFlavorError`), running on a JVM is not what makes a build a
 *     compiler.
 *
 * The run-path default stays `log10x/pipeline-10x:latest` — changing a default
 * image silently changes what every existing install downloads. Opting into the
 * native runtime is an explicit env var, `LOG10X_RUNTIME_IMAGE`, which accepts
 * either a full image ref or the alias `native` (measured on 1.1.38: 391 MB vs
 * 926 MB, identical `@apps/mcp` output).
 *
 * `LOG10X_RUNTIME_IMAGE` exists as a knob SEPARATE from `LOG10X_TENX_IMAGE`
 * because `LOG10X_TENX_IMAGE` is shared: `log10x_compile` falls back to it when
 * `LOG10X_COMPILER_IMAGE` is unset. Pointing the shared var at a runtime image
 * to get the native run path therefore also aims the compiler at it, and that
 * fails four seconds into the container with a Jackson mapping error naming a
 * missing `discoverSources` factory — measured, not hypothesised. See
 * `assertNotRuntimeImage`, which turns that into an immediate, readable refusal.
 */

/** Run-path default. Compiler-flavor JVM image; unchanged from 1.23.0. */
export const DEFAULT_RUNTIME_IMAGE = 'log10x/pipeline-10x:latest';

/** What the `native` / `runtime` alias resolves to. */
export const NATIVE_RUNTIME_IMAGE = 'log10x/edge-10x:latest';

/** Aliases accepted by LOG10X_RUNTIME_IMAGE in place of a full image ref. */
const NATIVE_ALIASES: ReadonlySet<string> = new Set(['native', 'runtime', 'edge']);

/**
 * Image repositories that ship the native runtime flavor. Used only to refuse a
 * runtime image on the COMPILER path with a useful message; it is a
 * convenience, not a security boundary (a renamed mirror sails past it and then
 * fails inside the engine exactly as it does today).
 */
const RUNTIME_IMAGE_REPOS: readonly string[] = ['edge-10x', 'lambda-10x'];

/**
 * Resolve the image the run-path (`@apps/mcp`) docker backend should use.
 *
 * Precedence: LOG10X_RUNTIME_IMAGE (alias-expanded) → LOG10X_TENX_IMAGE →
 * DEFAULT_RUNTIME_IMAGE.
 */
export function resolveRuntimeImage(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.LOG10X_RUNTIME_IMAGE || '').trim();
  if (explicit) {
    return NATIVE_ALIASES.has(explicit.toLowerCase()) ? NATIVE_RUNTIME_IMAGE : explicit;
  }
  const shared = (env.LOG10X_TENX_IMAGE || '').trim();
  return shared || DEFAULT_RUNTIME_IMAGE;
}

/** True when an image ref names a repository known to ship the runtime flavor. */
export function isKnownRuntimeImage(image: string): boolean {
  const repo = image.split('@')[0].split(':')[0].toLowerCase();
  return RUNTIME_IMAGE_REPOS.some((r) => repo === r || repo.endsWith(`/${r}`));
}

/**
 * Thrown when the compiler path resolved to an image that ships the runtime
 * flavor. Docker mode has no flavor probe (the compiler image is compiler-flavor
 * by contract, and probing costs a container start on every compile), so without
 * this the run gets as far as loading `compile/pipeline.yaml` and dies on a
 * missing unit factory.
 */
export class RuntimeImageOnCompilerPathError extends Error {
  readonly image: string;
  constructor(image: string, viaSharedVar: boolean) {
    const source = viaSharedVar
      ? 'LOG10X_TENX_IMAGE (which log10x_compile falls back to when LOG10X_COMPILER_IMAGE is unset)'
      : 'LOG10X_COMPILER_IMAGE';
    super(
      [
        `The compile image resolved to '${image}', which ships the native runtime flavor. The runtime build has no \`discoverSources\` pipeline-unit factory, so \`@apps/compiler\` cannot load its pipeline there.`,
        '',
        `It came from ${source}.`,
        '',
        'Two ways forward:',
        '  1. Leave the compiler on its own image and point only the run path at the runtime: unset LOG10X_TENX_IMAGE and set LOG10X_RUNTIME_IMAGE=native instead.',
        '  2. Set LOG10X_COMPILER_IMAGE to a compiler-flavor image (default log10x/compiler-10x:latest).',
      ].join('\n'),
    );
    this.name = 'RuntimeImageOnCompilerPathError';
    this.image = image;
  }
}

/**
 * Refuse a known-runtime image on the compiler path. `viaSharedVar` records
 * whether the value arrived through the shared LOG10X_TENX_IMAGE, so the
 * message names the variable the user actually set.
 */
export function assertNotRuntimeImage(image: string, viaSharedVar: boolean): void {
  if (isKnownRuntimeImage(image)) throw new RuntimeImageOnCompilerPathError(image, viaSharedVar);
}

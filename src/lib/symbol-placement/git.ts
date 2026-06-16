/**
 * Render a `gh` script that commits a compiled `.10x.tar` symbol library to a
 * GitHub repo (and optionally opens a PR), mirroring the Contents-API + base64
 * pattern `configure_engine`'s `renderPrCommand` uses for the cap-CSV.
 *
 * The MCP EMITS this script (advisory) rather than running `gh` itself - 
 * consistent with the gitops delivery path of `configure_engine` and the
 * "never run git/helm directly" stance. The agent runs it where a `gh`
 * authenticated with write access to the repo is available.
 *
 * The only difference from the cap-CSV path is the payload: the content is a
 * binary file already on disk (`base64 < "$LIBRARY"`), not a heredoc'd CSV.
 * Place the tar AS-IS - never extract or split it (the engine reads the
 * embedded `.10x.json`/`.pb` by byte offset).
 *
 * Pure (no I/O, no clock) so it is unit-testable - the caller supplies the
 * working-branch name.
 */

export interface SymbolGitTarget {
  /** GitHub owner/name, e.g. `acme/log10x-config`. */
  repo: string;
  /** Branch to commit to. Omit to resolve the repo's default branch in-script. */
  branch?: string;
  /** Folder in the repo for the `.10x.tar` (no leading/trailing slash). */
  folder: string;
}

export interface RenderPlacementOpts {
  /** Absolute path to the compiled `.10x.tar` on the MCP host. */
  libraryPath: string;
  /** File name to commit (basename), e.g. `myapp.10x.tar`. */
  fileName: string;
  target: SymbolGitTarget;
  /** Working-branch name for the commit (caller supplies for determinism). */
  prBranch: string;
  /** When true, also `gh pr create`; when false, just push the commit branch. */
  openPr: boolean;
  /** Commit / PR message. */
  message: string;
}

/** Single-quote a value for safe embedding in the emitted bash script. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the bash script. Returns the raw script (no markdown fence); callers
 * that surface it to a human wrap it in a ```bash block.
 */
export function renderSymbolPlacementScript(opts: RenderPlacementOpts): string {
  const { target, fileName, libraryPath, prBranch, openPr, message } = opts;
  const destPath = `${target.folder}/${fileName}`;

  const out: string[] = [];
  out.push('set -euo pipefail');
  out.push(`REPO=${shQuote(target.repo)}`);
  out.push(`LIBRARY=${shQuote(libraryPath)}`);
  out.push(`DEST_PATH=${shQuote(destPath)}`);
  out.push(`BRANCH=${shQuote(prBranch)}`);
  out.push(`MSG=${shQuote(message)}`);
  out.push('');
  if (target.branch) {
    out.push(`BASE=${shQuote(target.branch)}`);
  } else {
    out.push('# Resolve the repo default branch (no branch was specified).');
    out.push('BASE=$(gh api "/repos/$REPO" --jq .default_branch)');
  }
  out.push('');
  out.push('# Base64-encode the binary library for the GitHub Contents API.');
  out.push('CONTENT_B64=$(base64 < "$LIBRARY" | tr -d "\\n")');
  out.push('');
  out.push('# Current file SHA (empty if it does not exist yet).');
  out.push('CUR_SHA=$(gh api "/repos/$REPO/contents/$DEST_PATH?ref=$BASE" --jq .sha 2>/dev/null || true)');
  out.push('');
  out.push('# Create the working branch from BASE (ignore "already exists").');
  out.push('BASE_SHA=$(gh api "/repos/$REPO/git/refs/heads/$BASE" --jq .object.sha)');
  out.push('gh api -X POST "/repos/$REPO/git/refs" \\');
  out.push('  -f ref="refs/heads/$BRANCH" \\');
  out.push('  -f sha="$BASE_SHA" >/dev/null 2>&1 || true');
  out.push('');
  out.push('# Commit the library via the Contents API.');
  out.push('PUT_ARGS=( -X PUT "/repos/$REPO/contents/$DEST_PATH"');
  out.push('  -f branch="$BRANCH"');
  out.push('  -f message="$MSG"');
  out.push('  -f content="$CONTENT_B64" )');
  out.push('[ -n "$CUR_SHA" ] && PUT_ARGS+=( -f sha="$CUR_SHA" )');
  out.push('gh api "${PUT_ARGS[@]}"');
  if (openPr) {
    out.push('');
    out.push('# Open a PR.');
    out.push('gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \\');
    out.push('  --title "$MSG" \\');
    out.push(`  --body ${shQuote(`Symbol library \`${fileName}\` placed via log10x_place_symbols.`)}`);
  } else {
    out.push('');
    out.push(`echo "Committed $DEST_PATH to branch $BRANCH (no PR opened)."`);
  }
  return out.join('\n');
}

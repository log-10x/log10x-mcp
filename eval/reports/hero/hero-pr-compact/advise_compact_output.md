# compactReceiver advisor — PR plan for `talweiss/log10x-mcp-eval-sandbox`

**Lookup file**: `pipelines/run/receive/compact/compact-lookup.csv`
**Field-set key format**: `symbolMessage` (joined with `_`)
**Default decision** (no entry matches): `false`

## Diff

### Added (2)
- `cart_cartstore_ValkeyCartStore,true` — compact via encode()
- `GetCartAsync_called_with_userId,true` — compact via encode()

Total entries after change: **2** (was 0, unchanged 0)

## New file content

```csv
key,value
cart_cartstore_ValkeyCartStore,true
GetCartAsync_called_with_userId,true
```

## Apply via `gh`

Pick one of the two flows below. Both create a PR against `talweiss/log10x-mcp-eval-sandbox` (`main`) — review and merge through your normal workflow. The engine hot-reloads the CSV via `FileResourceLookup.reset()` on next gitops poll; **no pipeline restart, no event drops**.

### Flow A — single shell snippet (one paste)

```bash
set -euo pipefail
REPO='talweiss/log10x-mcp-eval-sandbox'
BASE='main'
LOOKUP_PATH='pipelines/run/receive/compact/compact-lookup.csv'
BRANCH='mcp/compact-1778361700524'
PR_TITLE='compact: update 2 entries'

# Write new CSV to a tempfile
TMPFILE=$(mktemp)
cat > "$TMPFILE" <<'CSV_EOF'
key,value
cart_cartstore_ValkeyCartStore,true
GetCartAsync_called_with_userId,true
CSV_EOF

# Fetch current SHA (needed for update; empty for create)
CUR_SHA=$(gh api "/repos/$REPO/contents/$LOOKUP_PATH?ref=$BASE" --jq .sha 2>/dev/null || true)

# Commit the new content on a fresh branch (gh api creates the branch if absent)
CONTENT_B64=$(base64 < "$TMPFILE" | tr -d "\n")
PUT_ARGS=( -X PUT "/repos/$REPO/contents/$LOOKUP_PATH"
  -f branch="$BRANCH"
  -f message="$PR_TITLE"
  -f content="$CONTENT_B64" )
[ -n "$CUR_SHA" ] && PUT_ARGS+=( -f sha="$CUR_SHA" )
gh api "${PUT_ARGS[@]}"

# Open the PR
gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \
  --title "$PR_TITLE" \
  --body 'Compact-lookup update authored via the log10x MCP advisor.

**File**: `pipelines/run/receive/compact/compact-lookup.csv`
**Key format**: `symbolMessage` (joined with underscores)
**Default decision** (no entry matches): `false`

### Changes
- Added 2: `cart_cartstore_ValkeyCartStore`=`true`, `GetCartAsync_called_with_userId`=`true`

Engine impact: lookup hot-reloads via `FileResourceLookup.reset()` on the next gitops poll. No pipeline restart.'
```

### Flow B — clone + edit + push (if you prefer a local working copy)

```bash
gh repo clone talweiss/log10x-mcp-eval-sandbox /tmp/gitops-1778361700524 -- --depth 1 --branch main
cd /tmp/gitops-1778361700524
git checkout -b mcp/compact-1778361700524
mkdir -p "$(dirname pipelines/run/receive/compact/compact-lookup.csv)"
cat > pipelines/run/receive/compact/compact-lookup.csv <<'CSV_EOF'
key,value
cart_cartstore_ValkeyCartStore,true
GetCartAsync_called_with_userId,true
CSV_EOF
git add pipelines/run/receive/compact/compact-lookup.csv
git commit -m 'compact: update 2 entries'
git push -u origin mcp/compact-1778361700524
gh pr create --base main --title 'compact: update 2 entries'
```

> **Note**: `current_csv` was not provided. The tool computed the diff against an empty baseline. If the file already exists in the repo, fetch it first and re-call this tool with `current_csv` for an accurate diff:
>
> ```bash
> gh api "/repos/talweiss/log10x-mcp-eval-sandbox/contents/pipelines/run/receive/compact/compact-lookup.csv?ref=main" --jq .content | base64 -d
> ```

## After merge

The receiver pod's gitops puller (`pipelines/gitops/config.yaml`, default 30s poll) re-fetches the file. `FileResourceLookup.reset()` fires on the file-watcher event. New entries take effect within the poll interval. **No pod restart, no event drops.**

To verify in-cluster after merge:
```bash
kubectl logs -l app.kubernetes.io/name=receiver -c receiver --tail=200 | grep -i "resource reload"
# expected line within ~30s of merge:
# resource reload: resetting pipeline unit ... modified resources: [...compact-lookup.csv]
```

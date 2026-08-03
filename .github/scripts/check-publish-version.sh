#!/usr/bin/env bash
#
# Release gate for publish.yml. Exits 0 only when package.json holds a version
# that is a forward move against BOTH sources of truth:
#
#   1. npm: the registry is what customers install from. A version already on
#      npm cannot be republished, and a version LOWER than the current `latest`
#      must never be published: npm would move the `latest` dist-tag backwards
#      and un-ship every fix in between.
#   2. git: a `v<version>` tag means this repo already recorded that ship.
#
# Every refusal exits non-zero. The job must go RED, never "skipped, success":
# a green run on a src-only merge that shipped nothing is indistinguishable
# from a real release, which is how src changes sat unpublished.
#
# Test hooks (set by .github/scripts/check-publish-version.test.sh only; unset
# in CI, where every fact is read live):
#   TEST_VERSION       overrides the package.json version
#   TEST_NPM_LATEST    overrides `npm view <pkg> version` ("" = unpublished)
#   TEST_NPM_VERSIONS  overrides `npm view <pkg> versions --json`
#   TEST_TAG_EXISTS    overrides the git tag lookup (true|false)

set -euo pipefail

pkg=$(node -p "require('./package.json').name")

if [ -n "${TEST_VERSION:-}" ]; then
  version="$TEST_VERSION"
else
  version=$(node -p "require('./package.json').version")
fi

if [ -n "${TEST_TAG_EXISTS:-}" ]; then
  tagged="$TEST_TAG_EXISTS"
elif git rev-parse --verify --quiet "refs/tags/v$version" >/dev/null; then
  tagged=true
else
  tagged=false
fi

if [ -n "${TEST_NPM_LATEST+x}" ]; then
  npm_latest="$TEST_NPM_LATEST"
else
  # A never-published package makes `npm view` exit non-zero (E404). That is a
  # legitimate first publish, so swallow the failure and treat latest as empty.
  npm_latest=$(npm view "$pkg" version 2>/dev/null || true)
fi

if [ -n "${TEST_NPM_VERSIONS+x}" ]; then
  npm_versions="$TEST_NPM_VERSIONS"
else
  npm_versions=$(npm view "$pkg" versions --json 2>/dev/null || echo '[]')
fi

echo "package:     $pkg"
echo "candidate:   $version"
echo "npm latest:  ${npm_latest:-<unpublished>}"
echo "git tag:     v$version $([ "$tagged" = true ] && echo present || echo absent)"

on_npm=$(NPM_VERSIONS="$npm_versions" CANDIDATE="$version" node -e '
  const list = JSON.parse(process.env.NPM_VERSIONS || "[]");
  const all = Array.isArray(list) ? list : [list];
  process.stdout.write(all.includes(process.env.CANDIDATE) ? "true" : "false");
')

if [ "$on_npm" = true ]; then
  echo "::error file=package.json::$pkg@$version is already on npm. Bump package.json before merging to main. This merge shipped nothing."
  exit 1
fi

if [ "$tagged" = true ]; then
  echo "::error file=package.json::v$version is already tagged in this repo. Bump package.json before merging to main. This merge shipped nothing."
  exit 1
fi

if [ -n "$npm_latest" ]; then
  # 1 = candidate ahead, 0 = equal, -1 = candidate behind npm latest.
  order=$(CANDIDATE="$version" LATEST="$npm_latest" node -e '
    const parse = (v) => {
      const [core, ...rest] = String(v).split("-");
      const nums = core.split(".").map((n) => Number(n) || 0);
      return { nums, pre: rest.join("-") };
    };
    const a = parse(process.env.CANDIDATE);
    const b = parse(process.env.LATEST);
    let out = 0;
    for (let i = 0; i < 3 && out === 0; i++) {
      const x = a.nums[i] || 0;
      const y = b.nums[i] || 0;
      if (x !== y) out = x > y ? 1 : -1;
    }
    if (out === 0 && a.pre !== b.pre) {
      // A release outranks any prerelease of the same core version.
      if (!a.pre) out = 1;
      else if (!b.pre) out = -1;
      else out = a.pre > b.pre ? 1 : -1;
    }
    process.stdout.write(String(out));
  ')

  if [ "$order" = "-1" ]; then
    echo "::error file=package.json::$version is BEHIND the npm latest ($npm_latest). Publishing it would move the npm latest dist-tag backwards and un-ship every fix released since $npm_latest. Refusing."
    exit 1
  fi
fi

echo "$version is a forward bump. Proceeding to publish."
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "version=$version" >> "$GITHUB_OUTPUT"
fi

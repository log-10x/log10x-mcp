#!/usr/bin/env bash
#
# Offline cases for check-publish-version.sh. Run from the repo root:
#   .github/scripts/check-publish-version.test.sh
#
# Every case pins the npm and git facts through the TEST_* hooks, so the suite
# needs no network and no tags. Case 1 is also worth running with the hooks
# unset on a main checkout that is already tagged: the gate must go red there.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

gate=.github/scripts/check-publish-version.sh
failures=0

run_case() {
  local name="$1" expected="$2"; shift 2
  echo "── $name"
  local out rc
  out=$(env "$@" bash "$gate" 2>&1); rc=$?
  echo "$out" | sed 's/^/   /'
  if [ "$rc" = "$expected" ]; then
    echo "   PASS (exit $rc, expected $expected)"
  else
    echo "   FAIL (exit $rc, expected $expected)"
    failures=$((failures + 1))
  fi
  echo
}

run_case "(a) version already tagged and on npm -> job FAILS" 1 \
  TEST_VERSION=1.27.1 TEST_TAG_EXISTS=true \
  TEST_NPM_LATEST=1.27.1 TEST_NPM_VERSIONS='["1.27.0","1.27.1"]'

run_case "(a2) tagged but never reached npm -> job FAILS" 1 \
  TEST_VERSION=1.28.0 TEST_TAG_EXISTS=true \
  TEST_NPM_LATEST=1.27.1 TEST_NPM_VERSIONS='["1.27.0","1.27.1"]'

run_case "(b) untagged version BEHIND npm latest -> REFUSED" 1 \
  TEST_VERSION=1.26.9 TEST_TAG_EXISTS=false \
  TEST_NPM_LATEST=1.27.1 TEST_NPM_VERSIONS='["1.27.0","1.27.1"]'

run_case "(c) clean forward bump -> proceeds" 0 \
  TEST_VERSION=1.27.2 TEST_TAG_EXISTS=false \
  TEST_NPM_LATEST=1.27.1 TEST_NPM_VERSIONS='["1.27.0","1.27.1"]'

run_case "(d) first publish, package not on npm -> proceeds" 0 \
  TEST_VERSION=0.1.0 TEST_TAG_EXISTS=false \
  TEST_NPM_LATEST= TEST_NPM_VERSIONS='[]'

run_case "(e) prerelease behind the released latest -> REFUSED" 1 \
  TEST_VERSION=1.27.1-rc.1 TEST_TAG_EXISTS=false \
  TEST_NPM_LATEST=1.27.1 TEST_NPM_VERSIONS='["1.27.1"]'

if [ "$failures" != 0 ]; then
  echo "$failures case(s) failed."
  exit 1
fi
echo "All cases passed."

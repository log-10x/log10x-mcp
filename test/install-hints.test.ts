import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installHintForPlatform,
  compilerInstallHintForPlatform,
  tenxAvailabilityHint,
  FLAVOR_SUMMARY,
} from '../src/lib/install-hints.js';

// THE REGRESSION THESE PIN. The runtime hint used to be flavor-blind: it printed
// `install.ps1` on Windows with no TENX_FLAVOR set, and install.ps1 defaults to
// the COMPILER. So a user who needed a runtime (Reporter / Receiver / Retriever
// / CLI, every non-compile tool in this server) was handed the one flavor that
// is a whole JVM compiler toolchain, and the only flavor they could not get any
// other way was the one they actually wanted.
//
// Windows has no native runtime binary, the release carries no
// `tenx-*-windows-*-native` asset, so `runtime-jvm` IS the runtime there.

/** Run `fn` as though the process were on `platform`. */
function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('every platform gets a runtime, and Windows gets runtime-jvm', () => {
  // Linux / macOS have a native runtime, so they get it.
  assert.equal(onPlatform('linux', installHintForPlatform).flavor, 'runtime');
  assert.equal(onPlatform('darwin', installHintForPlatform).flavor, 'runtime');
  // Windows has none built, so the JVM package is the runtime there.
  assert.equal(onPlatform('win32', installHintForPlatform).flavor, 'runtime-jvm');
});

test('the Windows runtime command actually asks for runtime-jvm', () => {
  const hint = onPlatform('win32', installHintForPlatform);
  // Bare `irm install.ps1 | iex` installs the COMPILER (that is the script's
  // default), so the flavor has to be set explicitly in the pasted command.
  assert.match(hint.command, /TENX_FLAVOR="runtime-jvm"/);
  assert.match(hint.command, /install\.ps1/);
  assert.match(hint.docsUrl, /^https:\/\/doc\.log10x\.com\/install\/win\//);
});

test('the Linux runtime command names the flavor rather than relying on the default', () => {
  const hint = onPlatform('linux', installHintForPlatform);
  assert.match(hint.command, /install\.sh \| sh -s -- --flavor runtime$/);
});

test('macOS runtime comes from the tap formula, not the install script', () => {
  const hint = onPlatform('darwin', installHintForPlatform);
  assert.equal(hint.command, 'brew install log-10x/tap/log10x');
});

test('the compiler is installable on all three platforms, Windows included', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as NodeJS.Platform[]) {
    const hint = onPlatform(platform, compilerInstallHintForPlatform);
    assert.equal(hint.flavor, 'compiler', `${platform} must have a compiler install path`);
    assert.notEqual(hint.command, 'see docs for install instructions');
  }
  // macOS ships the compiler as a .dmg, which install.sh refuses by name, it is
  // a cask, and the cask token is the frozen PACKAGE id, not the flavor name.
  assert.match(onPlatform('darwin', compilerInstallHintForPlatform).command, /--cask log-10x\/tap\/log10x-cloud/);
  assert.match(onPlatform('win32', compilerInstallHintForPlatform).command, /TENX_FLAVOR="compiler"/);
  assert.match(onPlatform('linux', compilerInstallHintForPlatform).command, /--flavor compiler$/);
});

test('an unknown platform still returns a usable pointer', () => {
  const hint = onPlatform('aix', installHintForPlatform);
  assert.match(hint.docsUrl, /^https:\/\/doc\.log10x\.com\/install\//);
});

test('the availability hint enumerates all three flavors and separates compile', () => {
  const hint = onPlatform('win32', tenxAvailabilityHint);
  for (const flavor of ['compiler', 'runtime', 'runtime-jvm']) {
    assert.match(hint, new RegExp(`\\b${flavor}\\b`), `availability hint must name ${flavor}`);
  }
  assert.equal(FLAVOR_SUMMARY.length, 3);
  // The local command it hands a Windows user is the runtime one...
  assert.match(hint, /TENX_FLAVOR="runtime-jvm"/);
  assert.match(hint, /installs the `runtime-jvm` flavor/);
  // ...and compile is called out separately, pointing at the compiler.
  assert.match(hint, /For compile \/ link specifically.*TENX_FLAVOR="compiler"/);
});

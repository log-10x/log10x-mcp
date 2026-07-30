/**
 * Emitter-correctness tests for the per-forwarder offload recipes.
 *
 * These are the build-time smoke test for the emitter: they prove the
 * generated recipe is wired to the verified engine contract (string
 * `routeState == "drop"` match, the Retriever's `{bucket}/app/` JSONL layout, the
 * forwarder-write IAM grant). They do NOT prove a live event routes to S3 on
 * a real forwarder — that is the per-forwarder runtime gate, flagged via the
 * `SMOKE TEST REQUIRED` prerequisite on the research-derived recipes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFLOAD_FORWARDERS,
  offloadRecipe,
  forwarderWriteIamPolicy,
  forwarderWriteTerraform,
  datadogFlexRecipe,
  cloudwatchIaRecipe,
  azureLogsTierRecipe,
  renderOffloadSection,
  fluentBitCoralogixRecipe,
  coralogixMonitoringRecipe,
  otherOffloadForwarders,
  type OffloadForwarderId,
} from '../src/lib/offload-recipes.js';

const PARAMS = { bucket: 'tenx-demo-cloud-retriever-351939435334', region: 'us-east-1' };

test('every forwarder recipe fills bucket, region, and the app/ prefix', () => {
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.ok(r.body.includes(PARAMS.bucket), `${fwd}: bucket missing`);
    assert.ok(r.body.includes(PARAMS.region), `${fwd}: region missing`);
    assert.ok(/\bapp\/?/.test(r.body), `${fwd}: app prefix missing`);
    assert.ok(r.placementNote.length > 0, `${fwd}: placementNote empty`);
  }
});

test('no recipe uses the legacy boolean form (engine writes the string "drop")', () => {
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.ok(!/==\s*true\b/.test(r.body), `${fwd}: uses == true (must be string equality on "drop")`);
    assert.ok(!/==\s*"true"/.test(r.body), `${fwd}: matches the string "true" (the wire value is "drop")`);
  }
});

test('each forwarder matches routeState in its native string form (offload action)', () => {
  // The engine now stamps a per-service action name; each forwarder routes the
  // `offload` slice to S3 via a string match on that name.
  const expected: Record<OffloadForwarderId, RegExp> = {
    vector: /\.routeState == "offload"/,
    fluentd: /key routeState[\s\S]*pattern \/\^offload\$\//,
    'fluent-bit': /r=="offload"/,
    'otel-collector': /attributes\["routeState"\] == "offload"/,
    logstash: /if \[routeState\] == "offload"/,
    cribl: /routeState == 'offload'/,
  };
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.match(r.body, expected[fwd], `${fwd}: routeState match form wrong`);
  }
});

test('each forwarder branches per action (offload / tier_down / drop)', () => {
  // Every recipe must name all three non-SIEM actions so the per-service
  // routing is complete (pass/compact/sample fall through to the SIEM).
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    for (const action of ['offload', 'tier_down', 'drop']) {
      assert.ok(
        r.body.includes(action),
        `${fwd}: missing the ${action} branch`,
      );
    }
  }
});

test('each forwarder suppresses the drop slice (no destination for it)', () => {
  // The drop branch must be visibly suppressed, not routed to a sink. Each
  // forwarder expresses suppression in its own idiom.
  const suppression: Record<OffloadForwarderId, RegExp> = {
    // vector: the "drop" route exists but has no [sinks.*] consuming it.
    vector: /route\.drop\s*=/,
    fluentd: /@type null/,
    'fluent-bit': /Name\s+null\s*\n\s*Match\s+tenx\.drop/,
    'otel-collector': /logs\/drop:.*exporters:\s*\[nop\]/,
    logstash: /SUPPRESSED/,
    cribl: /devnull/,
  };
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.match(r.body, suppression[fwd], `${fwd}: drop slice not suppressed`);
  }
});

test('vector: the drop route has no sink consuming it (true suppression)', () => {
  const r = offloadRecipe('vector', PARAMS);
  // No [sinks.*] block should take inputs from tenx_action_route.drop.
  assert.ok(
    !/inputs\s*=\s*\["tenx_action_route\.drop"\]/.test(r.body),
    'vector: a sink consumes the drop route (must be left unwired)',
  );
});

test('each recipe strips routeState on the output path, never tenx_hash', () => {
  const stripForm: Record<OffloadForwarderId, RegExp> = {
    vector: /except_fields\s*=\s*\["routeState"\]/,
    fluentd: /remove_keys routeState/,
    'fluent-bit': /Remove_key\s+routeState/,
    'otel-collector': /delete_key\(log\.attributes, "routeState"\)/,
    logstash: /remove_field => \["routeState"/,
    cribl: /Remove fields: routeState/,
  };
  // A real removal of tenx_hash would name it as a field token (quoted in
  // vector/otel/logstash, or `remove_keys tenx_hash` / `Remove_key tenx_hash`
  // / `Remove fields: ... tenx_hash`). Comments say "tenx_hash kept" (bare),
  // so guard the directive forms, not any mention.
  const stripsTenxHash =
    /"tenx_hash"|(?:remove_keys|Remove_key|Remove fields:)\s+tenx_hash/;
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.match(r.body, stripForm[fwd], `${fwd}: does not strip routeState on the output path`);
    assert.ok(!stripsTenxHash.test(r.body), `${fwd}: must NOT strip tenx_hash`);
  }
});

test('fluentd routes with CORE plugins (copy/relabel/grep, no rewrite_tag_filter gem)', () => {
  const r = offloadRecipe('fluentd', PARAMS);
  // copy fans to two labels; grep keeps each slice. No rewrite_tag_filter
  // (an extra gem) and no rewrite loop / root-router escape.
  assert.match(r.body, /@type copy/);
  assert.match(r.body, /@label @TENX_OFFLOAD/);
  assert.match(r.body, /@label @TENX_SIEM/);
  assert.ok(!/rewrite_tag_filter/.test(r.body), 'fluentd must not depend on the rewrite_tag_filter gem');
});

test('every recipe carries the engine offload-mode + IAM prerequisites', () => {
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    assert.ok(
      r.prerequisites.some(p => p.includes('outputOffload')),
      `${fwd}: missing outputOffload prerequisite`
    );
    assert.ok(
      r.prerequisites.some(p => p.includes('s3:PutObject')),
      `${fwd}: missing IAM prerequisite`
    );
  }
});

test('all forwarders are verified live — no recipe carries a SMOKE TEST REQUIRED caveat', () => {
  // vector/fluentd/fluent-bit/logstash verified E2E to file sinks; cribl via
  // `cribl pipe`; otel routing+strip+body-fold + the S3 object shape verified
  // against MinIO. Nothing left pending.
  for (const fwd of OFFLOAD_FORWARDERS) {
    const r = offloadRecipe(fwd, PARAMS);
    const hasCaveat = r.prerequisites.some(p => p.includes('SMOKE TEST REQUIRED'));
    assert.ok(!hasCaveat, `${fwd}: should be verified live with no SMOKE TEST caveat`);
  }
});

test('custom prefix flows through to the S3 key', () => {
  const r = offloadRecipe('vector', { ...PARAMS, prefix: 'logs' });
  assert.ok(r.body.includes('logs/'), 'custom prefix not used');
  assert.ok(!r.body.includes('"app/"'), 'default prefix leaked');
});

test('forwarder-write IAM grants PutObject scoped to the offload prefix', () => {
  const iam = forwarderWriteIamPolicy(PARAMS);
  const doc = JSON.parse(iam.policyJson);
  assert.equal(doc.Statement[0].Effect, 'Allow');
  assert.deepEqual(doc.Statement[0].Action, ['s3:PutObject']);
  assert.equal(
    doc.Statement[0].Resource,
    `arn:aws:s3:::${PARAMS.bucket}/app/*`
  );
  assert.ok(iam.attachmentNote.includes('IRSA'), 'no IRSA attachment guidance');
});

test('Datadog Flex recipe routes @routeState:drop via the retention waterfall', () => {
  const r = datadogFlexRecipe();
  assert.equal(r.target, 'datadog-flex');
  assert.match(r.body, /@routeState:drop/);
  assert.match(r.body, /retention_days\s*=\s*0/);
  assert.match(r.body, /flex_retention_days\s*=\s*30/);
  assert.ok(r.note.toLowerCase().includes('index'), 'should clarify index-not-ingest saving');
  assert.ok(!r.note.toLowerCase().includes('cuts the ingest'), 'must not claim ingest saving');
});

test('Datadog Flex recipe includes index_order companion + provider pin (first-match-wins)', () => {
  const r = datadogFlexRecipe();
  assert.match(r.body, /datadog_logs_index_order/);
  assert.match(r.body, /version\s*=\s*">= 4\.6\.0"/);
  assert.ok(r.note.toLowerCase().includes('first-match'), 'note must explain the first-match ordering requirement');
});

test('forwarder-write Terraform: role + scoped PutObject + IRSA ServiceAccount binding', () => {
  const tf = forwarderWriteTerraform();
  assert.match(tf, /resource "aws_iam_role"/);
  assert.match(tf, /"s3:PutObject"/);
  assert.match(tf, /arn:aws:s3:::\$\{var\.bucket\}\/\$\{var\.prefix\}\/\*/);
  assert.match(tf, /system:serviceaccount:\$\{var\.namespace\}:\$\{var\.service_account\}/);
  assert.match(tf, /sts:AssumeRoleWithWebIdentity/);
});

test('CloudWatch IA recipe creates an Infrequent-Access log group', () => {
  const r = cloudwatchIaRecipe();
  assert.equal(r.target, 'cloudwatch-ia');
  assert.match(r.body, /log_group_class\s*=\s*"INFREQUENT_ACCESS"/);
  assert.ok(r.note.includes('stamp-miss'), 'missing the fallback-billing hardening note');
});

test('otherOffloadForwarders excludes the detected one, stable order', () => {
  const rest = otherOffloadForwarders('fluentd');
  assert.ok(!rest.includes('fluentd'));
  assert.equal(rest.length, OFFLOAD_FORWARDERS.length - 1);
  assert.deepEqual(rest, OFFLOAD_FORWARDERS.filter(f => f !== 'fluentd'));
});

test('azureLogsTierRecipe emits Basic by default; Auxiliary on request; both carry the per-query caveat', () => {
  const basic = azureLogsTierRecipe();
  assert.equal(basic.target, 'azure-basic');
  assert.ok(/--plan Basic/.test(basic.body), 'body sets --plan Basic');
  assert.ok(/routeState/.test(basic.body), 'body routes on the routeState marker');
  assert.ok(/per-GB QUERY/i.test(basic.note), 'note discloses the per-query fee');

  const aux = azureLogsTierRecipe({ plan: 'Auxiliary' });
  assert.equal(aux.target, 'azure-auxiliary');
  assert.ok(/--plan Auxiliary/.test(aux.body), 'body sets --plan Auxiliary');

  // A stamp-miss must honestly bill Analytics (matching CloudWatch), never claim
  // the opposite, and the forwarder-plugin constraint must be stated.
  assert.ok(/full Analytics rate/.test(basic.note), 'stamp-miss bills Analytics');
  assert.ok(!/does not silently bill Analytics/.test(basic.note), 'no inverted note');
  assert.ok(/azure_logs_ingestion/.test(basic.note) && /Data Collector API/.test(basic.note), 'forwarder constraint stated');
});

test('renderOffloadSection for azure-monitor renders BOTH Basic and Auxiliary (consumes tier_down_alt_tiers)', () => {
  const md = renderOffloadSection(PARAMS, 'fluentd', 'azure-monitor');
  assert.ok(/Azure Monitor Basic Logs/.test(md), 'Basic tier rendered');
  assert.ok(/Azure Monitor Auxiliary Logs/.test(md), 'Auxiliary tier rendered (field consumed, not dead)');
  assert.ok(/--plan Auxiliary/.test(md), 'Auxiliary provisioning command rendered');
  // does NOT render the Azure tier section for a non-Azure destination
  const cw = renderOffloadSection(PARAMS, 'fluentd', 'cloudwatch');
  assert.ok(!/Azure Monitor/.test(cw), 'Azure section gated out on cloudwatch');
});

// ---------------------------------------------------------------------------
// Coralogix. This recipe INVERTS the rule every other recipe in the file obeys
// ("on EVERY branch the routeState marker is stripped"), so the tests below
// exist to stop someone restoring the strip for consistency and silently
// breaking tier selection.
// ---------------------------------------------------------------------------

const CX = { ...PARAMS, domain: 'cx498.coralogix.com' };

test('coralogix recipe does NOT strip routeState (it is what the policy matches)', () => {
  const r = fluentBitCoralogixRecipe(CX);
  // The strip primitives every other fluent-bit branch uses must be absent for
  // the routeState key specifically.
  assert.ok(
    !/Remove_key\s+routeState/.test(r.body),
    'routeState must survive: TCO policies evaluate BEFORE enrichment, so a stripped marker is unmatchable'
  );
  // The internal routing key is still cleaned up.
  assert.ok(r.body.includes('rec["_route"]=nil'), '_route should be removed from the shipped body');
});

test('coralogix recipe maps routeState onto subsystemName', () => {
  const r = fluentBitCoralogixRecipe(CX);
  assert.ok(r.body.includes('out["subsystemName"]'), 'lua must set subsystemName');
  assert.ok(
    r.body.includes('(r=="tier_down") and "tier_down" or "app"'),
    'subsystem must be derived FROM routeState, not hardcoded'
  );
  // subsystem is the matcher available on every provider version and on the
  // plain HTTP API, so it is the fallback when dpxl_expression is unavailable.
  assert.ok(r.body.includes('ingress.cx498.coralogix.com'), 'ingest host must be templated from domain');
  assert.ok(r.body.includes('/logs/v1/singles'), 'singles endpoint');
});

test('coralogix recipe keeps tier_down on the SIEM path, not a second sink', () => {
  const r = fluentBitCoralogixRecipe(CX);
  // Unlike CW-IA / Datadog Flex, tier_down must NOT be retagged away: on
  // Coralogix it ships to the same endpoint and only the subsystem differs.
  assert.ok(
    !/Rule\s+\$_route\s+\^tier_down\$/.test(r.body),
    'tier_down must not be split to its own tag on the coralogix path'
  );
  assert.ok(/Rule\s+\$_route\s+\^offload\$/.test(r.body), 'offload still splits to S3');
  assert.ok(/Rule\s+\$_route\s+\^drop\$/.test(r.body), 'drop still splits to null');
});

test('coralogix policy recipe ships both matcher forms and dates the dpxl one', () => {
  const r = coralogixMonitoringRecipe();
  assert.ok(r.body.includes('dpxl_expression'), 'form A: direct body-field match');
  assert.ok(r.body.includes("<v1> $d.routeState == 'tier_down'"), 'dpxl needs the <v1> version prefix');
  assert.ok(r.body.includes('~> 3.4'), 'dpxl_expression landed in provider 3.4.0; pin must say so');
  assert.ok(r.body.includes('subsystems'), 'form B: subsystem match for pre-3.4 providers');
  assert.ok(r.body.includes('medium'), 'medium == Monitoring');
  // Policy creation is now verified live, but BILLING attribution is not, and
  // the note must keep saying so. This assertion is the honesty gate: if
  // someone upgrades the claim to "verified" wholesale, this fails.
  assert.match(r.note, /VERIFIED BY APPLY/);
  assert.match(r.note, /Still UNVERIFIED/);
});

test('the dpxl form documents the WIDER exclusivity the server enforces', () => {
  const r = coralogixMonitoringRecipe();
  // The provider docs say dpxl_expression is exclusive with `severities`. The
  // server also rejects it alongside applicationRule/subsystemRule. Shipping
  // the narrower claim would produce configs that fail on apply.
  // The phrase wraps across comment lines, so assert on the parts.
  assert.ok(r.body.includes('EXCLUSIVITY IS WIDER'), 'must flag the wider exclusivity');
  assert.ok(r.body.includes('applicationRule'), 'must name applicationRule as also-excluded');
  assert.ok(r.body.includes('subsystemRule'), 'must name subsystemRule as also-excluded');
});

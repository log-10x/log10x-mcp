# Multi-model cross-validation: Claude vs Grok on root-cause-from-deploy

Both models run against the **same live planted signal** in the demo
cluster (Deployment `synthetic-canary-app`, SHA
`f8d6b30b527b6d8eb09cb58835cbda3b6d6789c3`, mode=bug). The hero
scenario fixture is identical for both runs. The Anthropic-side
judge (Sonnet) scores both transcripts using the same prompt and
rubric — so all three axes (drift, value_delivered, value_received)
are model-comparable.

## Headline

| Axis | Claude (sonnet-4-6) | Grok (grok-4-latest) |
|------|---------------------|----------------------|
| Status | PASS | PASS |
| **Hallucination drift** | **0** | **0** |
| Value delivered | 0.95 | 0.95 |
| Value received | 0.20 | 0.95 |
| Bash calls | 14 | **5** |
| Duration | 116.5s | 96.3s |

Both models passed cleanly. The interesting deltas are below.

## Tool-call efficiency: Grok 5 vs Claude 14

Grok went directly to the answer. Its trace, verbatim:

```
1. kubectl get deployment synthetic-canary-app -n otel-demo \
     -o jsonpath="{.metadata.annotations['canary.github.io/sha']}"
2. kubectl get deployments -n otel-demo -o name
3. kubectl get deployment synthetic-canary-app -n otel-demo \
     -o jsonpath="{.metadata.annotations}"
4. gh api repos/talwgx/test/commits/<sha>
5. gh api repos/talwgx/test/commits/<sha>/pulls
```

Call 1 used a jsonpath that returns empty when the annotation key
contains a `/` (kubectl quoting quirk); Grok recovered with calls 2
+ 3 and got every annotation in one shot. Calls 4 + 5 closed out
the repo → commit → PR chain.

Claude's trace was 14 calls because it interleaved MCP exploration
(`log10x_top_patterns` filters, `log10x_event_lookup`,
`log10x_pattern_examples`, `log10x_investigate`) into the
correlation. Per Claude's own value_received rationale (0.20):
"the log10x MCP tools returned no useful signal—top_patterns had no
data, investigate couldn't resolve the service or pattern, and
services showed synthetic-canary-app was not yet indexed—so the MCP
layer contributed nothing to the actual answers." Claude tried the
MCP path harder and ate calls on dead-end exploration. Grok skipped
it and went straight to kubectl + gh.

**Interpretation**: neither approach is wrong. Claude over-trusts
the MCP layer (which is what the harness is designed for) and pays
for it on a scenario the MCP can't answer; Grok's bias is to read
the prompt literally and go to the named tool (kubectl + gh). On a
scenario the MCP CAN answer (`stability-newly-emerged`, etc.), the
exploration-heavy Claude approach is what you want. On the
deploy-attribution scenario, the kubectl-first Grok approach wins.

## Value_received: 0.20 vs 0.95

Same MCP, same env, same time window. The judge scored Claude's
MCP usage at 0.20 because Claude actually exercised MCP and the
tools returned empty/no-data responses — those failed calls are
visible in the transcript. Grok scored 0.95 because Grok didn't
call MCP at all, so there was nothing for the judge to deduct on.

This is a real metric-design issue: `value_received` measures "did
the MCP help the agent" but answer "no" can come from either
"agent didn't try" or "agent tried and MCP failed." We can fix
this in the judge prompt — penalize "didn't try" the same as
"tried and got nothing." Follow-up.

## Anti-hallucination: both pass cleanly

Both produced drift=0. Both quoted the commit message verbatim
from `gh api` output. Both correctly identified the absent parent
PR rather than fabricating one.

Grok's synthesis included a noteworthy meta-observation that Claude
didn't make:

> "If this is a test scenario, monitor the alert without action and
> let it resolve naturally."

Grok inferred from the commit message itself (which mentions "for
multi-model eval cross-validation") that this was a synthetic test
and recommended NO action. That is an unusual property — an agent
reading its own evaluation context out of the commit messages it's
attributing — and worth flagging for future scenario design (we
should consider commit messages that DON'T self-disclose as tests,
to avoid this contamination).

## Recommendation style: process vs action

Claude's recommendations:

  1. Suppress the alert routing
  2. **Enforce branch protection on talwgx/test to require PRs**
  3. Add canary hygiene / TTL
  4. Wait for log10x pattern index to warm up (24h)

Grok's recommendations:

  1. If a test, take no action
  2. Suppress via `kubectl scale … --replicas=0`
  3. **Revert via parent SHA `dfd4487…`**
  4. Verify pod env GITHUB_SHA before rollback

Claude leans toward process / governance fixes; Grok leans toward
immediate operational commands. Both are SRE-valid; the right one
depends on the engagement.

## What this enables

- The harness now scores models on identical scenarios with an
  identical judge. Future scenarios (adversarial-title,
  code-reading) will run through both and produce comparable
  metrics out of the box.
- Anti-hallucination defenses verified across two model vendors:
  neither fabricated SHAs / authors / PRs. drift=0 is a property
  of the harness scaffolding (prompt + judge + oracle), not just
  Claude-specific.
- Tool-selection bias is now measurable: Claude prefers MCP-first
  exploration, Grok prefers prompt-literal go-direct. Both are
  legitimate strategies and the harness now exposes the tradeoff.

## Transcripts

- Claude: `2026-05-11T15-53-27-607Z__claude/`
- Grok:   `2026-05-11T15-55-36-287Z__grok/`

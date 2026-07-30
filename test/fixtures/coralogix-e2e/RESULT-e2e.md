# End to end: engine -> fluent-bit -> Coralogix. PROVEN 2026-07-30.

Chain: Forward client -> **10x engine** (regulator stamps routeState) -> **real
fluent-bit** running the shipped `fluentBitCoralogixRecipe()` filters ->
`/logs/v1/singles` -> **live US2 tenant cx498**.

160 events per run. `checkout` capped at 1500 bytes with action `tier_down`;
`payments` has NO cap row, so `absoluteCap == 0 -> return true` and the
regulator never touches it. That is the control.

## Run A — TCO policies DISABLED, so both slices stay visible

```
groupby $l.subsystemname, $d.routeState
  {"n":114, "routeState":"tier_down", "subsystemname":"tier_down"}
  {"n":46,  "routeState":"pass",      "subsystemname":"app"}

groupby $d.container, $l.subsystemname
  checkout -> tier_down  114
  checkout -> app          6     (events before the cap was crossed)
  payments -> app         40     (uncapped control, never routed)
```

`$d.routeState == 'tier_down'` is still server-side filterable after the whole
chain, and `tenx_hash` survives. **The tiered slice lands in its own subsystem
and the rest does not.**

## Run C — identical input, identical chain, policies ENABLED

```
groupby $l.subsystemname
  {"n":46, "subsystemname":"app"}
total in Frequent Search: 46      (was 160)
```

The 114 `tier_down` events are gone from Frequent Search. Only the untouched
slice remains.

## Run B — the propagation finding

Run B was the same as Run C but sent ~60s after enabling the policies, and ALL
160 events stayed in Frequent Search. Run C sent ~6 min after enabling and the
slice was tiered.

    A  policies disabled      -> 114 tier_down + 46 app = 160
    B  policies enabled ~60s  -> 120 tier_down + 40 app = 160   not yet in effect
    C  policies enabled ~6min ->   0 tier_down + 46 app =  46   tiered

Coralogix documents "Changes take effect immediately." Measured, a policy change
takes somewhere between 1 and 6 minutes to affect routing. Anyone testing a
policy inside a minute will conclude it does not work.

## The bug this run caught in our own recipe

The first e2e attempt put all 160 events in subsystem `app` and tiered nothing,
with HTTP 200 throughout and no error anywhere. Cause: the recipe had inherited
the generic fluent-bit prerequisite "must emit JSON". Under
`fluentbitOutputEncodeType: json` the engine ships the whole rendered record as
ONE msgpack string field named after the encode expression
(`fullText_of_tenx_hash_and_routeState`), so `rec["routeState"]` in the lua is
nil and every event takes the pass branch.

Fixed two ways: the prerequisite now requires the shipped `delimited` default
and warns against `json` by name, and the lua falls back to scanning string
values for the marker so a misconfigured pipeline degrades to correct behaviour
instead of silently mislabelling everything.

## Wire proof

`WIRE-PROOF-sample.jsonl` (first 40 of 320 captured records) shows the engine's
own output. `strings` over the raw capture gives 113 x `"routeState":"tier_down"`
and 47 x `"routeState":"pass"` as literal bytes.

Under `delimited` the spliced text is re-parsed so `routeState` arrives as its
own record field; under `json` it survives as a literal substring inside the
single string field. Both captures are in the deliverable, tagged by encodeType.

## Traps that cost the most time

**A td-agent (Fluentd) launchd daemon, PID 1717, running since Jul 16, holds
IPv4 `*:24224`.** The engine binds the IPv6 dual-stack wildcard, so both
coexist and the engine's bind SUCCEEDS, but the kernel routes IPv4 connections
to the more specific IPv4 socket. Every send to `127.0.0.1:24224` was answered
by td-agent, silently. **Connect to `[::1]:24224`.** Confirm with
`grep "client connected to Forward protocol input" /var/log/tenx/tenx.log`.

**The `container` field is not an event field by default.** The shipped
`fluentbit` extractor does `captureFirst:log` + `drop:tag` only, so a plain
top-level `container` never reaches `this.get(...)`, container falls back to
`__node__`, no cap row matches, and every event comes back `pass`. Use the
production path: include `run/initialize/k8s`, send k8s-filter-shaped records
(`kubernetes.container_name`), and set `containerField: container_name`.

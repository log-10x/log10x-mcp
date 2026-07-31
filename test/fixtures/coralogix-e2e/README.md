# Coralogix tier_down end-to-end harness

Reproduces the path behind `fluentBitCoralogixRecipe()` and
`coralogixMonitoringRecipe()`. Read the STATUS section before quoting anything
from here.

## STATUS

Superseded twice since first written. This section is the entry point, so it
states the CURRENT position; the RESULT-*.md files are the evidence.

**Proven, evidence in this directory:**

1. The engine routes a pattern to `tier_down`. `RESULT-routestate-distribution.txt`
   is the engine's own field output from the file-in/file-out run:

   ```
     44 tier_down,checkout,     <- over cap, action from actions.csv
     16 pass,checkout,          <- under cap, same container
     20 pass,payments,          <- CONTROL: no cap entry, regulator opts out
   ```

   The control is the point. `payments` has no row in `caps.csv`, so
   `rate-object-cap.js` hits `absoluteCap == 0 -> return true` and never routes.
   A run where everything came back `tier_down` would prove nothing. (The
   separate 160-event forwarder run in `RESULT-e2e.md` has its own, larger
   control of 40 — do not mix the two runs' numbers.)

2. The marker reaches the wire. See `WIRE-PROOF-sample.jsonl` and
   `RESULT-e2e.md`.

3. The split lands in Coralogix, and the tiering happens. See `RESULT-e2e.md`:
   114 -> subsystem `tier_down`, 46 -> subsystem `app`, and with policies
   enabled the tier_down slice leaves Frequent Search.

4. A TCO policy matches the `routeState` BODY FIELD with no label at all. See
   `RESULT-tier-assignment.md`, which isolates it against a subsystem rule.

**NOT proven:**

- That the TCO usage report BILLS the down-tiered slice at the Medium rate.
  Usage data lags and was never checked, so the per-GB delta rests on published
  pricing, not an observed invoice.
- Reading the slice back from Monitoring. It lands in customer-owned S3, which
  this trial tenant has not configured, so `TIER_ARCHIVE` returns nothing.
  Absence from Frequent Search is the positive signal here.

## The traps, each of which fails silently

**The installed engine cannot do this at all.** `/usr/local/bin/tenx` is v1.1.0
flavor `edge` and PREDATES `routeState`: its regulator calls `this.drop()` and
its forwarder config has no `routeState` anywhere. Only the newer source tree
has `route(action)`. Run through the JVM run-cloud classpath instead:

```
java -classpath "$(cat ~/run-cloud.classpath)" com.log10x.ext.cloud.run.RunCloud @apps/cxfwd
```

**The splice trap.** `EventFullTextFunction.print()` splices
`,"routeState":"<action>"` only while the event still has an
`OuterCharArrayAccessor`. When `validateOuterAccessor()` fails it writes the
body content UNSPLICED — same bytes, no marker, no error, exit code 0. File
input never establishes an outer envelope, so a file-in/file-out run silently
produces unmarked events. Only a FORWARDER input produces the marker.

**Stale lookup files.** `capLookup.retain` is 10m. A caps.csv older than that is
ignored with one INFO line (`rate receiver cap file is stale`) and every event
comes back `pass`. `touch caps.csv actions.csv` immediately before each run.

**Config blocks are additive, not overrides.** Re-declaring `rateReceiver:` or
`fluentbitOutputEncodeType` in an app config fails with "should be specified
only once". Copy the whole config dir and edit the copy (that is why
`app-cxtest.config.yaml` includes its own `./rate`).

**Not every knob is a CLI option.** `rateReceiverWarmupMs`, `outputOffload` and
friends are `TenXEnv.get` lookups: `overrideKey` rejects them ("not all required
override args were used" / "Unknown options"). Set them as env vars or in config.

**`recvtest` does not run a regulator.** It declares `include:` twice and the
second block overrides the first, so `run/receive/rate` never loads there.

**Docker Desktop tail.** `[INPUT] tail` over a macOS bind mount added the inotify
watch and then emitted zero records. That is why `fwd_server.py` and a Python
Forward client exist as a sender substitute. `fb-send.conf` is kept for a Linux
host where tail works.

## Files

| file | what it is |
|---|---|
| `app-cxtest.config.yaml` | file-in/file-out app; proved routing, cannot splice |
| `app-cxfwd.config.yaml` | forwarder-topology app; the one that can splice |
| `caps.csv` / `actions.csv` | `checkout` capped at 1500 bytes, action `tier_down`; `payments` absent on purpose |
| `fb-recv.conf` | the shipped recipe's filters + Coralogix `/logs/v1/singles` output |
| `fb-send.conf` | tail -> forward into the engine (Linux hosts) |
| `fwd_server.py` | Forward server standing in for fluent-bit's forward INPUT; captures the engine's own bytes. Note `raw=True`: the engine emits msgpack bin strings and `raw=False` aborts the stream on the first non-UTF-8 byte |

Place the two app configs at `config/apps/<name>/config.yaml` under `TENX_HOME`,
alongside a copy of `config/pipelines/run/receive/rate/` as `cxtest/rate/` with
`warmupMs`, `baselineCount` and `minRetentionThreshold` set to 0.

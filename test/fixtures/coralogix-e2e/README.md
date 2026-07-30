# Coralogix tier_down end-to-end harness

Reproduces the path behind `fluentBitCoralogixRecipe()` and
`coralogixMonitoringRecipe()`. Read the STATUS section before quoting anything
from here.

## STATUS: partially proven

**Proven, with output in this directory:**

1. The engine routes a pattern to `tier_down` on a real local run.
   `RESULT-routestate-distribution.txt` is the engine's own field output:

   ```
     44 tier_down,checkout,     <- over cap, action from actions.csv
     16 pass,checkout,          <- under cap, same container
     20 pass,payments,          <- CONTROL: no cap entry, regulator opts out
   ```

   The control matters. `payments` has no row in `caps.csv`, so
   `rate-object-cap.js` hits `absoluteCap == 0 -> return true` and never routes.
   A run where everything came back `tier_down` would prove nothing.

2. `routeState` is a first-class, addressable field in Coralogix once it
   arrives. Verified against live US2 tenant cx498: server-side
   `filter $d.routeState == 'tier_down'` and `groupby $d.routeState` both work,
   and a bogus keypath returns `keypath does not exist` while `routeState` does
   not. `/logs/v1/singles` parses a nested-object `text` identically to a JSON
   string, which is why the lua needs no JSON encoder.

**NOT proven:**

3. The splice landing on the wire. `encodeField` was confirmed to resolve to
   `fullText("tenx_hash","routeState")` in the running engine, but spliced bytes
   were never captured. See "the splice trap" below.
4. The fluent-bit recipe running end to end into Coralogix. Nothing from this
   harness reached the tenant.
5. Tier ASSIGNMENT. Every TCO policy create returned HTTP 400, so no policy has
   ever existed on this tenant. The priority change is untested.

Claim ceiling: *the routing decision reaches Coralogix as a first-class field
and lands in the subsystem a policy matches on.* Nothing stronger.

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

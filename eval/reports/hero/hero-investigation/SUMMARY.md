# Hero scenario: Hero — incident investigation

**Scenario:** `hero-investigation`
**Status:** PASS
**Env:** demo
**Bash calls:** 14

## User question

> PagerDuty just paged us for an unusual spike. Use the data you can pull from this environment to characterize what's going on, what services are affected, and whether the spike is real or noise. Be specific about pattern names and time windows.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 0 supported · 22 inconclusive
- **Value delivered:** 0.85 — The synthesis correctly identifies the spike as real (not noise), names the 4 specific growth patterns with precise cost figures and percentages, isolates cart and shipping as the affected services, characterizes the shape as gradual 30-day drift (not a short-term burst), and gives actionable next steps including a concrete root-cause hypothesis for the shipping protocol mismatch — an SRE could act on this immediately.
- **Value received:** 0.70 — The 30-day cost_drivers call returned the critical signal (4 drivers, specific patterns and costs), pattern_trend confirmed stable short-term shapes, and investigation confirmed gradual drift shape; however, several tool calls failed or returned no data (cross-pillar not configured, extract_templates wrong args, investigate couldn't resolve shipping pattern, retriever_series threw an error), leaving gaps in causal confirmation.

## Sub-agent final synthesis

I now have a comprehensive data picture. Here is the synthesis:

---

## Root-Cause Hypothesis: Real Spike, 30-Day Horizon, Cart + Shipping Services

### What was observed

**The 1-day and 7-day cost-driver queries returned zero anomalies** — all 409 (1d) and 1,204 (7d) patterns were within normal range. This is a truthful negative: the environment looks flat on short windows. The PagerDuty alert is **not a short-term burst**.

**The 30-day cost-driver query revealed the real signal** — 4 patterns crossed the growth threshold, accounting for **49% of total log-cost increase** across the environment:

| Pattern | Services | Volume Growth | Cost Growth |
|---|---|---|---|
| `cart_cartstore_ValkeyCartStore` | cart | 13.9B events | $719 → $14K/mo **(+1,792%)** |
| `shipping_service_Post_shipping_get_quote_unsupported_protocol_scheme_shipping` | shipping | 1.7B events | $380 → $12K/mo **(+3,099%)** |
| `GetCartAsync_called_with_userId` | cart | 9.2B events | $468 → $9.2K/mo **(+1,864%)** |
| `AddItemAsync_called_with_userId_productId_quantity` | cart | 4.4B events | $248 → $4.8K/mo **(+1,827%)** |

**Three of four drivers live in the `cart` service** (ValkeyCartStore, GetCartAsync, AddItemAsync). The `shipping` service has the highest percentage growth (+3,099%) with a critical-sounding pattern about **unsupported protocol scheme** on the get-quote route — a genuine error signature.

**Pattern trends this week are flat** — the `cart_cartstore_ValkeyCartStore`, `GetCartAsync`, and `AddItemAsync` trends all show "stable" on the 7-day window with no discrete inflection point. The investigation confirmed **gradual drift shape** (monotonic, sustained, no step-change), compounding since approximately early-to-mid February 2026 (the 60–90 day lookback window).

**The `email` service** shows a persistent `error_OTLP_logs_exporter_received_Net_HTTPServiceUnavailable_code_uri_logs` pattern (stable at $0.02/wk) — a background OTLP pipeline error, not the spike driver.

### What it means

The spike is **real, not noise**. It is a sustained, monotonically growing log storm in the `cart` and `shipping` services that has been compounding for ~30 days. The `shipping` pattern's name (`unsupported protocol scheme`) suggests a misconfigured downstream call (likely a scheme mismatch — `http://` vs `grpc://` or similar) that is being retried at high frequency. The cart patterns are verbose INFO-level operational logs growing with traffic or a verbosity regression.

### Recommendations

1. **Immediate — shipping service**: Investigate the `shipping_service_Post_shipping_get_quote_unsupported_protocol_scheme_shipping` CRIT-volume pattern. Check the shipping service config for its `get-quote` endpoint URL — a protocol scheme mismatch (`http` vs `grpc` or `https`) is the most likely cause and will be a one-line config fix.
2. **Immediate — cart service**: Audit the `ValkeyCartStore`, `GetCartAsync`, and `AddItemAsync` log call sites. If these are DEBUG/INFO traces added in a recent deploy, consider gating them behind a log-level flag or sampling them — they represent 13.9B + 9.2B + 4.4B events this month.
3. **Root-cause window**: Pull commit/deploy history for `cart` and `shipping` services from **February 8 – April 9, 2026** — the drift investigation's recommended 60–90 day lookback window.
4. **Do not mute without tracing**: `log10x_dependency_check` on `cart_cartstore_ValkeyCartStore` returned 0 dashboard dependencies, but the volume (13.9B events) is operationally significant — fix the source rather than dropping.
5. **Cross-pillar correlation is unavailable** (no `LOG10X_CUSTOMER_METRICS_URL` / APM backend configured) — configure a metrics backend to correlate these log spikes with latency/error-rate signals.

## Oracle validation

- Claims found: 22 numeric, 0 pattern names
- Supported: 0 · Unsupported: 0 · Inconclusive: 22

### Per-claim detail

- [WARN] **$719** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$14** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$380** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$12** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$468** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$9.2** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$248** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$4.8** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **4 patterns** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **13.9B events** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **1.7B events** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **9.2B events** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **4.4B events** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **4.4B events** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **13.9B events** — no targeted oracle path for this kind; claim accepted as plausible
- [WARN] **49%** — percentages are derived; oracle does not gate them
- [WARN] **792%** — percentages are derived; oracle does not gate them
- [WARN] **099%** — percentages are derived; oracle does not gate them
- [WARN] **864%** — percentages are derived; oracle does not gate them
- [WARN] **827%** — percentages are derived; oracle does not gate them
- [WARN] **099%** — percentages are derived; oracle does not gate them
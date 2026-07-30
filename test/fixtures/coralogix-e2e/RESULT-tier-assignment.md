# Tier assignment: PROVEN on live US2 tenant cx498, 2026-07-30

Earlier claim ceiling was "the field arrives and is addressable"; policy creation
had never succeeded (every documented-REST create returned HTTP 400). That is now
resolved, and tier assignment itself is verified.

## Policies created (all PRIORITY_TYPE_MEDIUM == Monitoring)

| order | id | matches on |
|---|---|---|
| 1 | 97e07e94-0a9a-46e5-910d-a5a4f556c7d5 | dpxl `<v1> $d.routeState == 'tier_down'` |
| 2 | 839ef31f-26fa-4d14-b2d5-2101d90fadc2 | subsystem Is `tier_down`, all 6 severities |
| 3 | 6f581e56-2c15-46a7-87cd-fcfd4d5d8447 | app StartsWith `log10x` + subsystem Is `tier_down` |

Both matcher forms create and read back enabled. Orders 4-5 on the tenant
(`probe-full`, `probe-appstr`) are API-probing byproducts, also Medium.

## The evidence

Two events in ONE HTTP request to `/logs/v1/singles`, same instant, differing
only in subsystem:

```
subsystem=app        routeState=pass       -> priorityclass=high, index high163c:...  VISIBLE in Frequent Search
subsystem=tier_down  routeState=tier_down  -> ABSENT from Frequent Search
```

Three controls, because "absent" is a weak signal on its own:

1. **Lag control.** Both events were sent in the same request at the same
   timestamp. The control is visible; the matched one is not, still absent after
   a further re-query. A lag explanation would have to hide one of two events
   from the same POST.
2. **Before/after natural experiment.** Events with subsystem `tier_down` sent
   BEFORE any policy existed (app `tenx-shape`) are STILL VISIBLE in Frequent
   Search. The event with the same subsystem value sent AFTER is not. Same
   subsystem, opposite outcome, only the policy differs.
3. **Group-by.** `groupby $l.subsystemname` over 4h returns 3 `tier_down` rows,
   all of them pre-policy.

## What this does and does not establish

ESTABLISHED: a policy keyed on the routing decision removes the matching slice
from High (Frequent Search). That is the mechanism tier_down depends on.

NOT ESTABLISHED: that the TCO usage report BILLS those events at the Medium
rate. Usage data lags and was not checked. The $0.65/GB delta in
`COST_MODEL_BY_DESTINATION.coralogix` therefore rests on Coralogix's published
priority pricing, not on an observed invoice.

NOT ESTABLISHED: the Medium slice was not read back from its destination.
Monitoring stores into customer-owned S3, which this trial tenant has not
configured, so `TIER_ARCHIVE` returns nothing. Absence from Frequent Search is
the positive signal here; retrieval from Monitoring is untested.

## Body-field match ISOLATED (the original Q2, answered)

The first tier-assignment test could not attribute WHICH policy fired: four of
the five live policies match subsystem `tier_down`, and policy 1 matches the
body field, so the matched event satisfied several at once.

This test isolates it. Two events, one HTTP request, same application, and
**both with subsystem `app`** so no subsystem rule can match. The only
difference is `$d.routeState`:

```
applicationName=isolate  subsystem=app  routeState=pass       -> priorityclass=high, VISIBLE
applicationName=isolate  subsystem=app  routeState=tier_down  -> ABSENT from Frequent Search
```

The only policy that can explain the removal is order 1:

```json
"logRules": { "severities": [], "dpxlExpression": "<v1> $d.routeState == 'tier_down'" }
"enabled": true, "priority": "PRIORITY_TYPE_MEDIUM", "order": 1
```

**A Coralogix TCO policy matches on a field in the event body, with no label
mapping.** Policy routing evaluates before enrichment, so the field has to be
present on arrival — which is exactly what the shipper's un-stripped
`routeState` marker provides.

This reverses the earlier conclusion in this repo's history that the API and
Terraform expose only application/subsystem/severity matchers. That conclusion
came from the `coralogix-management-sdk` v1 protos, which are stale relative to
the shipped product: `CreatePolicyRequest` there has no expression field, but
the live API and provider 3.4.0+ both do.

Note the field path: `dpxlExpression` sits INSIDE `logRules`, alongside
`severities` — not at the top level of the policy object.

Consequence for the shipper: the subsystem mapping in
`fluentBitCoralogixRecipe()` is now defence in depth, not a requirement. Keep it
for pre-3.4.0 providers and for operators who prefer a label they can see in
the UI, but the body field alone is sufficient.

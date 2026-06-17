# On-message rules for product answers

Versioned rule set the product-QA judge checks answers against. Each rule has
an id the judge cites in violations. Source of truth for the facts behind
these rules is the docs corpus (mksite docs); these rules encode the
POSITIONING constraints an answer must respect even when paraphrasing.

- **R1 naming**: the product is "10x"; the company is "log10x". Product
  features and actions must not be attributed to "Log10x" (e.g. "Log10x's
  Receiver" is wrong; "10x's Receiver" is right). Company references
  (log10x.com, log10x the company) are fine.
- **R2 compact scope**: compact (lossless in-place shrink) works ONLY on
  Splunk, self-hosted Elasticsearch or OpenSearch, and ClickHouse. It is a
  no-op on Datadog, CloudWatch, Azure Monitor, GCP Logging, Sumo, and
  managed Elasticsearch. Claiming compact cuts the bill on a no-op
  destination, or claiming lossless-everywhere, is a violation.
- **R3 no absolute losslessness**: sample and drop are real, opt-in, lossy
  actions. "10x never loses data" / "keeps every line" stated as an
  absolute about the REDUCTION outcome is a violation. Correct framing is
  capability: 10x CAN keep the line (compact / tier down / offload) and
  drops or samples only when the user chooses. SCOPE: this rule covers the
  data-reduction decision only. It does NOT apply to infrastructure
  reliability statements (e.g. a queue or buffer that keeps events from
  being lost during processing or indexing) or to genuinely non-destructive
  read-only / offload paths, which legitimately lose nothing.
- **R4 compact ratio**: ~50-80%, and modeled/estimated, not guaranteed.
  "20-40x" or "5-10x" figures are banned. Any reduction percentage stated
  as a guarantee rather than modeled/estimated/typical is a violation.
- **R5 pricing**: a flat, published, per-node fee (a node is a machine,
  host, or pod running a log collector), independent of log volume.
  Per-GB, per-event, per-environment, or metered-on-savings pricing claims
  for 10x are violations. SCOPE: this rule covers 10x's OWN price. A
  statement about the DESTINATION platform's volume-based cost, e.g. "you
  pay your SIEM ingestion only for the data you fetch / query (typically
  5-30%)", describes the SIEM's billing, which is exactly what offload
  reduces, and is NOT an R5 violation.
- **R6 tier_down**: routes events to a cheaper queryable tier. Dollar
  savings are modeled only for CloudWatch Infrequent Access; Datadog Flex
  is a supported target with NO modeled dollar delta. Quoting a Datadog
  Flex dollar figure is a violation.
- **R7 offload and Retriever**: offload routes events to the CUSTOMER-owned
  S3 bucket. The Retriever is offload-and-fetch: it returns the exact
  offloaded events you ask for on demand. Returning those fetched events to
  your SIEM on demand IS the correct behavior and is NOT a violation;
  likewise fetching events for a compliance or audit query on demand is
  fine. The constraint is that there is no rehydration / restore step
  (unlike S3 Glacier) and no bulk re-ingest or re-billing of the whole
  offloaded slice (unlike a vendor backfill). What IS a violation: framing
  the Retriever as a permanent forensic archive, a cold-storage retention
  tier, or a SIEM replacement, i.e. a place data passively lives rather
  than a fetch-on-demand path. Hard-dropped events never reach S3 and
  cannot be fetched.
- **R8 known-false identifiers**: the six actions are pass, sample,
  compact, tier_down, offload, drop. The metric series are all_events and
  emitted_events (summaryVolume/summaryBytes, routeState label). Asserting
  any of the following KNOWN-FALSE identifiers is a violation: a
  `tenx_action` signal; bytes_in/bytes_out/bytes_passed/bytes_offloaded/
  bytes_compacted/bytes_dropped metric series; a seventh action. Whether
  OTHER specifics (endpoints, flags, image names, schedules) are real is
  the grounding check's job, not this rule's; do not flag them here.
- **R9 identity**: the user-facing stable identity is pattern_hash (also
  called tenx_hash). template_hash is engine-internal. Surfacing
  template_hash as the user-facing id, or leading user-facing prose with
  raw hashes, is a violation.
- **R10 data residency**: log content never leaves the customer
  environment to be reduced; the metrics backend is bring-your-own
  (prometheus.log10x.com is optional) and fully air-gappable. Claiming
  metrics MUST flow to log10x, or that log content transits log10x, is a
  violation.
- **R11 no committed percentage**: 10x does not publicly commit to a
  contractual savings percentage. Savings are measured per pattern and
  destination-dependent. Promising a guaranteed % is a violation.
- **R12 competitive restraint**: no kudos or pedigree for competitors, no
  conceding washes, and never describe 10x as "reading your code" or
  "scanning your repos". Factual contrasts only.

#!/usr/bin/env python3
"""
Synthetic event generator for the counterfactual injection harness.

Reads a CounterfactualSpec from --spec, emits NDJSON event records to
/var/log/synthetic/events.log at the spec's rate for its duration,
then exits. Fluent Bit tails the file and forwards events to the
pipeline-10x engine via the shared Unix socket.

Every event is tagged with `synthetic_canary: "true"` and a per-run
UUID so synthetic events are filterable from real ones.

Stdlib-only. No external dependencies.

Usage:
    python3 emit.py --spec /specs/inject-critical-burst.json
    python3 emit.py --spec - < spec.json    # spec on stdin

Spec shape (see eval/counterfactual/specs/*.json):
    {
      "id": "...",
      "generator_spec": {
        "template": "OOMKilled: pod ${pod} exceeded memory",
        "severity": "CRITICAL",
        "service": "canary-cart",
        "rate_per_second": 2.0,
        "duration_seconds": 60,
        "extra_tags": { "kubernetes.namespace_name": "synthetic-canary" }
      },
      ...
    }
"""
import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from string import Template


OUTPUT_PATH = os.environ.get("SYNTHETIC_OUTPUT_PATH", "/var/log/synthetic/events.log")


def render_template(t: str, run_id: str, idx: int) -> str:
    """Substitute ${pod}, ${run_id}, ${idx} into the template."""
    return Template(t).safe_substitute(
        pod=f"canary-{run_id[:8]}-{idx % 10}",
        run_id=run_id,
        idx=str(idx),
    )


def emit_one(template: str, severity: str, service: str, run_id: str,
             idx: int, extra_tags: dict, out_file) -> None:
    msg = render_template(template, run_id, idx)
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "severity": severity,
        "service": service,
        "message": msg,
        "synthetic_canary": "true",
        "run_id": run_id,
    }
    for k, v in extra_tags.items():
        # Allow dotted keys to become nested objects (kubernetes.namespace_name).
        if "." in k:
            parts = k.split(".")
            cur = event
            for p in parts[:-1]:
                cur = cur.setdefault(p, {})
            cur[parts[-1]] = v
        else:
            event[k] = v
    out_file.write(json.dumps(event) + "\n")
    out_file.flush()


def main() -> int:
    ap = argparse.ArgumentParser(description="Emit synthetic events per a CounterfactualSpec.")
    ap.add_argument("--spec", required=True, help="Path to spec JSON, or '-' for stdin.")
    ap.add_argument("--output", default=OUTPUT_PATH,
                    help=f"Where to write NDJSON events (default: {OUTPUT_PATH}).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print events to stdout instead of writing to the output file.")
    args = ap.parse_args()

    if args.spec == "-":
        spec = json.load(sys.stdin)
    else:
        with open(args.spec, "r") as f:
            spec = json.load(f)

    gen = spec.get("generator_spec") or spec.get("generator") or {}
    template = gen.get("template")
    severity = gen.get("severity", "INFO").upper()
    service = gen.get("service", "canary-default")
    rate = float(gen.get("rate_per_second", 1.0))
    duration = float(gen.get("duration_seconds", 30.0))
    extra_tags = gen.get("extra_tags") or {}

    if not template:
        sys.stderr.write("[generator] spec.generator_spec.template is required\n")
        return 2
    if rate <= 0 or duration <= 0:
        sys.stderr.write("[generator] rate_per_second and duration_seconds must be > 0\n")
        return 2

    run_id = str(uuid.uuid4())
    total = int(rate * duration)
    interval = 1.0 / rate if rate > 1 else 1.0
    inter_event_sleep = interval if rate < 100 else 0.01  # cap chatty rates

    sys.stderr.write(
        f"[generator] spec={spec.get('id')} run_id={run_id} "
        f"emitting {total} events at {rate}/s for {duration}s → {args.output}\n"
    )

    if args.dry_run:
        out_file = sys.stdout
    else:
        os.makedirs(os.path.dirname(args.output), exist_ok=True)
        out_file = open(args.output, "a", buffering=1)

    start = time.monotonic()
    deadline = start + duration
    idx = 0
    while time.monotonic() < deadline and idx < total:
        emit_one(template, severity, service, run_id, idx, extra_tags, out_file)
        idx += 1
        time.sleep(inter_event_sleep)

    if not args.dry_run:
        out_file.close()

    elapsed = time.monotonic() - start
    sys.stderr.write(f"[generator] done. emitted {idx} events in {elapsed:.1f}s\n")
    # Write a sidecar marker the orchestrator can read to confirm the run.
    if not args.dry_run:
        marker_path = os.path.join(
            os.path.dirname(args.output),
            f".run-{run_id}.json",
        )
        with open(marker_path, "w") as f:
            json.dump({
                "spec_id": spec.get("id"),
                "run_id": run_id,
                "emitted": idx,
                "elapsed_seconds": round(elapsed, 1),
                "rate_per_second": rate,
                "severity": severity,
                "service": service,
                "started_at": datetime.fromtimestamp(start, timezone.utc).isoformat(),
            }, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())

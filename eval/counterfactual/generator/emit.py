#!/usr/bin/env python3
"""
Synthetic event generator for the counterfactual injection harness.

Two output modes:
  - forward (default): msgpack-encoded Fluentd Forward Protocol frames
    written directly to /tenx-sockets/tenx-reporter.sock. The
    pipeline-10x engine's ForwardProtocolInputStream decodes them and
    flows the events through its template + aggregate + remote_write
    pipeline. This sidesteps Fluent Bit entirely — the generator IS
    the forwarder.
  - file: legacy NDJSON-to-file mode, kept for debugging.

Reads a CounterfactualSpec from --spec, emits events at the spec's
rate for its duration, then exits. Every event carries
`synthetic_canary: "true"` and a per-run UUID so synthetic events are
filterable from real ones.

Usage:
    python3 emit.py --spec /specs/inject-critical-burst.json
    python3 emit.py --spec - < spec.json    # spec on stdin
    python3 emit.py --spec X --output-mode file --output-path /var/log/synthetic/events.log
"""
import argparse
import json
import os
import socket
import sys
import time
import uuid
from datetime import datetime, timezone
from string import Template

try:
    import msgpack
    HAVE_MSGPACK = True
except ImportError:
    HAVE_MSGPACK = False


OUTPUT_PATH = os.environ.get("SYNTHETIC_OUTPUT_PATH", "/var/log/synthetic/events.log")
FORWARD_SOCKET = os.environ.get("FORWARD_SOCKET_PATH", "/tenx-sockets/tenx-reporter.sock")


def render_template(t: str, run_id: str, idx: int) -> str:
    """Substitute ${pod}, ${run_id}, ${idx} into the template."""
    return Template(t).safe_substitute(
        pod=f"canary-{run_id[:8]}-{idx % 10}",
        run_id=run_id,
        idx=str(idx),
    )


def build_event(template: str, severity: str, service: str, run_id: str,
                idx: int, extra_tags: dict) -> dict:
    msg = render_template(template, run_id, idx)
    # The engine's templater expects the raw message under `log`
    # (canonical k8s container-log shape). severity_level + tenx_user_service
    # are the canonical Prometheus label names per src/lib/promql.ts.
    event = {
        "log": msg,
        "severity_level": severity,
        "tenx_user_service": service,
        "stream": "stdout",
        "tenx_env": "edge",
        "synthetic_canary": "true",
        "run_id": run_id,
    }
    # Sort by depth so shallower keys are inserted before deeper ones —
    # avoids the collision case `kubernetes.labels.app` (string) then
    # `kubernetes.labels.app.kubernetes.io/name` (would need app to be a
    # dict). When a collision occurs we keep the deeper key as a flat
    # joined name on the parent (e.g. `app__kubernetes_io_name`).
    for k, v in sorted(extra_tags.items(), key=lambda kv: kv[0].count(".")):
        if "." in k:
            parts = k.split(".")
            cur = event
            ok = True
            for p in parts[:-1]:
                if isinstance(cur, dict):
                    nxt = cur.setdefault(p, {})
                    if not isinstance(nxt, dict):
                        # Collision: parent slot is already a non-dict.
                        # Flatten the rest as a synthetic key on the
                        # ROOT event to avoid losing the data.
                        event[k.replace(".", "__").replace("/", "_")] = v
                        ok = False
                        break
                    cur = nxt
                else:
                    ok = False
                    break
            if ok and isinstance(cur, dict):
                cur[parts[-1]] = v
        else:
            event[k] = v
    return event


def emit_one_file(event: dict, out_file) -> None:
    out_file.write(json.dumps(event) + "\n")
    out_file.flush()


class ForwardSink:
    """Sends events to a Fluentd Forward Protocol Unix socket.

    Message Mode (per the protocol spec):
        [tag, time, record]
    msgpack-encoded as a 3-element array.

    The engine's ForwardProtocolInputStream listens on the unix socket
    and decodes these frames. Each event becomes one TenXObject in the
    pipeline.
    """

    def __init__(self, socket_path: str, tag: str = "kube.synthetic"):
        if not HAVE_MSGPACK:
            raise RuntimeError("msgpack not installed; cannot use forward mode")
        self.socket_path = socket_path
        self.tag = tag
        self.sock = None

    def connect(self) -> None:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.socket_path)
        self.sock = s

    def emit(self, event: dict, ts: float) -> None:
        if self.sock is None:
            self.connect()
        # Message Mode: [tag, time, record]. time is integer seconds.
        frame = [self.tag, int(ts), event]
        packed = msgpack.packb(frame, use_bin_type=True)
        self.sock.sendall(packed)

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            self.sock.close()
            self.sock = None


def main() -> int:
    ap = argparse.ArgumentParser(description="Emit synthetic events per a CounterfactualSpec.")
    ap.add_argument("--spec", required=True, help="Path to spec JSON, or '-' for stdin.")
    ap.add_argument("--output-mode", choices=["forward", "file", "stdout"], default="forward",
                    help="forward (default): msgpack frames to engine's unix socket. "
                         "file: NDJSON to --output-path. stdout: NDJSON to stdout.")
    ap.add_argument("--output-path", default=OUTPUT_PATH,
                    help=f"In file mode, where to write NDJSON (default: {OUTPUT_PATH}).")
    ap.add_argument("--socket-path", default=FORWARD_SOCKET,
                    help=f"In forward mode, the engine's unix socket (default: {FORWARD_SOCKET}).")
    ap.add_argument("--forward-tag", default="kube.synthetic",
                    help="Tag to use in forward-protocol frames.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Alias for --output-mode stdout.")
    args = ap.parse_args()
    if args.dry_run:
        args.output_mode = "stdout"

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
        f"emitting {total} events at {rate}/s for {duration}s "
        f"via {args.output_mode}\n"
    )

    # Open the chosen sink.
    sink = None
    out_file = None
    if args.output_mode == "stdout":
        out_file = sys.stdout
    elif args.output_mode == "file":
        os.makedirs(os.path.dirname(args.output_path), exist_ok=True)
        out_file = open(args.output_path, "a", buffering=1)
    elif args.output_mode == "forward":
        sink = ForwardSink(args.socket_path, args.forward_tag)
        sink.connect()
        sys.stderr.write(f"[generator] forward socket connected: {args.socket_path}\n")

    start = time.monotonic()
    deadline = start + duration
    idx = 0
    errors = 0
    while time.monotonic() < deadline and idx < total:
        event = build_event(template, severity, service, run_id, idx, extra_tags)
        try:
            if sink is not None:
                sink.emit(event, time.time())
            else:
                emit_one_file(event, out_file)
        except (BrokenPipeError, ConnectionError, OSError) as e:
            errors += 1
            sys.stderr.write(f"[generator] emit error idx={idx}: {e}\n")
            if sink is not None:
                # Try one reconnect, then bail if it fails again.
                try:
                    sink.close()
                    sink.connect()
                except OSError as e2:
                    sys.stderr.write(f"[generator] reconnect failed: {e2}; aborting\n")
                    break
        idx += 1
        time.sleep(inter_event_sleep)

    if out_file is not None and out_file is not sys.stdout:
        out_file.close()
    if sink is not None:
        sink.close()

    elapsed = time.monotonic() - start
    sys.stderr.write(
        f"[generator] done. emitted {idx} events in {elapsed:.1f}s (errors={errors})\n"
    )
    return 0 if errors < idx else 1


if __name__ == "__main__":
    sys.exit(main())

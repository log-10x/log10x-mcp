#!/usr/bin/env python3
"""Minimal Fluent Forward SERVER standing in for the fluent-bit `forward` INPUT.

Docker died mid-run, so this receives the engine's return path directly on
24225 and writes every record to wire.jsonl. Purpose is narrow and worth
stating: it captures the ENGINE'S OWN BYTES so we can see whether
fullText("tenx_hash","routeState") actually splices the marker onto the wire.
It does NOT execute the shipped fluent-bit lua.
"""
import socket, msgpack, json, sys, threading

OUT = "/private/tmp/claude-501/-Users-talweiss-eclipse-workspace-l1x-co-config/377b216b-e7aa-484d-8d7b-0260f807184f/scratchpad/cx/wire.jsonl"
count = 0
lock = threading.Lock()


def emit(tag, rec):
    global count
    with lock:
        with open(OUT, "a") as f:
            f.write(json.dumps({"tag": tag, "record": rec}, default=str) + "\n")
        count += 1


def handle_entries(tag, entries):
    # Forward mode: [[time, record], ...]; Message mode: [time, record]
    if isinstance(entries, (list, tuple)) and entries and isinstance(entries[0], (list, tuple)):
        for e in entries:
            if len(e) >= 2 and isinstance(e[1], dict):
                emit(tag, e[1])
    elif isinstance(entries, (list, tuple)) and len(entries) >= 2 and isinstance(entries[1], dict):
        emit(tag, entries[1])


def dec(o):
    """The engine emits msgpack raw (bin) strings; raw=False makes the Unpacker
    try UTF-8 on every field and abort the whole stream on the first non-UTF-8
    byte. Decode explicitly instead, tolerating bad bytes."""
    if isinstance(o, (bytes, bytearray)):
        return o.decode("utf-8", "replace")
    if isinstance(o, dict):
        return {dec(k): dec(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [dec(x) for x in o]
    return o


def handle_conn(conn):
    unpacker = msgpack.Unpacker(raw=True, strict_map_key=False)
    try:
        while True:
            data = conn.recv(65536)
            if not data:
                break
            unpacker.feed(data)
            for msg in unpacker:
                msg = dec(msg)
                with open(OUT + '.debug','a') as d: d.write(repr(msg)[:1200] + '\n')
                if not isinstance(msg, (list, tuple)) or len(msg) < 2:
                    continue
                tag, second = msg[0], msg[1]
                if isinstance(second, (bytes, bytearray)):
                    # PackedForward: msgpack-encoded entries in a bin field
                    sub = msgpack.Unpacker(raw=True, strict_map_key=False)
                    sub.feed(second)
                    for e in sub:
                        handle_entries(tag, dec(e))
                else:
                    handle_entries(tag, second)
    except Exception as e:
        print("conn error:", type(e).__name__, e, file=sys.stderr)
    finally:
        conn.close()


srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", 24225))
srv.listen(8)
print("forward server listening on 127.0.0.1:24225 -> " + OUT, flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle_conn, args=(c,), daemon=True).start()

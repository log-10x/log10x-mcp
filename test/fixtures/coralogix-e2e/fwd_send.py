#!/usr/bin/env python3
"""Fluent Forward CLIENT for the engine's ForwardProtocolInputStream on 24224.

Framing derived from the engine source
(pipeline-extensions/edge-extensions/.../ForwardProtocolInputStream.java):

  * NO handshake. acceptClient() takes the connection and hands it straight to
    MessagePack.newDefaultUnpacker(). Sending a HELO/PING would be parsed as a
    data message and mis-decoded.
  * The tag must be a msgpack STR (unpacker.unpackString()). A BIN tag throws
    MessageTypeException on the engine's read thread.
  * Forward mode  [tag, [[time, record], ...]]  -> decodeForwardEntries
    Message mode   [tag, time, record]          -> INTEGER/EXTENSION branch
    PackedForward  [tag, <bin|str blob>]        -> decodePackedForward
    A trailing options map is unpackerskipValue()'d, never acted on. The engine
    NEVER sends an ack, so `chunk` must not be requested.
  * SINGLE CLIENT. server.accept() runs on the same thread that decodes, so a
    second connection sits in the backlog until the first EOFs (or the 60s
    idle watchdog force-closes it).

Usage: fwd_send.py <events.jsonl> [--mode forward|message|packed] [--tag T]
                   [--batch N] [--hold SECONDS] [--port P]
"""
import socket, msgpack, json, sys, time, argparse

ap = argparse.ArgumentParser()
ap.add_argument("events")
ap.add_argument("--mode", default="forward", choices=["forward", "message", "packed"])
ap.add_argument("--tag", default="tenx.app")
ap.add_argument("--batch", type=int, default=40)
ap.add_argument("--hold", type=float, default=8.0)
ap.add_argument("--port", type=int, default=24224)
ap.add_argument("--host", default="127.0.0.1")
args = ap.parse_args()

records = []
for line in open(args.events):
    line = line.strip()
    if line:
        records.append(json.loads(line))

now = int(time.time())
s = socket.create_connection((args.host, args.port), timeout=30)
s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
print("connected to %s:%d, %d records, mode=%s" % (args.host, args.port, len(records), args.mode), flush=True)

sent = 0


def send(payload):
    global sent
    b = msgpack.packb(payload, use_bin_type=True)
    s.sendall(b)
    sent += len(b)


if args.mode == "message":
    for r in records:
        send([args.tag, now, r])
elif args.mode == "packed":
    for i in range(0, len(records), args.batch):
        chunk = records[i:i + args.batch]
        blob = b"".join(msgpack.packb([now, r], use_bin_type=True) for r in chunk)
        send([args.tag, blob])
else:
    for i in range(0, len(records), args.batch):
        chunk = records[i:i + args.batch]
        send([args.tag, [[now, r] for r in chunk]])

print("sent %d bytes; holding %.1fs before half-close" % (sent, args.hold), flush=True)
time.sleep(args.hold)
# Half-close: the engine's decodeNextMessage() sees EOF, logs "client
# disconnected", and returns to accept(). Without this it blocks on the socket
# until the 60s idle watchdog fires.
s.shutdown(socket.SHUT_WR)
time.sleep(1.0)
s.close()
print("closed", flush=True)

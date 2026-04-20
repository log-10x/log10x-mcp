#!/usr/bin/env node
// Bypass undici's header validation by using node's raw http module to send a
// CRLF-laden traceparent. Proves the SERVER-side W3C regex rejects it.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const HOST = 'a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com';
const cw = new CloudWatchLogsClient({ region: 'us-east-1' });

function rawSubmit(tp, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    // Hand-craft the HTTP request so Node's http-client header-sanitization
    // doesn't block CR/LF in values. We write to the TCP socket directly.
    const req = http.request({
      host: HOST, port: 80, method: 'POST', path: '/streamer/query',
      insecureHTTPParser: true,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    // Splice the raw traceparent header into the request manually via socket
    // We can't use the normal req.setHeader path because that also sanitizes.
    req._implicitHeader?.();
    const origWrite = req.write.bind(req);
    // Actually, the cleanest path: write the raw header directly onto the
    // socket once it connects.
    req.on('socket', (sock) => {
      sock.once('connect', () => {
        const rawHeaders =
          `POST /streamer/query HTTP/1.1\r\n` +
          `Host: ${HOST}\r\n` +
          `Content-Type: application/json\r\n` +
          `traceparent: ${tp}\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n${body}`;
        sock.write(rawHeaders);
      });
    });
    req.end();
  });
}

// Alt approach: use net module directly (simpler and reliable)
import net from 'node:net';
function rawSubmitNet(tp, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const raw =
      `POST /streamer/query HTTP/1.1\r\n` +
      `Host: ${HOST}\r\n` +
      `Content-Type: application/json\r\n` +
      `traceparent: ${tp}\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n${body}`;
    const sock = net.createConnection({ host: HOST, port: 80 }, () => {
      sock.write(raw);
    });
    let data = '';
    sock.on('data', (c) => data += c.toString());
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

const qid = randomUUID();
const to = Date.now();
const from = to - 60_000;
const crlfTp = '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01\r\n[FAKE-INJECTED-LINE]\r\nX-Evil: 1';
console.log(`submitting with CRLF-injected traceparent (raw socket)`);
const raw = await rawSubmitNet(crlfTp, {
  id: qid, name: 'crlf-inject', from, to,
  search: 'severity_level=="ERROR"', filters: [],
  logLevels: 'ERROR,INFO,PERF', processingTime: 30_000, resultSize: 10_000,
});
const statusLine = raw.split('\r\n')[0];
console.log(`HTTP response: ${statusLine}`);
console.log(`body: ${raw.split('\r\n\r\n')[1]?.slice(0,100)}`);

// Wait for query, then scan CW for injection
await sleep(40_000);
const res = await cw.send(new FilterLogEventsCommand({
  logGroupName: '/tenx/demo-streamer/query',
  startTime: Date.now() - 180_000, endTime: Date.now(),
  filterPattern: `"${qid}"`,
  limit: 500,
}));
const events = res.events || [];
let injectionFound = false, malformedTpFound = false;
const tps = new Set();
for (const e of events) {
  if (e.message.includes('FAKE-INJECTED-LINE') || e.message.includes('X-Evil')) injectionFound = true;
  try {
    const m = JSON.parse(e.message);
    const t = m?.data?.traceparent;
    if (t) tps.add(t);
    if (t === crlfTp) malformedTpFound = true;
  } catch {}
}
console.log(`CW events for qid: ${events.length}`);
console.log(`distinct tp values in CW: ${tps.size}`);
console.log(`sample tp: ${[...tps][0]?.slice(0,60) || 'none'}`);
console.log(`injection fragment in CW: ${injectionFound}`);
console.log(`malformed-tp-leaked: ${malformedTpFound}`);

const w3c = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const allValid = [...tps].every(t => w3c.test(t));

if (injectionFound || malformedTpFound) { console.error('\nFAIL: log injection via CRLF succeeded'); process.exit(3); }
if (tps.size === 0) { console.log('\nWARN: no tp seen in CW (query may not have hit it yet)'); process.exit(2); }
if (!allValid) { console.error('\nFAIL: non-W3C tp present'); process.exit(4); }
console.log('\nPASS: CRLF injection blocked, all logged tp values are valid W3C');

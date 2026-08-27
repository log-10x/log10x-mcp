# The fenced POC

An evaluation mode where the whole POC — MCP server and log engine — runs in
one container started with `--network none`, over a log sample the user
exported with their own tools. "Cannot exfiltrate" is then a kernel fact the
user checks, not a claim we make about our own code.

Four steps. All of them boring, which is the point.

---

## The invariant

**Vendor code and network access never coexist.**

Code that sees log data has no network. Code that has network is either the
user's own `aws` / `curl`, or a script short enough for the user to read once.

That is the whole design, and everything below is bookkeeping around it.

### Why not an egress allowlist

An allowlist is the obvious alternative and it does not hold. An allowlist
constrains **hosts**, but tenancy is chosen by the **credential inside TLS**.
Vendor code carrying an attacker's own Datadog or AWS key could write the
user's logs to the attacker's tenant through an allowed host:
`api.datadoghq.com` accepts writes with any valid key, `logs.*.amazonaws.com`
serves `PutLogEvents`, and a presigned S3 `PUT` needs no credential at all.

A competent security reviewer rejects the proxy as a guarantee, and they are
right to. It is defence in depth at most; it is not the headline.

`--network none` is different in kind: there is no interface to send on, the
user can see that in `docker inspect`, and they can confirm it by unplugging.

---

## Step 1 — mint the licence, before any log data is in scope

One visible command, run by the user, on the user's own machine:

```sh
curl -s https://api.log10x.com/api/v1/license/demo -d '{}'
```

That returns a 14-day anonymous licence JWT. Export it:

```sh
export TENX_LICENSE_KEY='<the jwt>'
```

The engine verifies the JWT offline against an embedded public key, so once
minted it works for its full 14 days with no network at all. Signed-in
customers put their own longer-lived licence in the same variable.

**In this profile the MCP never mints.** A missing or expired
`TENX_LICENSE_KEY` fails in tens of milliseconds with these instructions —
never with a fetch. That is deliberate: a process holding the customer's logs
should not be reaching for credentials, and "it would have failed anyway
because there is no network" is not the same promise as "it does not try".

The ordering matters too. The mint happens *before* any log data is on the
machine, so even the one step that does use the network cannot be carrying
anything.

---

## Step 2 — export the sample, outside the fence

Ask the agent for an export script:

```
log10x_emit_sample_plan  siem=cloudwatch  window=14d  scope=/aws/ecs/*
```

It writes `export-sample.sh` and returns the same text in the reply. Scripts
exist for CloudWatch, Splunk, Elasticsearch, OpenSearch and Datadog.
ClickHouse, Azure Monitor, Coralogix, GCP Logging and Sumo Logic are follow-up
work; for those, export plain text yourself — one log message per line — into
`poc/logs/` and skip to step 3.

### Read it before you run it

The script is vendor-suggested text. What makes it trustworthy is that it is
short, stereotyped and read-only, and that reading it once is enough. Five
things to check, all of which the tool also returns as `review_checklist`:

1. **Every network call goes to your analyzer.** One API per script. `grep`
   for `curl` and `aws` and confirm there is nothing else.
2. **The only credentials it touches are yours**, read from the environment
   and sent to your own analyzer. The CloudWatch script never handles a key at
   all — it hands resolution to the `aws` CLI. The HTTP scripts write their
   header into a 0700 scratch file and pass it as `curl -H @file`, because
   `argv` is readable through `ps` by every user on the machine.
3. **Everything it writes lands under `poc/logs/`**, plus that `mktemp -d`
   scratch directory, which the `EXIT` trap removes.
4. **No log10x address appears in the file.** The server refuses to emit a
   script that names one, and a test enforces it per analyzer.
5. **The sub-windows it reads are listed as literal timestamps in the
   header**, so the time footprint is visible without running anything.

Then:

```sh
chmod +x export-sample.sh && ./export-sample.sh
```

### What it draws

The same sample the credentialed path draws. Bucket counts and per-bucket caps
come from the live connector modules, not from constants retyped in the
emitter — 24 stratified sub-windows for CloudWatch, Elasticsearch, OpenSearch
and Datadog, 12 for Splunk (a search head's default per-user job concurrency is
6). The default target is 1,000,000 events, the same default
`log10x_poc_from_siem` uses. A fenced POC and a credentialed POC over the same
window differ because the logs differ, not because two samplers disagreed.

Output is **plain text, one log message per line**, one set of part files per
source the analyzer already enumerates — per log group for CloudWatch, per
index for Elasticsearch. Plain text rather than JSONL because the multi-file
ingestion lane feeds lines to the templater verbatim, and a JSON wrapper there
gets tokenized as if the wrapper were the log. The unwrapping belongs in the
script, in `jq`, where you can see it.

Files roll at 45,000 lines or 15 MB, under the 50,000-line and 16 MB ceilings
the analysis reads per file. At the default target that is roughly 23 part
files.

---

## Step 3 — run the POC inside the fence

MCP config for the agent:

```json
{
  "mcpServers": {
    "log10x-poc": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--pull=never",
        "--network", "none", "--hostname", "localhost",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-v", "./poc/logs:/data:ro",
        "-v", "./poc/out:/out",
        "-e", "TENX_LICENSE_KEY",
        "-e", "TENX_AIRGAPPED=true",
        "log10x/poc:local"
      ],
      "env": { "TENX_LICENSE_KEY": "<the jwt from step 1>" }
    }
  }
}
```

Then ask for the POC:

```
log10x_poc_from_local  source=file  paths=["/data"]  siem=cloudwatch  window=14d
  per_pod_limit=50000  max_pods=200
```

`log10x_emit_sample_plan` returns exactly these arguments in `data.next_call`,
so the agent does not have to reconstruct them.

The report lands at `/out/log10x-poc-report.html` and the plan at
`/out/plan.md`, both on the host directory you mounted.

### What each flag is doing

| Flag | Why |
|---|---|
| `--network none` | The guarantee. No interface, no DNS, no sockets. |
| `--pull=never` | The image is the one you built and inspected, not one fetched at start. |
| `--hostname localhost` | log4j resolves the container's own hostname while configuring itself; with `--network none` docker writes no `/etc/hosts` entry for a random hostname, so every engine run would open with a 30-line `UnknownHostException`. `localhost` is already in `/etc/hosts`. |
| `--cap-drop ALL` | Nothing in here needs a capability. |
| `--security-opt no-new-privileges` | No setuid escalation path. |
| `-v ./poc/logs:/data:ro` | The sample goes in, read-only. |
| `-v ./poc/out:/out` | The report comes out. The only writable mount. |
| `-e TENX_AIRGAPPED=true` | Read by both layers: the engine's airgap switch, and the MCP's fenced profile (`src/lib/fenced.ts`). Also baked into the image, so the profile holds even if the line forgets it. |

There is **no `docker.sock` mount** and there never will be. The engine is a
native binary inside the image, spawned as a child process. Mounting the
daemon socket would be root-equivalent on the host and a one-line bypass of
every restriction above.

On Linux, `./poc/out` has to be writable by uid 1000. `mkdir -p poc/out &&
chmod 777 poc/out` avoids it; if the write fails, the reply says so and the
plan still comes back in the tool result.

---

## Step 4 — verify

One line, against the running container:

```sh
docker inspect --format \
  'network={{.HostConfig.NetworkMode}} cap_add={{.HostConfig.CapAdd}} cap_drop={{.HostConfig.CapDrop}} privileged={{.HostConfig.Privileged}} security_opt={{.HostConfig.SecurityOpt}} mounts=[{{range .Mounts}}{{.Destination}}:{{if .RW}}rw{{else}}ro{{end}} {{end}}]' \
  "$(docker ps -q --filter ancestor=log10x/poc:local)"
```

Expected, exactly:

```
network=none cap_add=[] cap_drop=[ALL] privileged=false security_opt=[no-new-privileges] mounts=[/data:ro /out:rw ]
```

Two mounts. `/data` read-only. No capabilities added, all dropped. Network
mode `none`.

**Then the check that settles it: turn Wi-Fi off and run the analysis again.**
It completes. Nothing about the result depends on a network, so nothing about
the result can have left over one.

---

## Honest residuals

State these; do not hide them.

**The plan text leaves.** Any tool that answers leaks its answer. The report
is read by a human in a chat window that is not inside the container, and if
that chat is with a hosted model, pattern bodies reach it. Nothing about the
fence changes that. What the fence does is make it the *only* path out, and
put the full detail on your own mounted directory (`/out/plan.md`) so the
transcript does not have to be the only copy.

**Docker and the kernel are the trust anchor.** `--network none` is enforced
by the host kernel's network namespaces. If that is not an anchor you accept,
the paranoid tier is the same two commands in a throwaway VM with no NIC — the
image and the script are unchanged.

**The export script is vendor-suggested text.** It is read-only and
stereotyped so that reading it once is enough, but it is still text we wrote
and you ran. That is why step 2 leads with the review pass and not with the
`chmod`.

**The sample is a sample.** The report's composition table names every source
that contributed bytes, and the projection is only as good as that mix
matching production. Confirm the table before trusting the savings figure.

---

## Building the image

There is no publish pipeline yet; build locally.

```sh
scripts/build-poc-image.sh              # log10x/poc:local
scripts/build-poc-image.sh v1.29.39     # a specific tag
```

Or by hand:

```sh
docker build -f Dockerfile.poc -t log10x/poc:local \
  --build-arg ENGINE_IMAGE=log10x/edge-10x:latest \
  --build-arg GIT_SHA="$(git rev-parse HEAD)" \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
```

Pin `ENGINE_IMAGE` to a digest for anything a customer will run: the default
tag is mutable, and a mutable tag does not identify a build.

# Fleet-default floor check

Proves on a real engine that the Receiver args a Datadog fleet-default plan writes do what the plan says. The args come straight from the rendered Fluent Bit overlay. The check replays 1,000 lines each of an ERROR, a FATAL (CRITICAL), a WARN and an INFO statement through the Receiver with a 1-byte cap, then counts what comes back per level. Above the first 5 lines, ERROR and CRITICAL pass at the error floor (half under offload) and WARN and INFO pass none. The rest take the default action.

Run it after `npm run build`, against a given image:

```
ENGINE_IMAGE=log10x/edge-10x:1.1.141 scripts/check-fleet-default-floors/run.sh
```

To run on an image older than the option, mount the config and modules trees that carry `rateReceiverDefaultAction` with `CONFIG_DIR=<config checkout> MODULES_DIR=<modules checkout>`. `ACTION=offload` or `ACTION=tier_down` runs one action; both run by default. It runs on local Docker over a private network, and the exit code is 0 only when every count is inside its bound.

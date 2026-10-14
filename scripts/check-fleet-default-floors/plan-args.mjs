// Prints the Receiver args and env a Datadog fleet-default plan writes, as JSON:
// the args are parsed from the rendered Fluent Bit overlay, so they are the
// exact list the plan hands to the engine. Needs `npm run build` first.
//   node plan-args.mjs <tier_down|offload> <capBytesPerWindowPerNode> [errorFloor]
import { RECEIVER_FORWARDER_SPECS } from '../../build/lib/advisor/reporter-forwarders.js';
import { receiverFleetValues, FLEET_DEFAULT_MIN_ENGINE } from '../../build/lib/fleet-default-install.js';

const [action = 'offload', cap = '3000', floor] = process.argv.slice(2);
const values = receiverFleetValues({
  datadog: true,
  fleetDefault: {
    capBytesPerWindowPerNode: Number(cap),
    action,
    ...(floor !== undefined ? { errorFloor: Number(floor) } : {}),
  },
  // The plan's gate, satisfied: this check runs the values on the release that reads them.
  engineVersion: FLEET_DEFAULT_MIN_ENGINE,
});
if (!values.fleetDefaultWritten) throw new Error(`fleet default not written: ${values.notes.join(' ')}`);
const yaml = RECEIVER_FORWARDER_SPECS.fluentbit.renderValues({
  licenseJwt: '',
  builtinLicense: true,
  releaseName: 'check',
  destination: 'mock',
  engineOptions: values.options,
  engineEnv: values.env,
});
const block = yaml.split('\n    args:\n')[1].split('\n    env:\n')[0];
const args = block.split('\n').map((l) => /^\s+- "(.*)"$/.exec(l)?.[1]).filter((a) => a !== undefined);
const envBlock = yaml.split('\n    env:\n')[1];
const env = [];
for (const m of envBlock.matchAll(/- name: (\S+)\n\s+value: "([^"]*)"/g)) env.push([m[1], m[2]]);
process.stdout.write(JSON.stringify({ args, env }) + '\n');

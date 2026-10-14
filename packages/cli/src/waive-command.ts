import { parseArgs } from 'node:util';
import { ConfigError, resolveCluster, suggestWaivers } from '@port-anything/core';
import type { CliResult } from './run-command.js';

const USAGE = 'Usage: port-anything waive --from-cluster [<run-id>/]<n>';

/**
 * `port-anything waive --from-cluster <id>`: prints suggested waivers for a cluster of a saved run
 * (the latest by default), to paste into `port-anything/waivers.yaml`. Cluster numbers change from
 * run to run, so the waivers are predicates on what the cluster's cases share, never its number.
 * Exit 0, or 3 when the cluster can't be found.
 */
export async function waiveCommand(argv: readonly string[], options: { cwd: string }): Promise<CliResult> {
  try {
    let address: string | undefined;
    try {
      address = parseArgs({ args: [...argv], options: { 'from-cluster': { type: 'string' } }, strict: true, allowPositionals: false }).values['from-cluster'];
    } catch (e) {
      throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
    }
    if (address === undefined) throw new ConfigError(`give the cluster to waive.\n${USAGE}`);
    const { cluster, address: full } = await resolveCluster(options.cwd, address);
    return { exitCode: 0, stdout: suggestWaivers({ address: full, signature: cluster.signature, features: cluster.features }), stderr: '' };
  } catch (e) {
    if (e instanceof ConfigError) return { exitCode: 3, stdout: '', stderr: `port-anything waive: ${e.message}\n` };
    throw e;
  }
}

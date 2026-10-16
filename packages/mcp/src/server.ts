import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { formatCase, formatFeatures, formatNext, formatProbe, formatRun, formatStatus } from './format.js';
import type { Backend, RunSelection } from './types.js';

export const SERVER_NAME = 'port-anything';

const RunInput = z
  .object({
    smoke: z.boolean().optional().describe('Run the smoke subset (the default): a case per open cluster, a few per feature, a sample of passing cases.'),
    cluster: z
      .union([z.string().min(1), z.number().int().positive()])
      .optional()
      .describe('Re-run one cluster: its number in the latest full run, or "<run-id>/<n>".'),
    feature: z.string().min(1).optional().describe('Run the cases of one feature, such as "opt.n".'),
    cases: z.array(z.string().min(1)).min(1).optional().describe('Run these cases: IDs or prefixes such as "c_9f2e1a4b".'),
  })
  .strict();

const CaseInput = z
  .object({
    id: z.string().min(1).describe('The case: its ID or a prefix, such as "c_9f2e1a4b" from a cluster or a run.'),
    candidate: z.number().int().positive().optional().describe('The candidate to run it on, from 1 as in status (default 1).'),
  })
  .strict();

const FeaturesInput = z
  .object({
    prefix: z.string().min(1).optional().describe('Only the features starting with this, such as "opt." or "cmd.add.".'),
  })
  .strict();

const ProbeInput = z
  .object({
    argv: z.array(z.string()).describe('The arguments after the program name.'),
    stdin: z.string().optional().describe('Text on stdin (default: none, /dev/null).'),
    fixtures: z.record(z.string(), z.string()).optional().describe('Files to create in the working directory first: relative path to text content.'),
    env: z.record(z.string(), z.string()).optional().describe('Variables to set on top of the case environment.'),
  })
  .strict();

/** The part of the corpus a `run` call asks for; smoke when it names none. Throws when it names several. */
export function runSelection(input: z.infer<typeof RunInput>): RunSelection {
  const given = [input.smoke === true, input.cluster !== undefined, input.feature !== undefined, input.cases !== undefined].filter(Boolean).length;
  if (given > 1) throw new Error('Give one of smoke, cluster, feature and cases.');
  if (input.cluster !== undefined) return { cluster: String(input.cluster) };
  if (input.feature !== undefined) return { feature: input.feature };
  if (input.cases !== undefined) return { cases: input.cases };
  return { smoke: true };
}

/** A tool's answer: the text, or the error as text with `isError`, so the agent reads why. */
async function answer(produce: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await produce() }] };
  } catch (e) {
    return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

/**
 * The Port Anything MCP server: `status`, `next`, `run`, `case`, `features` and `probe` over
 * `backend`. It never changes the oracle (the reference, the committed cases, the manifest): the
 * tools only run programs and save runs, repros and probes under `.port-anything/`, as the CLI does.
 */
export function createServer(backend: Backend, options: { version: string }): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: options.version });
  server.registerTool(
    'status',
    {
      title: 'Parity status',
      description: 'Headline parity per candidate, the top open divergence clusters and the integrity state, from the latest full run. Runs nothing.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => answer(async () => formatStatus(await backend.status())),
  );
  server.registerTool(
    'next',
    {
      title: 'Next cluster to fix',
      description:
        'The highest-priority open divergence cluster: signature, size, features, a minimized repro and the reference vs candidate diff. Minimizes the cluster on first call (runs both programs), then reuses the repro.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => answer(async () => formatNext(await backend.next())),
  );
  server.registerTool(
    'run',
    {
      title: 'Run cases',
      description:
        'Run the smoke subset (default), a cluster, a feature or given cases against the current candidate build. Returns what matches and the deltas against the latest full run: fixed N, broke M.',
      inputSchema: RunInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => answer(async () => formatRun(await backend.run(runSelection(input)))),
  );
  server.registerTool(
    'case',
    {
      title: 'One case in full',
      description:
        'One case in full: argv, stdin, files, env, then what the reference and a candidate do with it now (exit, stdout, stderr, changed files) and the diff after normalizers. Runs both programs once; saves no run.',
      inputSchema: CaseInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => answer(async () => formatCase(await backend.case(input.id, input.candidate))),
  );
  server.registerTool(
    'features',
    {
      title: 'Feature map',
      description:
        'The CLI spec\'s features (flags and subcommands) with how many cases test each and per-feature parity from the latest full run, marking untested, under-sampled and self-description features: the port-plan view. Runs nothing.',
      inputSchema: FeaturesInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => answer(async () => formatFeatures(await backend.features(input.prefix))),
  );
  server.registerTool(
    'probe',
    {
      title: 'Ask the reference',
      description:
        'Run one ad-hoc invocation on the reference only, in the sandbox ("what does the original do with X?"), and show what it did. Saved under .port-anything/probes/, never added to the corpus.',
      inputSchema: ProbeInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) =>
      answer(async () =>
        formatProbe(
          await backend.probe({
            argv: input.argv,
            ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
            ...(input.fixtures === undefined ? {} : { fixtures: input.fixtures }),
            ...(input.env === undefined ? {} : { env: input.env }),
          }),
        ),
      ),
  );
  return server;
}

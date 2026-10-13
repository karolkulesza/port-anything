export interface RunResult {
  exitCode: number;
  stdout: string;
}

const NOTICE = `port-anything: rewrite it in any language and show nothing changed.

Not released yet. Follow progress at https://github.com/karolkulesza/port-anything
`;

/** Runs the CLI with the given arguments (without the node and script paths). */
export function run(_argv: readonly string[]): RunResult {
  return { exitCode: 0, stdout: NOTICE };
}

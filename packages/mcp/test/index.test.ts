import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { PACKAGE_NAME, createServer, runSelection, type Backend, type ProbeInput, type RunSelection } from '../src/index.js';
import { CASE, DELTA, FEATURES, NEXT, PROBE, STATUS } from './fixtures.js';

describe('@port-anything/mcp', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@port-anything/mcp');
  });
});

describe('runSelection', () => {
  it('runs the smoke subset unless told otherwise', () => {
    expect(runSelection({})).toEqual({ smoke: true });
    expect(runSelection({ smoke: true })).toEqual({ smoke: true });
    expect(runSelection({ cluster: '3' })).toEqual({ cluster: '3' });
    expect(runSelection({ cluster: 3 })).toEqual({ cluster: '3' });
    expect(runSelection({ feature: 'opt.n' })).toEqual({ feature: 'opt.n' });
    expect(runSelection({ cases: ['c_1234'] })).toEqual({ cases: ['c_1234'] });
  });

  it('refuses several subsets at once', () => {
    expect(() => runSelection({ smoke: true, cluster: '1' })).toThrow('Give one of smoke, cluster, feature and cases.');
  });
});

describe('createServer', () => {
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function connect(backend: Backend): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(backend, { version: '9.9.9' }).connect(serverSide);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  }

  const runs: RunSelection[] = [];
  const calls: unknown[] = [];
  const backend: Backend = {
    status: async () => STATUS,
    next: async () => NEXT,
    run: async (selection) => {
      runs.push(selection);
      return DELTA;
    },
    case: async (id, candidate) => {
      calls.push(['case', id, candidate]);
      return CASE;
    },
    features: async (prefix) => {
      calls.push(['features', prefix]);
      return FEATURES;
    },
    probe: async (input: ProbeInput) => {
      calls.push(['probe', input]);
      return PROBE;
    },
  };

  it('lists the six tools, with run taking one subset', async () => {
    const c = await connect(backend);
    expect(c.getServerVersion()).toMatchObject({ name: 'port-anything', version: '9.9.9' });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['status', 'next', 'run', 'case', 'features', 'probe']);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys((tools[2]!.inputSchema as { properties: object }).properties)).toEqual(['smoke', 'cluster', 'feature', 'cases']);
    const input = (name: string) => tools.find((t) => t.name === name)!.inputSchema as { properties: object; required?: string[] };
    expect(Object.keys(input('case').properties)).toEqual(['id', 'candidate']);
    expect(input('case').required).toEqual(['id']);
    expect(Object.keys(input('features').properties)).toEqual(['prefix']);
    expect(tools.find((t) => t.name === 'features')!.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(input('probe').properties)).toEqual(['argv', 'stdin', 'fixtures', 'env']);
    expect(input('probe').required).toEqual(['argv']);
  });

  it('case, features and probe pass their arguments on and answer with the formatted text', async () => {
    const c = await connect(backend);
    const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { type: string; text: string }[])[0]!.text;
    calls.length = 0;
    expect(text(await c.callTool({ name: 'case', arguments: { id: 'c_9f2e' } }))).toContain('case c_9f2e1a4b · generated');
    expect(text(await c.callTool({ name: 'case', arguments: { id: 'c_9f2e', candidate: 2 } }))).toContain('reference:\n  exit 0');
    expect(text(await c.callTool({ name: 'features', arguments: {} }))).toContain('opt.n · -n, --numeric-sort · 40 cases');
    expect(text(await c.callTool({ name: 'features', arguments: { prefix: 'opt.' } }))).toContain('spec port-anything/cli-spec.yaml');
    expect(text(await c.callTool({ name: 'probe', arguments: { argv: ['-k', '2'], stdin: 'b 2\na 1\n' } }))).toContain('probe 20261016-091500-e5f6, reference only');
    await c.callTool({ name: 'probe', arguments: { argv: [], fixtures: { 'a.txt': 'x' }, env: { A: '1' } } });
    expect(calls).toEqual([
      ['case', 'c_9f2e', undefined],
      ['case', 'c_9f2e', 2],
      ['features', undefined],
      ['features', 'opt.'],
      ['probe', { argv: ['-k', '2'], stdin: 'b 2\na 1\n' }],
      ['probe', { argv: [], fixtures: { 'a.txt': 'x' }, env: { A: '1' } }],
    ]);
  });

  it('refuses bad arguments to case, features and probe', async () => {
    const c = await connect(backend);
    for (const [name, args] of [
      ['case', {}],
      ['case', { id: 'x', candidate: 0 }],
      ['features', { prefix: '' }],
      ['probe', {}],
      ['probe', { argv: 'x' }],
      ['probe', { argv: [], extra: 1 }],
    ] as const) {
      const r = await c.callTool({ name, arguments: args });
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  });

  it('answers each tool with the formatted text', async () => {
    const c = await connect(backend);
    const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { type: string; text: string }[])[0]!.text;
    expect(text(await c.callTool({ name: 'status', arguments: {} }))).toContain('parity 93.4%');
    expect(text(await c.callTool({ name: 'next', arguments: {} }))).toContain('repro (minimized from c_9f2e1a4b)');
    runs.length = 0;
    expect(text(await c.callTool({ name: 'run', arguments: { cluster: '1' } }))).toContain('fixed 10, broke 0');
    expect(text(await c.callTool({ name: 'run', arguments: {} }))).toContain('fixed 10');
    expect(runs).toEqual([{ cluster: '1' }, { smoke: true }]);
  });

  it('returns errors as text the agent can read', async () => {
    const c = await connect({ ...backend, status: async () => Promise.reject(new Error('No port-anything.yaml in /x.')) });
    const result = await c.callTool({ name: 'status', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'No port-anything.yaml in /x.' }]);
    const both = await c.callTool({ name: 'run', arguments: { smoke: true, feature: 'x' } });
    expect(both.isError).toBe(true);
  });
});

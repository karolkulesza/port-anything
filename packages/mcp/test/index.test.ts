import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { PACKAGE_NAME, createServer, runSelection, type Backend, type RunSelection } from '../src/index.js';
import { DELTA, NEXT, STATUS } from './fixtures.js';

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
  const backend: Backend = {
    status: async () => STATUS,
    next: async () => NEXT,
    run: async (selection) => {
      runs.push(selection);
      return DELTA;
    },
  };

  it('lists status, next and run, with run taking one subset', async () => {
    const c = await connect(backend);
    expect(c.getServerVersion()).toMatchObject({ name: 'port-anything', version: '9.9.9' });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['status', 'next', 'run']);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys((tools[2]!.inputSchema as { properties: object }).properties)).toEqual(['smoke', 'cluster', 'feature', 'cases']);
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

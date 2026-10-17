import packageJson from '../package.json' with { type: 'json' };

/** This port-anything's version, as published. */
export const TOOL_VERSION: string = packageJson.version;

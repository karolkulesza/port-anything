#!/usr/bin/env node
import { run } from './run.js';

const { exitCode, stdout, stderr } = await run(process.argv.slice(2));
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;

#!/usr/bin/env node
import { run } from './run.js';

const { exitCode, stdout } = run(process.argv.slice(2));
process.stdout.write(stdout);
process.exitCode = exitCode;

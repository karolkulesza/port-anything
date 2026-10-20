// The worker `port-anything hook` starts in a process group of its own, so it can stop the build
// and the smoke run together: prints the text for the agent and exits 0, or fails with the error.
import { smokeText } from './hook-command.js';

const text = await smokeText(process.argv[2]!);
// Exits once the text is out, rather than waiting for a handle something left open.
process.stdout.write(text, () => process.exit(0));

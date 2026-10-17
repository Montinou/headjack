// A `node --import` preload for tests: appends the URL of every module the process resolves to the file named by
// HEADJACK_TRACE_FILE (one per line), so a test can assert what a spawned entry did and did not load. Needs
// module.registerHooks (Node 22.15+, 23.5+); `traceSupported` tells a test whether to skip.
import { appendFileSync } from 'node:fs';
import * as nodeModule from 'node:module';

export const traceSupported = typeof nodeModule.registerHooks === 'function';

if (traceSupported && process.env.HEADJACK_TRACE_FILE) {
  const file = process.env.HEADJACK_TRACE_FILE;
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      appendFileSync(file, `${resolved.url}\n`);
      return resolved;
    },
  });
}

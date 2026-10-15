// Loaded with `node --import`: any module specifier starting with `flags` or `@flags-sdk` fails to resolve, so a
// process that loads the Flags SDK (statically or through an executed dynamic import) throws.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('flags') || specifier.startsWith('@flags-sdk')) {
      throw new Error(`blocked by test/block-flags.mjs: ${specifier}`);
    }
    return nextResolve(specifier, context);
  },
});

// Test-only boundary control for the real CLI child. Never changes performance.now or t0.
import { mock } from 'node:test';
import { appendFileSync } from 'node:fs';
import { setTimeout as realTimeout, setInterval as realInterval } from 'node:timers';

const budget = Number(process.env.HOOK_TEST_BUDGET);
const record = event => appendFileSync(process.env.HOOK_TEST_TRACE, `${JSON.stringify(event)}\n`);
const mode = process.env.HOOK_TEST_BOUNDARY;
let requests = 0;
// Discovery stays pending before credential locking: no refresh POST or credential-file cleanup.
globalThis.fetch = (url, init) => {
  record({ event: 'request', url: String(url), method: init?.method ?? 'GET' });
  requests++;
  if (mode === 'discovery' && requests === 2) {
    // Both discovery promises have been returned before advancing the controlled timer.
    setImmediate(() => {
      record({ event: 'expire', requests });
      mock.timers.tick(budget);
    });
  }
  return new Promise(() => {});
};
if (mode === 'startup') {
  // Spend the real startup budget before CLI import; its production t0 remains zero.
  await new Promise(resolve => realTimeout(resolve, budget));
  record({ event: 'startup-exhausted', elapsed: performance.now() });
  mock.timers.enable({ apis: ['setTimeout'] });
  const schedule = globalThis.setTimeout;
  mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args);
    if (delay === 0) {
      record({ event: 'startup-deadline', remaining: delay });
      // Run the already-due deadline before allowing credential I/O to race the timer.
      // The stdin timer (2000 ms) is left alone; no product clock/origin is replaced.
      mock.timers.tick(1);
    }
    return timer;
  });
} else if (mode === 'discovery') {
  mock.timers.enable({ apis: ['setTimeout'] });
  // A pending refresh can keep Node alive. Only hookMain's explicit exit should end this child.
  realInterval(() => {}, budget);
} else {
  throw new Error('unknown hook test boundary');
}

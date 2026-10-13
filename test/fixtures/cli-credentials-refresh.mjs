// Child process for the credential lock contention test: reads the stored OAuth credential, reports `ready`, waits for
// `go` on stdin (so every contender holds the same expired credential before any of them refreshes), then refreshes
// through freshCredential and prints the access token it ended up with.
import { createInterface } from 'node:readline';
import { readCredential, freshCredential } from '../../cli/credentials.mjs';

const dir = process.argv[2];
const credential = await readCredential({ env: {}, dir });
process.stdout.write('ready\n');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === 'go') break;
}
lines.close();
const fresh = await freshCredential({ dir, credential });
process.stdout.write(`${JSON.stringify({ accessToken: fresh.accessToken })}\n`);

// Entry lifecycle for the make.fun trial env (see env/src/wire.ts in the kit).
// The env tells the entry where it lives through MAKEFUN_ENV_URL. The entry
// binds an ephemeral port, reports that port to the env, then polls the env
// until the trial is over. Nothing else happens here: the forge itself lives
// in app.ts, and this file only wires it to the harness.
//
// Steps, in order:
//   1. Without MAKEFUN_ENV_URL there is no env to talk to: exit 1 at once.
//   2. Listen on port 0 so the kernel picks a free one. Never 8080: the env
//      owns it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. A 200 means the env
//      recorded us; a 409 means another entry registered first, which is
//      fine — we still wait for done like everyone else. 400/405 are
//      contract errors and end the process; anything else is retried.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//      answers immediately ({"done": false} while the suite runs), so poll
//      with a short exponential backoff instead of holding a request open.
//   5. Close the server and exit 0. The harness then stops the env.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

/** Cap on one register/done request before it is abandoned and retried. */
const PER_REQUEST_MS = 30_000;
/** First pause between retries, and the longest pause. */
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `failures` failed attempts: exponential, capped at the ceiling. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

/** Register the bound port with the env, retrying until it is accepted. */
async function postRegister(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(PER_REQUEST_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoffMs(failures));
  }
}

/** Keep asking the env whether the trial is over; return only once it is. */
async function pollDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envBase}/done`, {
        signal: AbortSignal.timeout(PER_REQUEST_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer yet, or the request timed out: not done, so keep polling.
    }
    await pause(backoffMs(failures));
  }
}

/** Bind, register, wait for done: the whole life of this process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await postRegister(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await pollDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// Entrypoint: the harness lifecycle for the forge.
//
// The trial harness owns this process's lifetime. It hands us the env's origin in
// MAKEFUN_ENV_URL; we start the HTTP server from app.ts on a kernel-chosen port (never a
// fixed one, and never 8080, which belongs to the env), announce that port with
// POST $MAKEFUN_ENV_URL/register, and then keep polling GET $MAKEFUN_ENV_URL/done until
// the env reports the trial is finished. Only then do we close the server and exit 0 —
// leaving earlier would abandon a trial still being scored.
//
// Both env calls are retried with a capped exponential backoff: the env may still be
// booting when we first call, and a slow or failed poll says nothing about whether the
// trial is over. A 409 from register means another process registered first and is not
// an error for us; a 400 or 405 is a contract violation and ends the program.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  console.error('[forge] MAKEFUN_ENV_URL is not set; there is no env to register with');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff after `failures` consecutive failed attempts: 250 ms doubling to a 2 s cap. */
function backoff(failures: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(failures, 8));
}

async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let fatal: Error | null = null;
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        fatal = new Error(`register refused with HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      // A network failure or timeout just means the env is not up yet; retry below.
      if (fatal === null && err instanceof Error && err.message.startsWith('register refused')) fatal = err;
    }
    if (fatal !== null) throw fatal;
    await pause(backoff(failures));
    failures += 1;
  }
}

async function awaitTrialEnd(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Unreachable or slow env: the trial is not over, so keep polling.
    }
    await pause(backoff(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  console.log(`[forge] serving on ephemeral port ${port}`);

  await announcePort(port);
  console.log('[forge] registered with the env; awaiting the end of the trial');

  await awaitTrialEnd();
  server.close();
  console.log('[forge] trial done; exiting');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  console.error(`[forge] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

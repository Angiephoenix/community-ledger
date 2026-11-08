import { describe, expect, it } from 'vitest';
import { canCheckAgain, createReturnChecker, onRestoredPage, sessionCheckout, type ReturnStatus } from '../src/connected/returnCheck';

// The check after a member comes back from the hosted checkout
// (src/connected/returnCheck.ts). No network: the server, session and
// storage are fakes.

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run until `ready()` holds. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 50 && !ready(); i++) await Promise.resolve();
  if (!ready()) throw new Error('condition not reached');
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
}

function setup(opts: { user?: string | null; saved?: { reference: string; userId: string | null } | null } = {}) {
  const storage = memoryStorage();
  const box = sessionCheckout(storage, null);
  if (opts.saved !== null) box.save(opts.saved?.reference ?? 'CL-TEST1', opts.saved?.userId === undefined ? 'user-a' : opts.saved.userId);
  const world = {
    user: opts.user === undefined ? 'user-a' : opts.user,
    shown: [] as (ReturnStatus | undefined)[],
    verifyCalls: [] as string[],
    refreshes: 0,
    answers: [] as (() => Promise<{ status?: unknown }>)[],
  };
  const checker = createReturnChecker({
    load: () => box.load(),
    clear: () => box.clear(),
    currentUserId: async () => world.user,
    verify: (reference) => {
      world.verifyCalls.push(reference);
      const next = world.answers.shift();
      return next ? next() : Promise.resolve({ status: 'abandoned' });
    },
    refresh: async () => {
      world.refreshes += 1;
    },
    show: (s) => world.shown.push(s),
  });
  return { world, checker, storage, box };
}

describe('the message comes from the server, not from coming back', () => {
  it.each(['confirmed', 'failed', 'abandoned', 'held', 'not-found'] as const)('a final answer (%s) is shown and the saved checkout is cleared', async (status) => {
    const { world, checker, box } = setup();
    world.answers.push(async () => ({ status }));
    await checker.run();
    expect(world.shown).toEqual(['checking', status]);
    expect(box.load()).toBeNull();
    expect(world.refreshes).toBe(1);
  });

  it.each(['started', 'pending'] as const)('a non-final answer (%s) keeps the saved checkout so it can be checked again', async (status) => {
    const { world, checker, box } = setup();
    world.answers.push(async () => ({ status }));
    await checker.run();
    expect(world.shown).toEqual(['checking', status]);
    expect(box.load()?.reference).toBe('CL-TEST1');
    expect(canCheckAgain(status)).toBe(true);
  });

  it('an unknown or missing status is treated as "could not check", never as an outcome', async () => {
    for (const answer of [{}, { status: 'success' }, { status: 42 }]) {
      const { world, checker, box } = setup();
      world.answers.push(async () => answer);
      await checker.run();
      expect(world.shown).toEqual(['checking', 'checking-unavailable']);
      expect(box.load()).not.toBeNull();
    }
  });

  it('with nothing saved, coming back shows nothing and asks nothing', async () => {
    const { world, checker } = setup({ saved: null });
    await checker.run();
    expect(world.verifyCalls).toEqual([]);
    expect(world.shown).toEqual([]);
  });
});

describe('a page restored from the back/forward cache', () => {
  it('runs the check on a restored page (pageshow persisted) but not on an ordinary load', async () => {
    const { world, checker } = setup();
    const target = new EventTarget();
    let runs = 0;
    onRestoredPage(target, () => {
      runs += 1;
      void checker.run();
    });
    const ordinary = new Event('pageshow');
    Object.assign(ordinary, { persisted: false });
    target.dispatchEvent(ordinary);
    expect(runs).toBe(0);
    const restored = new Event('pageshow');
    Object.assign(restored, { persisted: true });
    target.dispatchEvent(restored);
    expect(runs).toBe(1);
    await checker.run(); // joins the check started by the event
    expect(world.verifyCalls).toEqual(['CL-TEST1']);
    expect(world.shown).toEqual(['checking', 'abandoned']);
  });
});

describe('overlapping triggers', () => {
  it('start-up and a restored-page event at the same time make one request and one result', async () => {
    const { world, checker } = setup();
    const answer = deferred<{ status?: unknown }>();
    world.answers.push(() => answer.promise);
    const a = checker.run();
    const b = checker.run();
    expect(a).toBe(b);
    answer.resolve({ status: 'failed' });
    await Promise.all([a, b]);
    expect(world.verifyCalls).toEqual(['CL-TEST1']);
    expect(world.shown).toEqual(['checking', 'failed']);
  });

  it('a later trigger after the first check finished starts a new check', async () => {
    const { world, checker } = setup();
    world.answers.push(async () => ({ status: 'pending' }), async () => ({ status: 'confirmed' }));
    await checker.run();
    await checker.run();
    expect(world.verifyCalls).toEqual(['CL-TEST1', 'CL-TEST1']);
    expect(world.shown).toEqual(['checking', 'pending', 'checking', 'confirmed']);
  });
});

describe('verification unavailable', () => {
  it('shows "could not check", keeps the saved checkout, and a retry can complete it', async () => {
    const { world, checker, box } = setup();
    world.answers.push(async () => {
      throw new TypeError('fetch failed');
    });
    await checker.run();
    expect(world.shown).toEqual(['checking', 'checking-unavailable']);
    expect(box.load()?.reference).toBe('CL-TEST1');
    expect(canCheckAgain('checking-unavailable')).toBe(true);
    expect(world.refreshes).toBe(0);

    world.answers.push(async () => ({ status: 'abandoned' }));
    await checker.run();
    expect(world.shown).toEqual(['checking', 'checking-unavailable', 'checking', 'abandoned']);
    expect(box.load()).toBeNull();
  });
});

describe('stale answers never reach another account', () => {
  it('an answer that arrives after sign-out and another sign-in is ignored', async () => {
    const { world, checker } = setup();
    const answer = deferred<{ status?: unknown }>();
    world.answers.push(() => answer.promise);
    const run = checker.run();
    await until(() => world.verifyCalls.length === 1);
    // Account A signs out and account B signs in while the request is out.
    checker.invalidate();
    world.user = 'user-b';
    answer.resolve({ status: 'confirmed' });
    await run;
    expect(world.shown).toEqual(['checking']); // nothing after it
    expect(world.refreshes).toBe(0);
  });

  it('signing out before the request is sent stops the check without asking the server', async () => {
    const { world, checker } = setup();
    const run = checker.run();
    checker.invalidate();
    await run;
    expect(world.verifyCalls).toEqual([]);
    expect(world.shown).toEqual([]);
  });

  it('a failure that arrives after sign-out is ignored too', async () => {
    const { world, checker } = setup();
    const answer = deferred<{ status?: unknown }>();
    world.answers.push(() => answer.promise);
    const run = checker.run();
    await until(() => world.verifyCalls.length === 1);
    checker.invalidate();
    answer.reject(new Error('fetch failed'));
    await run;
    expect(world.shown).toEqual(['checking']);
  });

  it('after invalidation a new trigger starts its own check instead of joining the old one', async () => {
    const { world, checker } = setup();
    const first = deferred<{ status?: unknown }>();
    world.answers.push(() => first.promise, async () => ({ status: 'abandoned' }));
    const old = checker.run();
    await until(() => world.verifyCalls.length === 1);
    checker.invalidate();
    const fresh = checker.run();
    expect(fresh).not.toBe(old);
    await fresh;
    first.resolve({ status: 'confirmed' });
    await old;
    expect(world.shown).toEqual(['checking', 'checking', 'abandoned']);
  });

  it("a checkout opened by another account in this tab is not checked as this account's", async () => {
    const { world, checker, box } = setup({ user: 'user-b', saved: { reference: 'CL-OF-A', userId: 'user-a' } });
    await checker.run();
    expect(world.verifyCalls).toEqual([]);
    expect(world.shown).toEqual([]);
    expect(box.load()).toBeNull();
  });

  it('nobody signed in: nothing is checked', async () => {
    const { world, checker } = setup({ user: null });
    await checker.run();
    expect(world.verifyCalls).toEqual([]);
  });
});

describe('saved checkout storage', () => {
  it('reads the older plain-string format and a reference carried only by the return address', () => {
    const s = memoryStorage();
    s.setItem('community-ledger.checkout-reference', 'CL-OLDFORMAT');
    expect(sessionCheckout(s, null).load()).toEqual({ reference: 'CL-OLDFORMAT', userId: null });
    const empty = memoryStorage();
    expect(sessionCheckout(empty, 'CL-FROMURL').load()).toEqual({ reference: 'CL-FROMURL', userId: null });
    expect(sessionCheckout(null, null).load()).toBeNull();
  });
});

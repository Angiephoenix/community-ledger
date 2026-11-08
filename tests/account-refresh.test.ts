import { describe, expect, it } from 'vitest';
import { createAccountRefresh, type Who } from '../src/connected/accountRefresh';
import { createReturnChecker, sessionCheckout, type ReturnStatus } from '../src/connected/returnCheck';

// Account switches while a refresh is already in flight
// (src/connected/accountRefresh.ts, used by src/state/store.ts).

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function until(ready: () => boolean) {
  for (let i = 0; i < 100 && !ready(); i++) await Promise.resolve();
  if (!ready()) throw new Error('condition not reached');
}

const A = { id: 'user-a', email: 'a@example.test' };
const B = { id: 'user-b', email: 'b@example.test' };

/** A tiny stand-in for the store: what the screen would show. */
function world() {
  const w = {
    generation: 0,
    session: A as { id: string; email: string } | null,
    screen: { status: 'ready' as string, owner: 'user-a', email: 'a@example.test' },
    writes: [] as string[],
    whoami: (() => Promise.resolve({ memberId: 'member-a', isOfficer: false })) as () => Promise<Who>,
    snapshot: (() => Promise.resolve({ ledgerOf: 'user-a' })) as () => Promise<{ ledgerOf: string }>,
    snapshotCalls: 0,
    switchTo(user: typeof B | null) {
      // What sign-out followed by sign-in does in the store.
      w.generation += 1;
      w.session = user;
      w.screen = user ? { status: 'ready', owner: user.id, email: user.email } : { status: 'signed-out', owner: '', email: '' };
    },
  };
  const refresh = createAccountRefresh({
    generation: () => w.generation,
    sessionUser: async () => w.session,
    whoami: () => w.whoami(),
    loadSnapshot: () => {
      w.snapshotCalls += 1;
      return w.snapshot();
    },
    onReady: ({ snapshot, email }) => {
      w.writes.push('ready');
      w.screen = { status: 'ready', owner: snapshot.ledgerOf, email: email ?? '' };
    },
    onUnlinked: () => {
      w.writes.push('unlinked');
      w.screen = { status: 'unlinked', owner: '', email: '' };
    },
    onError: () => {
      w.writes.push('error');
      w.screen = { status: 'error', owner: '', email: '' };
    },
  });
  return { w, refresh };
}

describe('a refresh started for one account never writes after the account changes', () => {
  it("the reported case: A's verification completes, A's snapshot is in flight, B signs in, A's snapshot arrives", async () => {
    const { w, refresh } = world();
    const storage = new Map<string, string>();
    const box = sessionCheckout({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) }, null);
    box.save('CL-OF-A', 'user-a');
    const shown: (ReturnStatus | undefined)[] = [];
    const checker = createReturnChecker({
      load: () => box.load(),
      clear: () => box.clear(),
      currentUserId: async () => w.session?.id ?? null,
      verify: async () => ({ status: 'abandoned' }),
      refresh: async () => {
        await refresh();
      },
      show: (s) => shown.push(s),
    });
    const snap = deferred<{ ledgerOf: string }>();
    w.snapshot = () => snap.promise;

    const run = checker.run();
    await until(() => w.snapshotCalls === 1); // verification done, A's snapshot request in flight
    checker.invalidate();
    w.switchTo(B);
    snap.resolve({ ledgerOf: 'user-a' });
    await run;

    expect(w.writes).toEqual([]);
    expect(w.screen).toEqual({ status: 'ready', owner: 'user-b', email: 'b@example.test' });
    expect(shown).toEqual(['checking']); // A's result is not shown to B
  });

  it('a snapshot that arrives after sign-out (nobody signed in) is dropped', async () => {
    const { w, refresh } = world();
    const snap = deferred<{ ledgerOf: string }>();
    w.snapshot = () => snap.promise;
    const p = refresh();
    await until(() => w.snapshotCalls === 1);
    w.switchTo(null);
    snap.resolve({ ledgerOf: 'user-a' });
    expect(await p).toBe('stale');
    expect(w.writes).toEqual([]);
    expect(w.screen.status).toBe('signed-out');
  });

  it('an "unlinked" answer for the previous account is dropped', async () => {
    const { w, refresh } = world();
    const who = deferred<Who>();
    let asked = false;
    w.whoami = () => {
      asked = true;
      return who.promise;
    };
    const p = refresh();
    await until(() => asked);
    w.switchTo(B);
    who.resolve({ memberId: null, isOfficer: false });
    expect(await p).toBe('stale');
    expect(w.writes).toEqual([]);
  });

  it('an error for the previous account is dropped', async () => {
    const { w, refresh } = world();
    const snap = deferred<{ ledgerOf: string }>();
    w.snapshot = () => snap.promise;
    const p = refresh();
    await until(() => w.snapshotCalls === 1);
    w.switchTo(B);
    snap.reject(new TypeError('fetch failed'));
    expect(await p).toBe('stale');
    expect(w.writes).toEqual([]);
  });

  it('another tab switching the shared session (no sign-in in this tab) also drops the result', async () => {
    const { w, refresh } = world();
    const snap = deferred<{ ledgerOf: string }>();
    w.snapshot = () => snap.promise;
    const p = refresh();
    await until(() => w.snapshotCalls === 1);
    w.session = B; // generation unchanged
    snap.resolve({ ledgerOf: 'user-a' });
    expect(await p).toBe('stale');
    expect(w.writes).toEqual([]);
  });
});

describe('ordinary refreshes still write', () => {
  it('ready, with the email of the account it loaded', async () => {
    const { w, refresh } = world();
    expect(await refresh()).toBe('ready');
    expect(w.screen).toEqual({ status: 'ready', owner: 'user-a', email: 'a@example.test' });
  });
  it('unlinked', async () => {
    const { w, refresh } = world();
    w.whoami = async () => ({ memberId: null, isOfficer: false });
    expect(await refresh()).toBe('unlinked');
    expect(w.writes).toEqual(['unlinked']);
  });
  it('error', async () => {
    const { w, refresh } = world();
    w.snapshot = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await refresh()).toBe('error');
    expect(w.writes).toEqual(['error']);
  });
});

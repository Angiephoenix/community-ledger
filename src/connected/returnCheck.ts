// Checking a payment after the member comes back from the provider's hosted
// checkout. Kept free of React, Supabase and the browser so every case can be
// tested (tests/return-check.test.ts).
//
// Rules:
// - The message always comes from the server's answer (which asks the
//   provider). Coming back, or closing the provider's page, proves nothing.
// - The saved checkout is checked on start-up AND when the browser shows a
//   page restored from its back/forward cache (that page does not start up
//   again, so a start-up-only check never runs there).
// - One check at a time: overlapping triggers share the check in progress.
// - A check started for one signed-in account never updates the screen after
//   that account signs out or another signs in (generation + user id).
// - The saved reference is kept until the answer is final, so a check that
//   could not be completed can be retried.

export type ReturnStatus =
  | 'checking'
  | 'confirmed'
  | 'pending'
  | 'failed'
  | 'abandoned'
  | 'held'
  | 'checking-unavailable'
  | 'not-found'
  | 'started';

/** Answers after which there is nothing more to check for this checkout. */
const FINAL = new Set<ReturnStatus>(['confirmed', 'failed', 'abandoned', 'held', 'not-found']);
/** Answers the server can give (anything else is treated as "could not check"). */
const KNOWN = new Set<string>(['confirmed', 'pending', 'failed', 'abandoned', 'held', 'checking-unavailable', 'not-found', 'started']);

export interface SavedCheckout {
  reference: string;
  /** The account that opened the checkout; null when only the return address carried the reference. */
  userId: string | null;
}

export interface ReturnCheckDeps {
  /** The checkout saved in this tab when it was opened, if any. */
  load(): SavedCheckout | null;
  clear(): void;
  /** The signed-in user's id, or null if nobody is signed in. */
  currentUserId(): Promise<string | null>;
  /** Asks the server (which asks the provider). Throws if it cannot be reached. */
  verify(reference: string): Promise<{ status?: unknown }>;
  /** Reloads the signed-in account's records. */
  refresh(): Promise<void>;
  /** Shows a result (undefined hides it). */
  show(status: ReturnStatus | undefined): void;
}

export function createReturnChecker(deps: ReturnCheckDeps) {
  let generation = 0;
  let current: Promise<void> | null = null;

  async function check(gen: number): Promise<void> {
    const saved = deps.load();
    if (!saved) return;
    const userId = await deps.currentUserId();
    if (gen !== generation || !userId) return;
    if (saved.userId && saved.userId !== userId) {
      // Opened by another account in this tab: never check it as this one.
      deps.clear();
      return;
    }
    deps.show('checking');
    let answer: { status?: unknown };
    try {
      answer = await deps.verify(saved.reference);
    } catch {
      if (gen === generation) deps.show('checking-unavailable');
      return;
    }
    if (gen !== generation || (await deps.currentUserId()) !== userId) return;
    const status: ReturnStatus = typeof answer?.status === 'string' && KNOWN.has(answer.status) ? (answer.status as ReturnStatus) : 'checking-unavailable';
    if (FINAL.has(status)) deps.clear();
    await deps.refresh();
    if (gen !== generation) return;
    deps.show(status);
  }

  return {
    /** Runs a check, or joins the one already running. */
    run(): Promise<void> {
      if (current) return current;
      const gen = generation;
      const p = check(gen).finally(() => {
        if (current === p) current = null;
      });
      current = p;
      return p;
    },
    /** Call on sign-in and sign-out: any check in progress is ignored when it finishes. */
    invalidate() {
      generation += 1;
      current = null;
    },
  };
}

/**
 * Runs `onShow` when the browser shows a page restored from its back/forward
 * cache (`pageshow` with `persisted`). An ordinary load is left to start-up.
 */
export function onRestoredPage(target: Pick<EventTarget, 'addEventListener'>, onShow: () => void) {
  target.addEventListener('pageshow', (e) => {
    if ((e as Event & { persisted?: boolean }).persisted) onShow();
  });
}

/** Statuses for which the member may ask to check again. */
export function canCheckAgain(status: ReturnStatus | undefined): boolean {
  return status === 'checking-unavailable' || status === 'started' || status === 'pending';
}

const KEY = 'community-ledger.checkout-reference';

/** The saved checkout in this tab's session storage (old plain-string values are accepted). */
export function sessionCheckout(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, urlReference: string | null) {
  return {
    load(): SavedCheckout | null {
      let raw: string | null = null;
      try {
        raw = storage?.getItem(KEY) ?? null;
      } catch {
        raw = null;
      }
      if (raw) {
        try {
          const v = JSON.parse(raw) as Partial<SavedCheckout>;
          if (v && typeof v.reference === 'string') return { reference: v.reference, userId: typeof v.userId === 'string' ? v.userId : null };
        } catch {
          return { reference: raw, userId: null };
        }
      }
      return urlReference ? { reference: urlReference, userId: null } : null;
    },
    save(reference: string, userId: string | null) {
      try {
        storage?.setItem(KEY, JSON.stringify({ reference, userId }));
      } catch {
        /* the return address still carries the reference */
      }
    },
    clear() {
      urlReference = null;
      try {
        storage?.removeItem(KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

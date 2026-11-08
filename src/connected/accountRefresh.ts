// Loading the signed-in account's records into the screen. Kept free of the
// store and Supabase so the account-switch cases can be tested
// (tests/account-refresh.test.ts).
//
// A refresh belongs to the account that was signed in when it started. Its
// result (ready, unlinked or error) is written only if, when it arrives:
// - the store's account generation is unchanged (sign-in and sign-out bump
//   it), and
// - the session still belongs to the same user (another tab can switch the
//   shared session without this tab signing in or out).
// Otherwise the result is dropped: it must never show one account's records
// under another account.

export interface Who {
  memberId: string | null;
  isOfficer: boolean;
}

export interface AccountRefreshDeps<Snapshot> {
  /** Changes whenever this tab signs in or out. */
  generation(): number;
  /** The session's user, or null if nobody is signed in. */
  sessionUser(): Promise<{ id: string; email?: string } | null>;
  whoami(): Promise<Who>;
  loadSnapshot(isOfficer: boolean): Promise<Snapshot>;
  onReady(result: { who: Who; snapshot: Snapshot; email?: string }): void;
  onUnlinked(): void;
  onError(): void;
}

export function createAccountRefresh<Snapshot>(deps: AccountRefreshDeps<Snapshot>) {
  return async function refresh(): Promise<'ready' | 'unlinked' | 'error' | 'stale'> {
    const gen = deps.generation();
    let userId: string | null = null;
    // Still the same account as when this refresh started?
    const current = async () => {
      if (deps.generation() !== gen) return false;
      const u = await deps.sessionUser();
      return deps.generation() === gen && (u?.id ?? null) === userId;
    };
    try {
      userId = (await deps.sessionUser())?.id ?? null;
      if (deps.generation() !== gen) return 'stale';
      const who = await deps.whoami();
      if (!who.memberId && !who.isOfficer) {
        if (!(await current())) return 'stale';
        deps.onUnlinked();
        return 'unlinked';
      }
      const snapshot = await deps.loadSnapshot(who.isOfficer);
      if (deps.generation() !== gen) return 'stale';
      const u = await deps.sessionUser();
      if (deps.generation() !== gen || (u?.id ?? null) !== userId) return 'stale';
      deps.onReady({ who, snapshot, email: u?.email });
      return 'ready';
    } catch {
      if (!(await current().catch(() => false))) return 'stale';
      deps.onError();
      return 'error';
    }
  };
}

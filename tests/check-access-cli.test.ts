import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error plain ESM test helper without types
import { ACCOUNTS, startStub } from './support/stub-supabase.mjs';

// Runs the REAL scripts/check-access.mjs in a pseudo-terminal (via Python's
// pty module) against a local stub of the Supabase API, typing dummy
// credentials the way a person would. This is what the decision-logic tests
// could not catch: the first version's prompt label was erased by readline and
// end of input left a promise unsettled.

type Account = { email: string; password: string; token: string };
const accounts = ACCOUNTS as Record<string, Account>;
const python = spawnSync('python3', ['-c', 'import pty, termios'], { encoding: 'utf8' }).status === 0;
const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'check-access.mjs');
const DRIVER = join(ROOT, 'tests', 'support', 'pty_drive.py');
const cwd = mkdtempSync(join(tmpdir(), 'check-access-')); // no .env.local here

let stub: { port: number; seen: { signIns: { email: string | null; ok: boolean }[] }; close: () => Promise<void> };
beforeAll(async () => { stub = await startStub(); });
afterAll(async () => { await stub?.close(); });

interface Run { output: string; exit: number | null; signal: number | null; timedOut: boolean; failedStep: number | null; echoRestored: boolean | null; canonicalRestored: boolean | null }

// Async on purpose: the stub API runs in this process, so a blocking spawn would stop it answering.
async function drive(steps: { expect: string; send: string }[], extraArgs: string[] = []): Promise<Run> {
  const env = {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? cwd, TERM: 'xterm-256color',
    VITE_SUPABASE_URL: `http://127.0.0.1:${stub.port}`,
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_stub_for_tests',
  };
  const spec = { argv: [process.execPath, SCRIPT, ...extraArgs], cwd, env, steps, timeout: 40 };
  const child = spawn('python3', ['-I', DRIVER, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise<number | null>((done) => child.on('close', done));
  if (code !== 0) throw new Error(`driver failed: ${stderr}`);
  return JSON.parse(stdout) as Run;
}
const login = (label: string, opts: { typo?: boolean; clear?: boolean } = {}) => [
  { expect: `${label} email: `, send: `${accounts[label].email}\r` },
  { expect: `${label} password (typing is hidden): `, send: `${opts.typo ? 'x\x7f' : ''}${opts.clear ? 'junk\x15' : ''}${accounts[label].password}\r` },
];
const secrets = () => Object.values(accounts).flatMap((a) => [a.password, a.token]).concat(['SECRETMARK']);

describe.skipIf(!python)('check-access CLI in a pseudo-terminal', () => {
  it('shows each label, echoes emails, hides passwords, and asks for each account in turn', async () => {
    const before = stub.seen.signIns.length;
    const run = await drive([
      ...login('Officer'),
      ...login('Member A', { typo: true }), // backspace inside the hidden field
      ...login('Member B'),
      ...login('Member C', { clear: true }), // Ctrl-U clears the hidden field
      // Member D pastes email and password in one go.
      { expect: 'Member D email: ', send: `${accounts['Member D'].email}\r${accounts['Member D'].password}\r` },
    ]);
    expect(run.failedStep).toBeNull();
    expect(run.timedOut).toBe(false);

    const out = run.output;
    // Labels appear in order and stay on screen: no cursor movement or screen clearing at all.
    let at = 0;
    for (const label of ['Officer', 'Member A', 'Member B', 'Member C', 'Member D']) {
      const e = out.indexOf(`${label} email: ${accounts[label].email}`, at);
      expect(e, `${label} email label followed by the typed email`).toBeGreaterThanOrEqual(at);
      const p = out.indexOf(`${label} password (typing is hidden): \r\n`, e);
      expect(p, `${label} password label with nothing shown after it`).toBeGreaterThan(e);
      at = p;
    }
    expect(out).not.toMatch(/\x1b\[/);
    // Passwords and session tokens never reach the terminal.
    for (const s of secrets()) expect(out).not.toContain(s);
    // All five dummy sign-ins reached the stub with the right password (the backspace worked).
    expect(stub.seen.signIns.slice(before)).toEqual(Object.values(accounts).map((a) => ({ email: a.email, ok: true })));
    // It finished normally, with a result line, and gave the terminal back.
    expect(out).not.toMatch(/unsettled top-level await/i);
    expect(out).toMatch(/\d+ passed, \d+ failed, \d+ inconclusive, \d+ skipped\./);
    expect(out).toMatch(/Result: (FAILED|INCOMPLETE|all checks passed)/);
    expect([0, 1, 3]).toContain(run.exit);
    expect(run.echoRestored).toBe(true);
    expect(run.canonicalRestored).toBe(true);
  }, 60_000);

  it('Ctrl-C at the password prompt cancels cleanly and restores the terminal', async () => {
    const before = stub.seen.signIns.length;
    const run = await drive([{ expect: 'Officer email: ', send: `${accounts.Officer.email}\r` }, { expect: 'Officer password (typing is hidden): ', send: 'half\x03' }]);
    expect(run.exit).toBe(130);
    expect(run.output).toMatch(/Cancelled \(Ctrl-C\)\. The run stopped; the results above are incomplete\./);
    expect(run.output).not.toContain('half');
    expect(run.output).not.toMatch(/unsettled top-level await/i);
    expect(stub.seen.signIns.length).toBe(before);
    expect(run.echoRestored).toBe(true);
    expect(run.canonicalRestored).toBe(true);
  }, 60_000);

  it('Ctrl-D (end of input) at the email prompt cancels cleanly', async () => {
    const run = await drive([{ expect: 'Officer email: ', send: '\x04' }]);
    expect(run.exit).toBe(130);
    expect(run.output).toMatch(/Input ended before an answer was given\./);
    expect(run.output).not.toMatch(/unsettled top-level await/i);
    expect(run.echoRestored).toBe(true);
  }, 60_000);

  it('a refused officer sign-in skips the members without asking for them, and exits unsuccessfully', async () => {
    const run = await drive([
      { expect: 'Officer email: ', send: `${accounts.Officer.email}\r` },
      { expect: 'Officer password (typing is hidden): ', send: 'wrong-password\r' },
    ]);
    expect(run.exit).toBe(1);
    expect(run.output).toMatch(/FAIL\s+Officer\s+sign in \(sign-in refused \(400 invalid_credentials\)\)/);
    expect(run.output).toMatch(/SKIPPED\s+Member A\s+all member checks/);
    expect(run.output).not.toMatch(/Member A email:/);
    expect(run.output).not.toContain('wrong-password');
  }, 60_000);
});

describe('check-access CLI without a terminal', () => {
  it('refuses to read passwords from a pipe', () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd, input: 'someone@example.test\nnot-a-password\n', encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH ?? '', VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_stub_for_tests' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/needs an interactive terminal/);
    expect(r.stdout + r.stderr).not.toContain('not-a-password');
  });
});

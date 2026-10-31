import { useState } from 'react';
import { brand } from '../../config/brand';
import { modeLabels } from '../../config/mode';
import { actions, type Connection } from '../../state/store';
import { Logo, Sculpture } from '../common/Artwork';
import { IconAlert, IconInfo } from '../common/Icons';

// Screens shown before the connected test system is ready. None of them ever
// shows demo data: if the server can't be reached, the member sees that plainly.
export function ConnectedGate({ connection }: { connection: Connection }) {
  return (
    <>
      <div className="demo-bar" role="note">
        <span className="demo-bar-text">
          <strong>{modeLabels.notice}</strong>
        </span>
      </div>
      <main id="main" className="gate">
        <section className="gate-card" aria-labelledby="gate-h">
          <div className="gate-art" aria-hidden="true">
            <Sculpture compact />
          </div>
          <div className="gate-body">
            <div className="brand-row gate-brand">
              <Logo />
              <span>{brand.name}</span>
            </div>
            {connection.status === 'loading' && (
              <div role="status" aria-live="polite" className="gate-loading">
                <span className="spinner" aria-hidden="true" />
                <h1 id="gate-h">Loading your dues…</h1>
              </div>
            )}
            {connection.status === 'signed-out' && <SignIn message={connection.message} />}
            {connection.status === 'error' && (
              <div role="alert">
                <h1 id="gate-h">Can’t connect right now</h1>
                <p className="notice notice-pending">
                  <IconAlert /> {connection.message ?? "We can't reach Community Ledger right now. Nothing has been changed."}
                </p>
                <button type="button" className="btn btn-primary" onClick={actions.retryConnection}>
                  Try again
                </button>
              </div>
            )}
            {connection.status === 'unlinked' && (
              <div>
                <h1 id="gate-h">Your account isn’t linked yet</h1>
                <p>You’re signed in, but this account isn’t connected to a member record. An officer needs to link it before you can see your dues.</p>
                <button type="button" className="btn btn-ghost" onClick={() => void actions.signOut()}>
                  Sign out
                </button>
              </div>
            )}
            {connection.status === 'not-configured' && (
              <div>
                <h1 id="gate-h">The test system isn’t set up yet</h1>
                <p className="notice notice-info">
                  <IconInfo /> This build expects a Supabase project, but none is configured. See the setup steps in the README.
                </p>
              </div>
            )}
          </div>
        </section>
      </main>
    </>
  );
}

function SignIn({ message }: { message?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void actions.signIn(email, password);
      }}
    >
      <h1 id="gate-h">Sign in</h1>
      <p className="muted">Use one of the test accounts set up for this test system.</p>
      {message && (
        <p className="form-errors" role="alert">
          {message}
        </p>
      )}
      <label className="field">
        <span className="field-label">Email</span>
        <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary btn-block">
        Sign in
      </button>
    </form>
  );
}

const returnCopy: Record<NonNullable<Connection['returnStatus']>, { tone: 'info' | 'pending' | 'good' | 'warn'; text: string }> = {
  checking: { tone: 'pending', text: 'Checking your payment with the payment provider…' },
  confirmed: { tone: 'good', text: 'Payment received. Your dues and receipt are updated.' },
  pending: { tone: 'pending', text: 'We’re still checking this payment. Nothing has been taken off your balance yet.' },
  started: { tone: 'info', text: 'The payment wasn’t completed. Nothing was charged.' },
  abandoned: { tone: 'info', text: 'The checkout was closed before payment. Nothing was charged.' },
  failed: { tone: 'warn', text: 'This payment didn’t go through. Your balance hasn’t changed.' },
  held: { tone: 'warn', text: 'This payment needs checking by an officer. It hasn’t been applied yet.' },
  'checking-unavailable': { tone: 'pending', text: 'We couldn’t check the payment just now. We’ll keep checking; your balance updates once it’s confirmed.' },
  'not-found': { tone: 'info', text: 'We couldn’t find that payment.' },
};

export function ReturnNotice({ status }: { status: Connection['returnStatus'] }) {
  if (!status) return null;
  const c = returnCopy[status];
  return (
    <p className={`notice page-notice ${c.tone === 'good' ? 'notice-good' : c.tone === 'warn' ? 'notice-warn' : c.tone === 'pending' ? 'notice-pending' : 'notice-info'}`} role="status">
      {c.text}
    </p>
  );
}

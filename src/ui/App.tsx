import { useEffect, useState } from 'react';
import { brand } from '../config/brand';
import { modeLabels } from '../config/mode';
import { ConnectedGate, ReturnNotice } from './connected/ConnectedGate';
import { formatDateTime } from '../domain/time';
import { memberName } from '../domain/ledger';
import { openTasks } from '../domain/reports';
import { actions, useApp, type Role } from '../state/store';
import { Logo } from './common/Artwork';
import { Modal } from './common/bits';
import { IconClose, IconSliders } from './common/Icons';
import { ReceiptView } from './common/ReceiptView';
import { Toasts } from './common/Toasts';
import { DemoDrawer } from './demo/DemoDrawer';
import { MemberOverview } from './member/MemberOverview';
import { MemberPayments } from './member/MemberPayments';
import { MemberStatement } from './member/MemberStatement';
import { OfficerOverview } from './officer/OfficerOverview';
import { Members } from './officer/Members';
import { Dues } from './officer/Dues';
import { NeedsAttention } from './officer/NeedsAttention';
import { Reports } from './officer/Reports';

const NAV: Record<Role, { id: string; label: string }[]> = {
  member: [
    { id: 'overview', label: 'Overview' },
    { id: 'payments', label: 'Payments' },
    { id: 'statement', label: 'Statement' },
  ],
  officer: [
    { id: 'overview', label: 'Overview' },
    { id: 'members', label: 'Members' },
    { id: 'dues', label: 'Dues' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'reports', label: 'Reports' },
  ],
};

function pageFromHash(): string {
  return window.location.hash.replace(/^#\/?/, '') || 'overview';
}

export function App() {
  const { ledger, view, toasts, restoredNotice, mode, connection } = useApp();
  const [page, setPage] = useState(pageFromHash);
  const [drawer, setDrawer] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const nav = NAV[view.role];
  const current = nav.some((n) => n.id === page) ? page : 'overview';
  const go = (id: string) => {
    window.location.hash = `/${id}`;
    setPage(id);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    document.title = `${nav.find((n) => n.id === current)?.label} · ${brand.name} · ${mode === 'connected' ? 'Test system' : 'Demo'}`;
  }, [current, nav]);

  const attention = openTasks(ledger).length;
  const who = view.role === 'officer' ? 'Officer' : memberName(ledger, view.memberId);

  if (mode === 'connected' && connection.status !== 'ready') return <ConnectedGate connection={connection} />;

  let content;
  if (view.role === 'member') {
    if (current === 'payments') content = <MemberPayments ledger={ledger} memberId={view.memberId} onViewReceipt={setReceiptId} />;
    else if (current === 'statement') content = <MemberStatement ledger={ledger} memberId={view.memberId} onViewReceipt={setReceiptId} />;
    else content = <MemberOverview key={view.memberId} ledger={ledger} memberId={view.memberId} onViewReceipt={setReceiptId} onGo={go} />;
  } else {
    if (current === 'members') content = <Members ledger={ledger} onViewReceipt={setReceiptId} />;
    else if (current === 'dues') content = <Dues ledger={ledger} />;
    else if (current === 'attention') content = <NeedsAttention ledger={ledger} />;
    else if (current === 'reports') content = <Reports ledger={ledger} serverChecks={mode === 'connected' ? connection.serverChecks : undefined} />;
    else content = <OfficerOverview ledger={ledger} onGo={go} />;
  }

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="demo-bar no-print" role="note">
        <span className="demo-bar-text">
          <strong>{modeLabels.notice}</strong>
          <span className="demo-bar-clock">
            {mode === 'connected' ? 'Test clock' : 'Demo clock'} {formatDateTime(ledger.now)}
          </span>
        </span>
        {mode === 'demo' ? (
          <button type="button" className="demo-bar-btn" aria-label="Demo controls" onClick={() => setDrawer(true)}>
            <IconSliders size={18} /> <span className="demo-bar-btn-label">Demo controls</span>
            <span className="demo-bar-btn-short">Controls</span>
          </button>
        ) : (
          <button type="button" className="demo-bar-btn signout-btn" onClick={() => void actions.signOut()}>
            Sign out
          </button>
        )}
      </div>

      <header className="topbar no-print">
        <div className="topbar-inner">
          <a className="brand" href="#/overview" onClick={(e) => (e.preventDefault(), go('overview'))}>
            <Logo />
            <span>{brand.name}</span>
          </a>
          <nav aria-label={view.role === 'officer' ? 'Officer' : 'Member'} className="nav">
            {nav.map((n) => (
              <a
                key={n.id}
                href={`#/${n.id}`}
                className={`nav-link ${current === n.id ? 'is-active' : ''}`}
                aria-current={current === n.id ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  go(n.id);
                }}
              >
                {n.label}
                {n.id === 'attention' && attention > 0 && <span className="badge" aria-label={`${attention} open`}>{attention}</span>}
              </a>
            ))}
          </nav>
          {mode === 'demo' ? (
            <button type="button" className="who" onClick={() => setDrawer(true)} aria-label={`Viewing as ${who}. Open demo controls to switch.`}>
              <span className="who-tag">{view.role === 'officer' ? 'Officer view' : 'Member view'}</span>
              <span className="avatar">{view.role === 'officer' ? 'O' : who.slice(-1)}</span>
            </button>
          ) : (
            <span className="who" aria-label={`Signed in as ${who}`} role="img">
              <span className="who-tag">{view.role === 'officer' ? 'Officer' : 'Member'}</span>
              <span className="avatar">{view.role === 'officer' ? 'O' : who.slice(-1)}</span>
            </span>
          )}
        </div>
      </header>

      {restoredNotice && (
        <p className="notice notice-info page-notice" role="status">
          {restoredNotice}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={actions.dismissRestoredNotice}>
            <IconClose size={18} />
          </button>
        </p>
      )}

      {mode === 'connected' && <ReturnNotice status={connection.returnStatus} />}
      {mode === 'connected' && (connection.mismatches?.length ?? 0) > 0 && (
        <p className="notice notice-warn page-notice" role="alert">
          The figures shown for {connection.mismatches!.join(', ')} don’t match the database’s own totals. Please don’t rely on them and report this.
        </p>
      )}

      <main id="main" tabIndex={-1}>
        {content}
      </main>

      <footer className="footer no-print">
        <p>
          {brand.name} · {brand.groupName} · {brand.contactLabel}
        </p>
        <p>{modeLabels.notice}. Messages are previews only. Times are West Africa Time (Lagos).</p>
      </footer>

      <Modal open={receiptId !== null} onClose={() => setReceiptId(null)} title="Receipt" className="receipt-modal">
        {receiptId && <ReceiptView ledger={ledger} receiptId={receiptId} surface={view.role} />}
      </Modal>

      {mode === 'demo' && <DemoDrawer ledger={ledger} view={view} open={drawer} onClose={() => setDrawer(false)} />}

      <Toasts toasts={toasts} />
    </>
  );
}

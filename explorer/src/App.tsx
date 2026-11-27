import { Suspense, lazy, useEffect, useState } from 'react';
import { CopyButton, Loading } from './components/ui';
import { getDatasetInfo } from './lib/api';
import { COUNTY_NAME } from './lib/config';
import { fmtTimestamp, shortCid } from './lib/format';
import { useResource } from './lib/useResource';
import AgentPanel from './sections/AgentPanel';
import Artifacts from './sections/Artifacts';
import McpSection from './sections/McpSection';
import QueryLayer from './sections/QueryLayer';
import Records from './sections/Records';
import RunSummary from './sections/RunSummary';

const ExploreMap = lazy(() => import('./sections/ExploreMap'));

export const SECTIONS = [
  { id: 'summary', label: 'Run summary' },
  { id: 'records', label: 'Records by source' },
  { id: 'query', label: 'Query layer (DuckDB)' },
  { id: 'artifacts', label: 'Published artifacts (IPFS)' },
  { id: 'map', label: 'Explore map' },
  { id: 'agent', label: 'Ask the agent' },
  { id: 'mcp', label: 'MCP' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

export function sectionFromHash(hash: string): SectionId {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return SECTIONS.find((s) => s.id === id)?.id ?? 'summary';
}

function useSection(): [SectionId, (id: SectionId) => void] {
  const [section, setSection] = useState<SectionId>(() => sectionFromHash(window.location.hash));
  useEffect(() => {
    const onHash = (): void => setSection(sectionFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (id: SectionId): void => {
    if (window.location.hash !== `#/${id}`) window.location.hash = `#/${id}`;
    setSection(id);
  };
  return [section, go];
}

function Header({
  title,
  onMenu,
  navOpen,
}: {
  title: string;
  onMenu: () => void;
  navOpen: boolean;
}) {
  const { state } = useResource('datasetInfo', () => getDatasetInfo());
  const info = state.status === 'ok' ? state.data : null;
  return (
    <header className="topbar" data-testid="header">
      <button
        type="button"
        className="btn menu-btn"
        aria-controls="primary-nav"
        aria-expanded={navOpen}
        data-testid="menu-button"
        onClick={onMenu}
      >
        Menu
      </button>
      <h1>{title}</h1>
      <span className="county" data-testid="header-county">
        {info?.county ?? COUNTY_NAME}
      </span>
      <div className="topbar-meta">
        <span data-testid="header-as-of">
          {state.status === 'loading'
            ? 'Loading data status…'
            : info
              ? `Data as of ${fmtTimestamp(info.asOf)}`
              : 'Data status unavailable'}
        </span>
        <span className="topbar-cid" data-testid="header-root-cid">
          {info?.manifestCid ? (
            <>
              Root CID <code title={info.manifestCid}>{shortCid(info.manifestCid)}</code>
              <CopyButton value={info.manifestCid} label="Copy" testId="header-copy-cid" />
            </>
          ) : info ? (
            'Root CID: not published yet'
          ) : null}
        </span>
      </div>
    </header>
  );
}

export default function App() {
  const [section, go] = useSection();
  const [navOpen, setNavOpen] = useState(false);
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  useEffect(() => {
    document.title = `${current.label} · Oracle Explorer`;
  }, [current.label]);

  const navigate = (id: SectionId): void => {
    go(id);
    setNavOpen(false);
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {navOpen ? (
        <button
          type="button"
          className="nav-scrim"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <nav
        className={`nav${navOpen ? ' is-open' : ''}`}
        id="primary-nav"
        aria-label="Sections"
        data-testid="nav"
      >
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="28" height="28">
              <rect width="32" height="32" rx="7" fill="currentColor" />
              <circle cx="16" cy="16" r="7" fill="none" stroke="#fff" strokeWidth="2.6" />
              <circle cx="16" cy="16" r="2" fill="#fff" />
            </svg>
          </span>
          <span>
            <span className="brand-name">Oracle Explorer</span>
            <span className="brand-sub">Property intelligence pipeline</span>
          </span>
        </div>
        <ul className="nav-list">
          {SECTIONS.map((s, index) => (
            <li key={s.id}>
              <a
                href={`#/${s.id}`}
                className={`nav-item${s.id === section ? ' is-active' : ''}`}
                aria-current={s.id === section ? 'page' : undefined}
                data-testid={`nav-${s.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(s.id);
                }}
              >
                <span className="nav-index" aria-hidden="true">
                  {index + 1}
                </span>
                {s.label}
              </a>
            </li>
          ))}
        </ul>
        <p className="nav-foot muted">
          Read-only. Every number on these pages comes from the live MCP endpoint.
        </p>
      </nav>

      <div className="main">
        <Header title={current.label} navOpen={navOpen} onMenu={() => setNavOpen((v) => !v)} />
        <main id="main" className="content" tabIndex={-1}>
          {section === 'summary' ? <RunSummary /> : null}
          {section === 'records' ? <Records /> : null}
          {section === 'query' ? <QueryLayer /> : null}
          {section === 'artifacts' ? <Artifacts /> : null}
          {section === 'map' ? (
            <Suspense fallback={<Loading label="Loading the map section…" />}>
              <ExploreMap />
            </Suspense>
          ) : null}
          {section === 'agent' ? <AgentPanel /> : null}
          {section === 'mcp' ? <McpSection /> : null}
          <footer className="footer" data-testid="footer">
            <span>Oracle Explorer · {COUNTY_NAME} · public data, read-only.</span>
            <a
              href="#/summary"
              data-testid="footer-limitations"
              onClick={(event) => {
                event.preventDefault();
                navigate('summary');
                setTimeout(() => {
                  document.getElementById('limitations')?.scrollIntoView({ behavior: 'smooth' });
                }, 60);
              }}
            >
              Known limitations of this data
            </a>
          </footer>
        </main>
      </div>
    </div>
  );
}

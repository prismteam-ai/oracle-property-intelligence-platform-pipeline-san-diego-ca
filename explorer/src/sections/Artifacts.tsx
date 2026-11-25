import { useEffect, useRef, useState } from 'react';
import { Card, CopyButton, ErrorNotice, ExternalLink, Fact, Loading } from '../components/ui';
import { getManifest, getPublicationHistory } from '../lib/api';
import { fmtBytes, fmtInt, fmtTimestamp, shortCid } from '../lib/format';
import { McpError } from '../lib/mcp';
import {
  manifestSchema,
  type Manifest,
  type ManifestObject,
  type Publication,
} from '../lib/schemas';
import { useResource } from '../lib/useResource';
import {
  GATEWAYS,
  KIND_LABEL,
  LARGE_OBJECT_BYTES,
  OUTCOME_LABEL,
  checkGateway,
  gatewayUrl,
  kindOf,
  summarize,
  verdict,
  type CheckDeps,
  type Expected,
  type Gateway,
  type GatewayCheck,
} from '../lib/verify';

/** A small object every run contains; used to prove an older root still resolves. */
const PROBE_OBJECT = 'coverage.json';

export const slug = (name: string): string =>
  name === '' ? 'root' : name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');

const outcomeClass = (check: GatewayCheck): string =>
  check.outcome === 'match' || check.outcome === 'resolved'
    ? 'badge-ok'
    : check.outcome === 'mismatch'
      ? 'badge-danger'
      : 'badge-warn';

const HTTP_GATEWAYS = GATEWAYS.filter((g) => g.servesHttp);

const yesNo = (value: boolean | null): string => (value === null ? 'n/a' : value ? 'yes' : 'NO');

/**
 * Runs the same object through every listed gateway: all at once for small objects, one after
 * another for large ones so only one copy is held in memory at a time.
 */
export async function verifyEverywhere(
  rootCid: string,
  name: string,
  expected: Expected,
  deps: CheckDeps = {},
  gateways: readonly Gateway[] = GATEWAYS,
  sequential = false,
): Promise<GatewayCheck[]> {
  const one = (g: Gateway): Promise<GatewayCheck> =>
    checkGateway(g.id, gatewayUrl(g.origin, rootCid, name), expected, deps);
  if (!sequential) return Promise.all(gateways.map(one));
  const out: GatewayCheck[] = [];
  for (const g of gateways) out.push(await one(g));
  return out;
}

export function VerifyResults({
  checks,
  testId,
  needDigest = true,
}: {
  checks: readonly GatewayCheck[];
  testId: string;
  needDigest?: boolean;
}) {
  const summary = summarize(checks, needDigest);
  return (
    <div className="verify" data-testid={testId}>
      <p
        className={`verify-summary ${summary.verified ? 'is-ok' : 'is-bad'}`}
        data-testid={`${testId}-summary`}
        role="status"
      >
        {verdict(checks, needDigest)}
      </p>
      <div className="table-scroll" tabIndex={0} role="group" aria-label="Per-gateway results">
        <table className="mini-table">
          <caption className="sr-only">Per-gateway verification results</caption>
          <thead>
            <tr>
              <th scope="col">Gateway</th>
              <th scope="col">Kind</th>
              <th scope="col">Result</th>
              <th scope="col" className="num">
                HTTP
              </th>
              <th scope="col" className="num">
                Bytes
              </th>
              <th scope="col">Size equal</th>
              <th scope="col">SHA-256 equal</th>
              <th scope="col" className="num">
                Time
              </th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.gateway} data-testid={`${testId}-${c.gateway}`} data-outcome={c.outcome}>
                <td>
                  <ExternalLink href={c.url}>{c.gateway}</ExternalLink>
                </td>
                <td data-testid={`${testId}-${c.gateway}-kind`}>{KIND_LABEL[kindOf(c.gateway)]}</td>
                <td>
                  <span className={`badge ${outcomeClass(c)}`}>{OUTCOME_LABEL[c.outcome]}</span>
                </td>
                <td className="num">{c.httpStatus ?? '—'}</td>
                <td className="num">{c.bytes === null ? '—' : fmtInt(c.bytes)}</td>
                <td>{yesNo(c.sizeMatches)}</td>
                <td>{yesNo(c.digestMatches)}</td>
                <td className="num">{fmtInt(c.ms)} ms</td>
                <td className="note-cell">
                  {c.detail}
                  {c.outcome !== 'match' &&
                  c.outcome !== 'resolved' &&
                  kindOf(c.gateway) === 'browser'
                    ? ' Expected here: this gateway refuses scripted requests and serves only through its in-browser service worker, so open the link in a tab instead.'
                    : ''}
                  {c.sha256 ? (
                    <>
                      {' '}
                      <code className="hash" title={c.sha256}>
                        {c.sha256.slice(0, 16)}…
                      </code>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type VerifyState =
  | { status: 'idle' }
  | { status: 'running'; bytes: number }
  | { status: 'done'; checks: GatewayCheck[] };

function ObjectRow({
  object,
  rootCid,
  deps,
  autoRun,
}: {
  object: ManifestObject;
  rootCid: string;
  deps?: CheckDeps;
  autoRun: number;
}) {
  const id = slug(object.name);
  const isDirectory = object.codec === 'directory' || object.sha256 === null;
  const large = !isDirectory && object.size > LARGE_OBJECT_BYTES;
  const [state, setState] = useState<VerifyState>({ status: 'idle' });

  const run = (): void => {
    setState({ status: 'running', bytes: 0 });
    // Large objects skip the browser-only gateways (they would only say 429) and go one by one.
    const gateways = large ? HTTP_GATEWAYS : GATEWAYS;
    void verifyEverywhere(
      rootCid,
      object.name,
      { size: isDirectory ? null : object.size, sha256: object.sha256 },
      {
        ...deps,
        onProgress: (bytes) =>
          setState((s) =>
            s.status === 'running' && bytes > s.bytes ? { status: 'running', bytes } : s,
          ),
      },
      gateways,
      large,
    ).then((checks) => setState({ status: 'done', checks }));
  };
  const runRef = useRef(run);
  runRef.current = run;
  const eligibleForAuto = !large && !isDirectory;

  // "Verify all small objects" bumps the counter; each eligible row then runs its own check.
  useEffect(() => {
    if (autoRun > 0 && eligibleForAuto) runRef.current();
  }, [autoRun, eligibleForAuto]);

  return (
    <li className="object" data-testid={`object-${id}`}>
      <div className="object-head">
        <div className="object-name">
          <strong>{object.name === '' ? 'Directory root (the snapshot)' : object.name}</strong>
          <span className="badge badge-neutral">{object.codec}</span>
          <span className="muted">
            {fmtBytes(object.size)} · {fmtInt(object.size)} bytes
          </span>
        </div>
        <div className="object-actions">
          {large ? (
            <button
              type="button"
              className="btn btn-small"
              data-testid={`verify-full-${id}`}
              disabled={state.status === 'running'}
              onClick={run}
            >
              Download and verify in full ({fmtBytes(object.size)} × {HTTP_GATEWAYS.length}{' '}
              gateways)
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-small btn-primary"
              data-testid={`verify-${id}`}
              disabled={state.status === 'running'}
              onClick={run}
            >
              {isDirectory ? 'Check it resolves' : 'Verify now'}
            </button>
          )}
        </div>
      </div>
      <dl className="kv">
        <dt>CID</dt>
        <dd className="cid-row">
          <code className="hash" data-testid={`cid-${id}`}>
            {object.cid}
          </code>
          <CopyButton value={object.cid} label="Copy CID" />
        </dd>
        <dt>SHA-256</dt>
        <dd>
          {object.sha256 ? (
            <code className="hash" data-testid={`sha-${id}`}>
              {object.sha256}
            </code>
          ) : (
            <span className="muted">
              none: a directory is a DAG node, not a byte stream; its CID covers every member
            </span>
          )}
        </dd>
        <dt>Gateway URLs</dt>
        <dd className="gateway-links">
          {GATEWAYS.map((g) => (
            <ExternalLink key={g.id} href={gatewayUrl(g.origin, rootCid, object.name)}>
              {g.servesHttp ? g.id : `Open in ${g.id}`}
            </ExternalLink>
          ))}
        </dd>
      </dl>
      {large && state.status === 'idle' ? (
        <p className="notice notice-warn small" data-testid={`large-warning-${id}`}>
          This object is {fmtBytes(object.size)}. A full check downloads it from{' '}
          {HTTP_GATEWAYS.length} gateways, one after another, and hashes it in this tab, so it is
          not run automatically. Use the button above if you want it.
        </p>
      ) : null}
      {state.status === 'running' ? (
        <Loading
          label={`Fetching from ${large ? HTTP_GATEWAYS.length : GATEWAYS.length} public gateways and hashing in the browser…${
            state.bytes > 0 ? ` ${fmtBytes(state.bytes)} read so far.` : ''
          }`}
          testId={`verify-loading-${id}`}
        />
      ) : null}
      {state.status === 'done' ? (
        <VerifyResults
          checks={state.checks}
          testId={`verify-result-${id}`}
          needDigest={!isDirectory}
        />
      ) : null}
    </li>
  );
}

/** The manifest of the served run: root, CAR, pins and every object with a verify action. */
export function ManifestView({ manifest, deps }: { manifest: Manifest; deps?: CheckDeps }) {
  const [autoRun, setAutoRun] = useState(0);
  const small = manifest.objects.filter(
    (o) => o.codec !== 'directory' && o.sha256 !== null && o.size <= LARGE_OBJECT_BYTES,
  );
  return (
    <div className="stack" data-testid="manifest">
      <dl className="facts">
        <Fact label="Root CID (the snapshot)">
          <span className="cid-row">
            <code className="hash" data-testid="manifest-root-cid">
              {manifest.rootCid}
            </code>
            <CopyButton value={manifest.rootCid} label="Copy" testId="copy-root-cid" />
          </span>
        </Fact>
        <Fact label="Pipeline run">Run {manifest.runId}</Fact>
        <Fact label="Published at">{fmtTimestamp(manifest.createdAt)}</Fact>
        <Fact label="Previous root CID">
          {manifest.previousRootCid ? (
            <code className="hash" data-testid="manifest-previous-root">
              {manifest.previousRootCid}
            </code>
          ) : (
            'None: this is the first publish.'
          )}
        </Fact>
        <Fact label="IPNS">
          Not used. The root CID is the address; nothing mutable points at it.
        </Fact>
        <Fact label="Objects">{manifest.objects.length}</Fact>
      </dl>

      {manifest.car ? (
        <div className="subcard" data-testid="manifest-car">
          <h4>CAR for the directory root</h4>
          <dl className="kv">
            <dt>Name</dt>
            <dd>
              <code>{manifest.car.name}</code>
            </dd>
            <dt>Size</dt>
            <dd>
              {fmtBytes(manifest.car.size)} · {fmtInt(manifest.car.size)} bytes
            </dd>
            <dt>SHA-256</dt>
            <dd>
              <code className="hash">{manifest.car.sha256}</code>
            </dd>
            <dt>From a gateway</dt>
            <dd>
              <ExternalLink
                href={`${gatewayUrl(GATEWAYS[0]?.origin ?? '', manifest.rootCid).replace(/\/$/, '')}?format=car`}
              >
                Download the DAG as a CAR
              </ExternalLink>{' '}
              <span className="muted small">
                (a gateway builds its own CAR, so block order and therefore this digest may differ;
                the root CID inside it is the same)
              </span>
            </dd>
          </dl>
        </div>
      ) : null}

      {manifest.pins.length > 0 ? (
        <div className="subcard">
          <h4>Pins per provider</h4>
          <div className="table-scroll" tabIndex={0} role="group" aria-label="Pins per provider">
            <table className="mini-table" data-testid="manifest-pins">
              <caption className="sr-only">Pins per provider</caption>
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Result</th>
                  <th scope="col">CID reported</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {manifest.pins.map((p) => (
                  <tr key={p.provider}>
                    <td>{p.provider}</td>
                    <td>
                      <span className={`badge ${p.ok ? 'badge-ok' : 'badge-danger'}`}>
                        {p.ok ? 'Pinned' : 'Failed'}
                      </span>
                    </td>
                    <td>
                      {p.cid ? (
                        <code className="hash" title={p.cid}>
                          {shortCid(p.cid)}
                        </code>
                      ) : (
                        <span className="muted">per file</span>
                      )}
                    </td>
                    <td className="note-cell">{p.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="subcard">
        <div className="row row-between">
          <h4>Objects</h4>
          <button
            type="button"
            className="btn btn-small"
            data-testid="verify-all-small"
            disabled={small.length === 0}
            onClick={() => setAutoRun((n) => n + 1)}
          >
            Verify all {small.length} small objects
          </button>
        </div>
        <ul className="objects">
          {manifest.objects.map((o) => (
            <ObjectRow
              key={o.name || 'root'}
              object={o}
              rootCid={manifest.rootCid}
              deps={deps}
              autoRun={autoRun}
            />
          ))}
        </ul>
      </div>

      <details className="disclosure" data-testid="manifest-json">
        <summary>Manifest as JSON</summary>
        <pre className="code">{JSON.stringify(manifest, null, 2)}</pre>
      </details>
    </div>
  );
}

const KIND_BADGE: Record<Gateway['kind'], string> = {
  independent: 'badge-ok',
  vendor: 'badge-permit',
  browser: 'badge-warn',
};

function GatewayList() {
  return (
    <ul className="source-list" data-testid="gateway-list">
      {GATEWAYS.map((g) => (
        <li key={g.id} className="source-item" data-testid={`gateway-${g.id}`}>
          <div className="source-title">
            <strong>{g.id}</strong>
            <span className={`badge ${KIND_BADGE[g.kind]}`}>{KIND_LABEL[g.kind]}</span>
            <span className="muted small">
              {g.servesHttp
                ? 'public, anonymous; a script can read the bytes when the gateway has the content'
                : 'HTTP 429 to scripts; content only through its service worker'}
            </span>
          </div>
          {g.note ? <p className="small muted">{g.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Digests of the probe object for runs whose manifest the API no longer serves, copied from the
 * manifest kept in the pipeline repository. Used only when neither the served manifest nor a
 * pinned manifest CID can supply the value.
 */
export const RECORDED_PROBES: Readonly<
  Record<string, { size: number; sha256: string; recordedIn: string }>
> = {
  bafybeid7p55asvoy3r24wgrqny74akxdnts6kbne2b2k3thbz66ywo46wy: {
    size: 3115,
    sha256: '475574b1c11d004dbe7f242161faf2720d981b32f420232d2e8e3ba218fe7567',
    recordedIn: 'publications/san-diego/run-0003/manifest.json',
  },
};

/** Finds what the older run's manifest says about the probe object, if that manifest is pinned. */
async function expectedFromOldManifest(
  manifestCid: string | null | undefined,
  deps: CheckDeps,
): Promise<Expected> {
  const none: Expected = { size: null, sha256: null };
  if (!manifestCid) return none;
  const fetchImpl = deps.fetchImpl ?? fetch;
  for (const g of GATEWAYS.filter((x) => x.servesHttp)) {
    try {
      const response = await fetchImpl(`${g.origin}/ipfs/${manifestCid}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;
      const parsed = manifestSchema.safeParse(await response.json());
      const object = parsed.success
        ? parsed.data.objects.find((o) => o.name === PROBE_OBJECT)
        : undefined;
      if (object) return { size: object.size, sha256: object.sha256 };
    } catch {
      // Try the next gateway.
    }
  }
  return none;
}

type ProbeState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; checks: GatewayCheck[]; expected: Expected; basis: string };

function PublicationRow({
  publication,
  served,
  manifest,
  deps = {},
}: {
  publication: Publication;
  served: boolean;
  manifest: Manifest | null;
  deps?: CheckDeps;
}) {
  const [state, setState] = useState<ProbeState>({ status: 'idle' });
  const id = `publication-${publication.runId}-${publication.rootCid.slice(-6)}`;

  const probe = async (): Promise<void> => {
    setState({ status: 'running' });
    const fromServed = served ? manifest?.objects.find((o) => o.name === PROBE_OBJECT) : undefined;
    const recorded = RECORDED_PROBES[publication.rootCid];
    let expected: Expected = { size: null, sha256: null };
    let basis = 'No digest is recorded for this run, so this shows reachability only.';
    if (fromServed) {
      expected = { size: fromServed.size, sha256: fromServed.sha256 };
      basis = 'Compared with the size and SHA-256 in the manifest the API serves for this run.';
    } else {
      const pinned = await expectedFromOldManifest(publication.manifestCid, deps);
      if (pinned.sha256 !== null) {
        expected = pinned;
        basis = `Compared with the size and SHA-256 in that run’s own manifest, fetched by its CID (${publication.manifestCid ?? ''}).`;
      } else if (recorded) {
        expected = { size: recorded.size, sha256: recorded.sha256 };
        basis = `The API does not serve this older run’s manifest, so the digest is compared with the value recorded in the repository at ${recorded.recordedIn}.`;
      }
    }
    const checks = await verifyEverywhere(publication.rootCid, PROBE_OBJECT, expected, deps);
    setState({ status: 'done', checks, expected, basis });
  };

  return (
    <li className="object" data-testid={id}>
      <div className="object-head">
        <div className="object-name">
          <strong>Run {publication.runId}</strong>
          {served ? (
            <span className="badge badge-ok">Served now</span>
          ) : (
            <span className="badge badge-neutral">Earlier publish</span>
          )}
          <span className="muted">{fmtTimestamp(publication.createdAt)}</span>
        </div>
        <button
          type="button"
          className="btn btn-small"
          data-testid={`check-resolves-${publication.runId}`}
          disabled={state.status === 'running'}
          onClick={() => void probe()}
        >
          {served ? 'Check this CID resolves' : 'Check the earlier CID still resolves'}
        </button>
      </div>
      <dl className="kv">
        <dt>Root CID</dt>
        <dd className="cid-row">
          <code className="hash">{publication.rootCid}</code>
          <CopyButton value={publication.rootCid} label="Copy CID" />
        </dd>
        <dt>Previous root</dt>
        <dd>
          {publication.previousRootCid ? (
            <code className="hash">{publication.previousRootCid}</code>
          ) : (
            <span className="muted">none (first publish)</span>
          )}
        </dd>
        <dt>Manifest CID</dt>
        <dd>
          {publication.manifestCid ? (
            <code className="hash">{publication.manifestCid}</code>
          ) : (
            <span className="muted">not pinned separately</span>
          )}
        </dd>
        <dt>Size</dt>
        <dd>
          {publication.bytes === undefined ? '—' : fmtBytes(publication.bytes)}
          {publication.objects === undefined ? '' : ` in ${publication.objects} objects`}
          {publication.verifiedGateways === undefined
            ? ''
            : ` · ${publication.verifiedGateways} gateways had it at the moment of publishing (use the check to see now)`}
        </dd>
        <dt>Open</dt>
        <dd className="gateway-links">
          {GATEWAYS.map((g) => (
            <ExternalLink key={g.id} href={gatewayUrl(g.origin, publication.rootCid)}>
              {g.servesHttp ? g.id : `Open in ${g.id}`}
            </ExternalLink>
          ))}
        </dd>
      </dl>
      {state.status === 'running' ? (
        <Loading label={`Fetching ${PROBE_OBJECT} under this root from public gateways…`} />
      ) : null}
      {state.status === 'done' ? (
        <>
          <div className="small" data-testid={`resolve-basis-${publication.runId}`}>
            <p>
              Fetched <code>{PROBE_OBJECT}</code> under this root. {state.basis}
            </p>
            {state.expected.sha256 !== null ? (
              <p className="muted">
                Expected {fmtInt(state.expected.size)} bytes, SHA-256{' '}
                <code className="hash">{state.expected.sha256}</code>
              </p>
            ) : null}
          </div>
          <VerifyResults
            checks={state.checks}
            testId={`resolve-result-${publication.runId}`}
            needDigest={state.expected.sha256 !== null}
          />
        </>
      ) : null}
    </li>
  );
}

export function PublicationHistory({
  publications,
  manifest,
  deps,
}: {
  publications: readonly Publication[];
  manifest: Manifest | null;
  deps?: CheckDeps;
}) {
  const ordered = [...publications].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const distinct = new Set(ordered.map((p) => p.rootCid)).size;
  const servedRoot = manifest?.rootCid ?? ordered[0]?.rootCid;
  if (ordered.length === 0) {
    return (
      <p className="empty-line" data-testid="publication-history-empty">
        No publish has been recorded yet.
      </p>
    );
  }
  return (
    <div className="stack-tight" data-testid="publication-history">
      <p data-testid="publication-summary">
        {ordered.length} {ordered.length === 1 ? 'publish' : 'publishes'}, {distinct} distinct root{' '}
        {distinct === 1 ? 'CID' : 'CIDs'}.{' '}
        {ordered.length > 1
          ? 'Each later publish produced a new root and names the one before it; the earlier root is untouched and can be checked below.'
          : 'Only one publish exists so far, so there is no earlier CID to compare with yet.'}
      </p>
      <ul className="objects">
        {ordered.map((p) => (
          <PublicationRow
            key={p.rootCid}
            publication={p}
            served={p.rootCid === servedRoot}
            manifest={manifest}
            deps={deps}
          />
        ))}
      </ul>
    </div>
  );
}

const isMissing = (error: Error, kind: 'tool_error' | 'tool_not_found'): boolean =>
  error instanceof McpError && error.kind === kind;

export default function Artifacts() {
  const manifest = useResource('manifest', () => getManifest());
  const history = useResource('publicationHistory', () => getPublicationHistory());
  const served = manifest.state.status === 'ok' ? manifest.state.data : null;

  return (
    <div className="page" data-testid="section-artifacts">
      <div className="page-head">
        <div>
          <h2>Published artifacts (IPFS)</h2>
          <p className="muted">
            Each run is published as an immutable, content-addressed snapshot. Gateway URLs below
            are derived from CIDs; the verification runs in this browser against gateways this
            project does not operate.
          </p>
        </div>
      </div>

      <Card title="Manifest for the served run" testId="card-manifest">
        {manifest.state.status === 'loading' ? (
          <Loading label="Loading the manifest…" testId="manifest-loading" />
        ) : null}
        {manifest.state.status === 'error' ? (
          isMissing(manifest.state.error, 'tool_error') ? (
            <div className="empty" data-testid="manifest-unpublished">
              <h3>Not published yet</h3>
              <p>{manifest.state.error.message}</p>
              <button
                type="button"
                className="btn"
                onClick={manifest.reload}
                data-testid="manifest-reload"
              >
                Check again
              </button>
            </div>
          ) : (
            <ErrorNotice
              error={manifest.state.error}
              onRetry={manifest.reload}
              testId="manifest-error"
            />
          )
        ) : null}
        {served ? <ManifestView manifest={served} /> : null}
      </Card>

      <Card title="Publication history" testId="card-publications">
        {history.state.status === 'loading' ? (
          <Loading label="Loading publication history…" testId="publications-loading" />
        ) : null}
        {history.state.status === 'error' ? (
          isMissing(history.state.error, 'tool_not_found') ? (
            <div className="stack-tight" data-testid="publications-unavailable">
              <p className="notice notice-warn">
                The getPublicationHistory tool is not deployed on this API yet, so the full list of
                published runs cannot be shown.
                {served ? ' The chain below is read from the served manifest instead.' : ''}
              </p>
              {served ? (
                <PublicationHistory
                  manifest={served}
                  publications={[
                    {
                      runId: served.runId,
                      createdAt: served.createdAt,
                      rootCid: served.rootCid,
                      previousRootCid: served.previousRootCid ?? null,
                    },
                  ]}
                />
              ) : null}
              <div>
                <button type="button" className="btn btn-small" onClick={history.reload}>
                  Check again
                </button>
              </div>
            </div>
          ) : isMissing(history.state.error, 'tool_error') ? (
            <div className="stack-tight" data-testid="publication-history-none">
              <p className="empty-line">{history.state.error.message}</p>
              {served ? (
                <>
                  <p className="small muted">
                    The served manifest exists, so its own chain is shown instead.
                  </p>
                  <PublicationHistory
                    manifest={served}
                    publications={[
                      {
                        runId: served.runId,
                        createdAt: served.createdAt,
                        rootCid: served.rootCid,
                        previousRootCid: served.previousRootCid ?? null,
                      },
                    ]}
                  />
                </>
              ) : null}
              <div>
                <button type="button" className="btn btn-small" onClick={history.reload}>
                  Check again
                </button>
              </div>
            </div>
          ) : (
            <ErrorNotice
              error={history.state.error}
              onRetry={history.reload}
              testId="publications-error"
            />
          )
        ) : null}
        {history.state.status === 'ok' ? (
          <PublicationHistory publications={history.state.data} manifest={served} />
        ) : null}
      </Card>

      <Card title="Public gateways used" testId="card-gateways">
        <p className="muted small">
          None of these is operated by this project. Each is public and anonymous, and each is
          labelled by kind: independent, the public gateway of a pinning vendor, or browser-only. A
          fetch that the browser refuses is reported as “Blocked by CORS” or “Network failure”,
          never as a pass.
        </p>
        <GatewayList />
      </Card>
    </div>
  );
}

/** Objects above this size are only verified in full after an explicit confirmation. */
export const LARGE_OBJECT_BYTES = 20 * 1024 * 1024;

export type GatewayKind = 'independent' | 'vendor' | 'browser';

export interface Gateway {
  id: string;
  origin: string;
  /**
   * independent: a public gateway with no relation to this project.
   * vendor: the public, anonymous gateway of a service the snapshot is pinned with.
   * browser: answers scripts with HTTP 429 and serves only through its in-page service worker.
   */
  kind: GatewayKind;
  /** False for gateways that no longer answer plain HTTP clients with content. */
  servesHttp: boolean;
  note: string | null;
}

export const KIND_LABEL: Record<GatewayKind, string> = {
  independent: 'Independent',
  vendor: 'Pinning-vendor public gateway',
  browser: 'Browser-only',
};

const SERVICE_WORKER_NOTE =
  'Since September 2026 this gateway answers fetch and curl with HTTP 429 and serves content ' +
  'only through an in-browser service worker. Use the “Open in” link to load it in a new tab.';
const VENDOR_NOTE =
  'Run by a service this snapshot is pinned with, but public and anonymous: no key, no login. ' +
  'Counted as evidence and labelled separately from the independent gateways.';

const gw = (id: string, kind: GatewayKind, note: string | null): Gateway => ({
  id,
  origin: `https://${id}`,
  kind,
  servesHttp: kind !== 'browser',
  note,
});

/** Public gateways. None is operated by this project. */
export const GATEWAYS: readonly Gateway[] = [
  gw('latam.orbitor.dev', 'independent', null),
  gw('4everland.io', 'independent', null),
  gw('storry.tv', 'independent', null),
  gw('gateway.pinata.cloud', 'vendor', VENDOR_NOTE),
  gw('ipfs.filebase.io', 'vendor', VENDOR_NOTE),
  gw('ipfs.io', 'browser', SERVICE_WORKER_NOTE),
  gw('dweb.link', 'browser', SERVICE_WORKER_NOTE),
];

export const kindOf = (gatewayId: string): GatewayKind =>
  GATEWAYS.find((g) => g.id === gatewayId)?.kind ?? 'independent';

/** Gateway URLs are derived from CIDs only: `<gateway>/ipfs/<rootCid>/<name>`. */
export function gatewayUrl(origin: string, rootCid: string, name = ''): string {
  const path = name
    .split('/')
    .filter((part) => part !== '')
    .map(encodeURIComponent)
    .join('/');
  return `${origin}/ipfs/${rootCid}${path ? `/${path}` : '/'}`;
}

export type CheckOutcome =
  'match' | 'mismatch' | 'resolved' | 'http_error' | 'cors_blocked' | 'network_error' | 'timeout';

export interface GatewayCheck {
  gateway: string;
  url: string;
  outcome: CheckOutcome;
  httpStatus: number | null;
  bytes: number | null;
  sha256: string | null;
  sizeMatches: boolean | null;
  digestMatches: boolean | null;
  ms: number;
  detail: string;
}

export interface Expected {
  /** Null when the manifest carries no size or digest for the object (a directory). */
  size: number | null;
  sha256: string | null;
}

export interface CheckDeps {
  fetchImpl?: typeof fetch;
  digest?: (bytes: Uint8Array) => Promise<string>;
  now?: () => number;
  timeoutMs?: number;
  onProgress?: (bytesSoFar: number) => void;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const hash = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readAll(
  response: Response,
  onProgress?: (bytesSoFar: number) => void,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onProgress?.(total);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

/**
 * Fetches one object from one gateway in the browser and compares it with the manifest.
 * A fetch that throws is probed again in `no-cors` mode: if that opaque request succeeds, the
 * gateway is reachable but sent no CORS headers, and the result says so instead of guessing.
 */
export async function checkGateway(
  gateway: string,
  url: string,
  expected: Expected,
  deps: CheckDeps = {},
): Promise<GatewayCheck> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const digest = deps.digest ?? sha256Hex;
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const base = {
    gateway,
    url,
    httpStatus: null,
    bytes: null,
    sha256: null,
    sizeMatches: null,
    digestMatches: null,
  };
  const elapsed = (): number => Math.round(now() - started);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 120_000);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
    } catch (error) {
      if (isAbort(error)) {
        return { ...base, outcome: 'timeout', ms: elapsed(), detail: 'Timed out.' };
      }
      try {
        await fetchImpl(url, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' });
        return {
          ...base,
          outcome: 'cors_blocked',
          ms: elapsed(),
          detail:
            'Blocked by CORS: the gateway answered, but without CORS headers, so the browser will not let this page read the bytes. Gateway timeout pages are often sent this way when content has not reached the gateway yet.',
        };
      } catch {
        return {
          ...base,
          outcome: 'network_error',
          ms: elapsed(),
          detail:
            'Network failure: no response could be read from this gateway in this browser, even without CORS.',
        };
      }
    }
    if (!response.ok) {
      // Gateways explain themselves in the body ("no providers found"), so show a short excerpt.
      let said = '';
      try {
        said = (await response.text())
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      } catch {
        said = '';
      }
      const excerpt = said === '' ? '' : ` The gateway said: “${said.slice(0, 180)}”`;
      return {
        ...base,
        outcome: 'http_error',
        httpStatus: response.status,
        ms: elapsed(),
        detail:
          response.status === 429
            ? 'HTTP 429: this gateway refuses scripted requests.'
            : `HTTP ${response.status}.${excerpt}`,
      };
    }
    let bytes: Uint8Array;
    try {
      bytes = await readAll(response, deps.onProgress);
    } catch (error) {
      return {
        ...base,
        outcome: isAbort(error) ? 'timeout' : 'network_error',
        httpStatus: response.status,
        ms: elapsed(),
        detail: isAbort(error) ? 'Timed out while downloading.' : 'The download was cut off.',
      };
    }
    const sha256 = await digest(bytes);
    const sizeMatches = expected.size === null ? null : bytes.length === expected.size;
    const digestMatches =
      expected.sha256 === null ? null : sha256.toLowerCase() === expected.sha256.toLowerCase();
    const measured = { httpStatus: response.status, bytes: bytes.length, sha256 };
    if (digestMatches === null) {
      return {
        ...base,
        ...measured,
        sizeMatches,
        digestMatches,
        outcome: 'resolved',
        ms: elapsed(),
        detail: 'Resolved. No manifest digest to compare with, so only reachability is shown.',
      };
    }
    const ok = digestMatches && sizeMatches !== false;
    return {
      ...base,
      ...measured,
      sizeMatches,
      digestMatches,
      outcome: ok ? 'match' : 'mismatch',
      ms: elapsed(),
      detail: ok
        ? 'Size and SHA-256 equal the manifest.'
        : 'The bytes do NOT match the manifest size/digest.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface VerifySummary {
  /** Gateways whose result counts as good: `match`, or `resolved` when no digest is expected. */
  matched: number;
  independent: number;
  vendor: number;
  /** Browser-only gateways that did answer a script; normally zero. */
  browser: number;
  attempted: number;
  /** The demo bar: the same bytes from at least two public gateways. */
  verified: boolean;
}

export function summarize(checks: readonly GatewayCheck[], needDigest = true): VerifySummary {
  const good = checks.filter(
    (c) => c.outcome === 'match' || (!needDigest && c.outcome === 'resolved'),
  );
  const count = (kind: GatewayKind): number =>
    good.filter((c) => kindOf(c.gateway) === kind).length;
  return {
    matched: good.length,
    independent: count('independent'),
    vendor: count('vendor'),
    browser: count('browser'),
    attempted: checks.length,
    verified: good.length >= 2,
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One sentence a viewer can read aloud: what matched, where, and of which kind. */
export function verdict(checks: readonly GatewayCheck[], needDigest = true): string {
  const s = summarize(checks, needDigest);
  const split = `(${s.independent} independent, ${s.vendor} pinning-vendor${
    s.browser > 0 ? `, ${s.browser} browser-only` : ''
  })`;
  if (needDigest) {
    return s.verified
      ? `Verified: bytes match the manifest on ${plural(s.matched, 'public gateway')} ${split}.`
      : `Not verified: bytes match the manifest on only ${s.matched} of ${plural(s.attempted, 'gateway')} tried ${split}.`;
  }
  return s.verified
    ? `Resolves on ${plural(s.matched, 'public gateway')} ${split}; no recorded digest to compare with.`
    : `Resolves on only ${s.matched} of ${plural(s.attempted, 'gateway')} tried ${split}.`;
}

export const OUTCOME_LABEL: Record<CheckOutcome, string> = {
  match: 'Match',
  mismatch: 'Mismatch',
  resolved: 'Resolved',
  http_error: 'HTTP error',
  cors_blocked: 'Blocked by CORS',
  network_error: 'Network failure',
  timeout: 'Timed out',
};

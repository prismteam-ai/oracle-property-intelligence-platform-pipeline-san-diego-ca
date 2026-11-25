# Oracle Explorer

A small public web UI for the Oracle property-intelligence pipeline (San Diego County, CA). It is a
static single-page app: every number on it comes from the pipeline's read-only MCP endpoint, called
from the browser with plain `fetch`. There is no backend of its own.

Vite + React 19 + strict TypeScript, MapLibre GL with the OpenFreeMap basemap (no API key), Zod at
the API boundary, Vitest + Testing Library.

## Run

```bash
npm install
npm run dev          # http://localhost:5183
npm run build        # typecheck, then a static bundle in dist/
npm run preview      # serve dist/
```

Checks:

```bash
npm run lint         # ESLint (flat config) + Prettier check
npm run typecheck    # tsc --noEmit, strict, no `any`
npm test             # Vitest, mocked fetch, no network
```

Live walk of the spec's demo transcript (needs the dev server running, and
`npx playwright install chromium` once):

```bash
npm run demo:walk       # drives every section at 1280x800 and 390x844, saves screenshots
npm run demo:gateways   # asks a real browser which public IPFS gateways allow CORS reads
```

`demo:walk` writes to `../../shots/explorer` unless `SHOTS_DIR` is set; `EXPLORER_URL` points it at
a deployed copy.

## Configuration

| Variable              | Meaning                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| `VITE_ORACLE_API_URL` | Base URL of the serving API. MCP is `<base>/mcp`, the agent `<base>/agent` |

Copy `.env.example` to `.env.local` to change it. When unset, the app uses the URL in
`.env.example`. `amplify.yml` builds the app from the `explorer` folder of the repository; set the
variable in the hosting console if the API moves.

## Sections

The URL hash selects the section, so each one can be linked and opened directly.

| Hash          | Section                    | Tools used                                               |
| ------------- | -------------------------- | -------------------------------------------------------- |
| `#/summary`   | Run summary, run history   | `getPipelineRuns`, `getCoverage`, `getAtlasDatasetInfo`  |
| `#/records`   | Records by source          | `getCoverage`, `getAtlasDatasetInfo`, `queryAtlas`       |
| `#/query`     | Query layer (DuckDB)       | `getAtlasSchema`, `queryAtlas`                           |
| `#/artifacts` | Published artifacts (IPFS) | `getArtifactManifest`, `getPublicationHistory`, gateways |
| `#/map`       | Explore map                | `findRoofingLeads`, `getOracleProperty`                  |
| `#/agent`     | Ask the agent              | `POST <base>/agent`                                      |
| `#/mcp`       | MCP catalogue and tester   | `tools/list`, `tools/call`                               |

### States that depend on the API

- **Manifest not published yet**: `getArtifactManifest` answers with an error result; the section
  shows "Not published yet" with a "Check again" button.
- **`getPublicationHistory` missing**: shown as "not deployed yet"; if a manifest exists, the chain
  (root CID and previous root CID) is read from it instead.
- **Agent endpoint missing**: a 404 from `/agent` is shown as "The agent endpoint is not available
  yet", not as a failure of the page.
- **Cold start**: the first call after idle takes about 4 seconds. Loading lines say so after 1.5
  seconds, and every call is retried once on a network failure or a 5xx.

### Gateway verification

"Verify now" fetches the object in the browser from `4everland.io`, `storry.tv` and
`latam.orbitor.dev` (and `ipfs.io` / `dweb.link`, to show their real status), hashes the bytes with
WebCrypto and compares size and SHA-256 with the manifest. An object counts as verified when at
least two gateways return matching bytes. Objects over 20 MB are only checked after pressing an
explicit button that states the size.

A fetch the browser refuses is probed once more in `no-cors` mode: if that opaque request succeeds,
the row says "Blocked by CORS"; if not, "Network failure". Neither is ever counted as a pass.
`ipfs.io` and `dweb.link` refuse scripted requests (HTTP 429 to curl; in a browser the script read
fails) and serve content only through their in-browser service worker, so they get an "Open in"
link that opens a new tab.

## Test ids

Stable `data-testid`s for driving the page. No native dialogs are used anywhere.

| Area      | Ids                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell     | `nav`, `nav-<section>`, `menu-button`, `header`, `header-county`, `header-as-of`, `header-root-cid`, `header-copy-cid`, `footer-limitations`                                                                                                                                                                                                                                                                                                                                                                                              |
| Sections  | `section-summary`, `section-records`, `section-query`, `section-artifacts`, `section-map`, `section-agent`, `section-mcp`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Summary   | `latest-run`, `latest-run-id`, `source-list`, `limitations-list`, `run-history`, `run-<id>`, `run-<id>-<source>-<entity>`, `run-<id>-total`                                                                                                                                                                                                                                                                                                                                                                                               |
| Records   | `record-totals`, `total-<table>`, `total-coordinates`, `bbb-note`, `source-table`, `rejects-table`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Query     | `duckdb-statement`, `schema`, `schema-<relation>`, `sql-example-<id>` (`aged-roofs`, `long-open-permits`, `owners-unchanged`, `out-of-area`, `top-contractors`, `forbidden`), `sql-input`, `sql-run`, `sql-row-count`, `sql-truncated`, `sql-results`, `sql-rejected`, `sql-rejected-message`, `sql-error`                                                                                                                                                                                                                                |
| Artifacts | `manifest`, `manifest-unpublished`, `manifest-root-cid`, `manifest-previous-root`, `manifest-car`, `manifest-pins`, `manifest-json`, `object-<slug>`, `cid-<slug>`, `sha-<slug>`, `verify-<slug>`, `verify-full-<slug>`, `large-warning-<slug>`, `verify-all-small`, `verify-result-<slug>`, `verify-result-<slug>-summary`, `verify-result-<slug>-<gateway>` (with `data-outcome`), `publication-history`, `publication-summary`, `publications-unavailable`, `check-resolves-<runId>`, `resolve-result-<runId>-summary`, `gateway-list` |
| Map       | `place-<id>`, `input-lat`, `input-lon`, `input-radius`, `input-min-age`, `search-submit`, `search-form-error`, `explore-map` (`data-map-ready`, `data-point-count`), `tab-aged`, `tab-permits`, `results-total`, `coverage-note`, `results-table`, `row-<apn>`, `expand-<apn>`, `detail-<apn>`, `permit-<permitId>`, `bbb`, `provenance`, `results-more`, `results-empty`                                                                                                                                                                 |
| Agent     | `agent-place`, `agent-radius`, `agent-example-aged-roofs`, `agent-example-open-permits`, `agent-question`, `agent-ask`, `agent-idle`, `agent-loading`, `agent-unavailable`, `agent-error`, `agent-result`, `agent-answer`, `agent-assumptions`, `agent-evidence`, `agent-rows`, `agent-map`                                                                                                                                                                                                                                               |
| MCP       | `mcp-url`, `copy-mcp-url`, `curl-example`, `mcp-json`, `tester-tool`, `tester-args`, `tester-call`, `tester-status`, `tester-result`, `tool-catalogue`, `tool-<name>`, `tool-count`                                                                                                                                                                                                                                                                                                                                                       |

`<slug>` is the object's logical name with non-alphanumerics turned into `-` (`coverage.json` →
`coverage-json`); the directory root is `root`. Place ids: `downtown`, `la-jolla`, `chula-vista`,
`oceanside`, `escondido`, `el-cajon`, `carlsbad`, `encinitas`.

## Known limits of this UI

- SHA-256 over a large object needs the whole object in memory (WebCrypto has no streaming digest).
- Source licence lines are copied from the pipeline's `SOURCES.md`; the API returns limits but not
  the licence text.
- The map shows up to 100 results per search (20 at a time in the table); the total is always shown.

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

"Verify now" fetches the object in the browser from every listed gateway, hashes the bytes with
WebCrypto and compares size and SHA-256 with the manifest. Each gateway carries a visible kind:

| Kind                                       | Gateways in the automatic check                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Independent                                | `latam.orbitor.dev`, `gateway.pinit.io`, `ipfs.aleph.cloud`, `ipfs.thegraph.com`, `ipfs.hypha.coop`    |
| Answered by a pinning vendor (not counted) | `gateway.pinata.cloud`, `ipfs.filebase.io`, `ipfs.raribleuserdata.com` (Rarible's, hosted by Filebase) |

Five more gateways are listed under "Other gateways" as plain links with a one-line status and are
never fetched by the page: `4everland.io` and `storry.tv` (did not find this content when last
checked), `ipfs.io`, `dweb.link` and `w3s.link` (scripts get HTTP 429). A full verify therefore
produces no console errors.

An object is verified when at least two independent gateways return matching bytes. The vendor
gateways are public and anonymous, so they are fetched and shown, labelled as such, but they do not
count towards the two. The verdict says how many of each kind, e.g. "Verified: bytes match the
manifest on 8 public gateways (5 independent, 3 pinning-vendor)". Objects over 20 MB are only
checked after pressing an explicit button that states the size; they go to five of the gateways
(three independent, two vendor), one at a time.

Every gateway is fetched in parallel and each result is shown as it arrives. A gateway has 12
seconds to answer for objects under 1 MB (12 seconds to start answering for objects up to 20 MB;
minutes only behind the large-object button), after which its row says "No answer in 12 s". The
verdict is printed as soon as two gateways have matched, with a count of the ones still pending.

A fetch the browser refuses is probed once more in `no-cors` mode: if that opaque request succeeds,
the row says "Blocked by CORS"; if not, "Network failure". An HTTP error shows what the gateway
said. None of these is ever counted as a pass.

The IPNS card reads the `ipns` object from `getPublicationHistory` (name, label, resolved CID),
says whether the name points at the served root, and "Resolve now" fetches
`<gateway>/ipns/<name>/coverage.json` from `latam.orbitor.dev` and `ipfs.filebase.io` and compares
it with the served manifest. Without an `ipns` object the card says "IPNS not used".

Each run in the history also shows its CAR (name, size, CID, SHA-256) when the API reports one,
with links to fetch it by CID. The page never downloads a CAR itself.

"Check the earlier CID still resolves" fetches `coverage.json` under the older root. The expected
size and digest come from the served manifest, else from that run's own manifest fetched by its
CID, else from the value recorded in the pipeline repository (`RECORDED_PROBES` in
`src/sections/Artifacts.tsx`, which names the file it was copied from). The panel says which.

### Explore map tabs

| Tab                          | `findRoofingLeads` arguments                |
| ---------------------------- | ------------------------------------------- |
| Roofs older than N years     | `signal: aged_roof`, `minRoofAgeYears`      |
| Open roofing permits         | `signal: open_permit`, `permitStatus: open` |
| Ownership unchanged N+ years | `minYearsSinceTransfer` (default 10)        |
| Out-of-area owner (proxy)    | `ownerOccupied: no`                         |

Out-of-area is a proxy and the tab says so: the parcel is not flagged owner-occupied, and no
public source holds an owner mailing address. In a property's expansion, permits are shown as
open, pending (applied, not issued; not counted as open) or closed; the group comes from
`permit.status_group` through `queryAtlas`.

Coverage statements are never written into the UI: the permit jurisdictions on the Run summary are
counted live with `queryAtlas`, next to the run's own statement from `getCoverage.limitations`.

## Test ids

Stable `data-testid`s for driving the page. No native dialogs are used anywhere.

| Area      | Ids                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell     | `nav`, `nav-<section>`, `menu-button`, `header`, `header-county`, `header-as-of`, `header-root-cid`, `header-copy-cid`, `footer-limitations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Sections  | `section-summary`, `section-records`, `section-query`, `section-artifacts`, `section-map`, `section-agent`, `section-mcp`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Summary   | `latest-run`, `latest-run-id`, `permit-coverage`, `permit-coverage-table`, `permit-coverage-total`, `permit-coverage-statement`, `source-list`, `limitations-list`, `run-history`, `run-<id>`, `run-<id>-<source>-<entity>`, `run-<id>-total`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Records   | `record-totals`, `total-<table>`, `total-coordinates`, `permit-source-rows`, `bbb-note`, `source-table`, `source-fetched`, `source-run-finished`, `source-modified`, `source-time-note`, `rejects-table`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Query     | `duckdb-statement`, `schema`, `schema-<relation>`, `sql-example-<id>` (`aged-roofs`, `long-open-permits`, `owners-unchanged`, `out-of-area`, `top-contractors`, `forbidden`, `timeout`), `sql-rejected-kind`, `sql-input`, `sql-run`, `sql-row-count`, `sql-truncated`, `sql-results`, `sql-rejected`, `sql-rejected-message`, `sql-error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Artifacts | `manifest`, `manifest-unpublished`, `manifest-root-cid`, `manifest-previous-root`, `manifest-car`, `manifest-pins`, `manifest-json`, `object-<slug>`, `cid-<slug>`, `sha-<slug>`, `verify-<slug>`, `verify-full-<slug>`, `large-warning-<slug>`, `verify-all-small`, `verify-result-<slug>`, `verify-result-<slug>-summary`, `verify-result-<slug>-<gateway>` (with `data-outcome`), `verify-result-<slug>-<gateway>-kind`, `publication-history`, `publication-summary`, `publications-unavailable`, `verify-result-<slug>` carries `data-complete`; pending rows carry `data-outcome="pending"`, `check-resolves-<runId>`, `car-<runId>`, `resolve-basis-<runId>`, `resolve-result-<runId>-summary`, `gateway-list`, `gateway-<id>`, `other-gateways`, `other-gateway-<id>`, `ipns`, `ipns-unused`, `ipns-name`, `ipns-label`, `ipns-resolved-cid`, `ipns-points-at`, `ipns-resolve`, `ipns-result-summary` |
| Map       | `place-<id>`, `input-lat`, `input-lon`, `input-radius`, `input-min-age`, `input-min-years-held`, `search-submit`, `search-form-error`, `results-stale`, `transfer-base`, `apn-<apn>`, `detail-address`, `explore-map` (`data-map-ready`, `data-point-count`), `tab-aged`, `tab-permits`, `tab-ownership`, `tab-out-of-area`, `out-of-area-note`, `results-total`, `coverage-note`, `results-table`, `row-<apn>`, `expand-<apn>`, `detail-<apn>`, `permit-<permitId>` (with `data-permit-state`), `permit-pending`, `permit-counts`, `bbb`, `provenance`, `results-more`, `results-empty`                                                                                                                                                                                                                                                                                                                      |
| Agent     | `agent-place`, `agent-radius`, `agent-example-aged-roofs`, `agent-example-open-permits`, `agent-question`, `agent-ask`, `agent-idle`, `agent-loading`, `agent-unavailable`, `agent-error`, `agent-result`, `agent-answer`, `agent-assumptions`, `agent-evidence`, `agent-rows`, `agent-rows-count`, `agent-map`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| MCP       | `mcp-url`, `copy-mcp-url`, `curl-example`, `mcp-json`, `tester-tool`, `tester-args`, `tester-call`, `tester-status`, `tester-result`, `tool-catalogue`, `tool-<name>`, `tool-count`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

`<slug>` is the object's logical name with non-alphanumerics turned into `-` (`coverage.json` →
`coverage-json`); the directory root is `root`. Place ids: `downtown`, `la-jolla`, `chula-vista`,
`oceanside`, `escondido`, `el-cajon`, `carlsbad`, `encinitas`.

## Known limits of this UI

- SHA-256 over a large object needs the whole object in memory (WebCrypto has no streaming digest).
- Source licence lines are copied from the pipeline's `SOURCES.md`; the API returns limits but not
  the licence text.
- The map shows up to 100 results per search (20 at a time in the table); the total is always shown.

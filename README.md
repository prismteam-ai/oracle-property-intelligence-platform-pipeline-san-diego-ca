# Oracle Property Intelligence Pipeline: San Diego County, CA

**Live explorer UI (public, no login):** https://main.d3ckixhlz7ov75.amplifyapp.com
**Live data API:** https://mywcppj2yl.execute-api.us-east-2.amazonaws.com/health · MCP at `POST /mcp` · agent at `POST /agent`
**Credentials:** none needed. Everything is read-only.
**Demo video:** _link added with the Ready for Review PR_
**Companion PR (consumer):** `roofing-crm`, live at https://main.d3dhgfb9bfhbhb.amplifyapp.com, which reads this pipeline only through the MCP endpoint above.

**Latest published snapshot (run 7):** root CID `bafybeievgzncrw5djebyd3zcx2o5cd6guwamfk7l7qo7rfppxtznvmayhi`
**Earlier snapshots, untouched and still resolvable:** run 6 `bafybeih5vicdja4prbknofmxzln67pu5vg2saifog4qonlknv43nmwxsea` · run 3 `bafybeid7p55asvoy3r24wgrqny74akxdnts6kbne2b2k3thbz66ywo46wy`
Manifests, digests and gateway checks for all three are in [`publications/san-diego/`](publications/san-diego/).

## Decomposition

```
Outcome: real San Diego County property, permit, ownership, contractor and business records,
         reconciled and source-backed, queryable by a UI, an agent and the roofing CRM, published
         as content-addressed snapshots, with nothing running (and nothing billed) between requests.
Input:   public bulk sources only (no login, no scraping of interactive portals).
Steps:   1 Connect    one adapter per source: fetch a window, resumable            move-data          code
         2 Transform  one Zod schema per entity; bad rows go to `rejects` with why   check              code
         3 Persist    hash-compared upsert into DuckDB; run history with deltas      move-data          code
         4 Model      roofing class (rules), roof-age proxy, contractor identity     stare-and-compare  code
         5 Publish    Parquet -> gate -> CAR + CIDv1 -> pin x2 -> manifest -> verify  check              code
         6 Enact      MCP tools over DuckDB-on-Parquet; explorer UI                  move-data          code
         7 Inference  natural-language questions answered from retrieved rows        stare-and-compare  agent
Gates:   row schema at the source boundary; "one row per parcel, every point in the county"
         before publish; every pinning service must report the CID we computed; the serving
         function refuses any file whose SHA-256 differs from the manifest; agent SQL passes a
         single-SELECT guard with a time and memory limit.
Owner:   deterministic code for steps 1-6; a model only in step 7.
```

Shortest path taken: San Diego is not an onboarded Elephant county, so instead of the multi-day `onboard-county` route (Restate, Postgres, per-county lexicon transforms, portal scraping) this is a direct TypeScript pipeline from bulk open data that follows the Elephant output conventions: county slug, one flat gated `query-table.parquet`, CAR per directory root, Filebase, MCP tool names. Each source sits behind one adapter interface, so an Elephant adapter can replace any of them without touching the rest. What that leaves out is listed under "Kit deviations".

## What is loaded (run 7, real records)

| Table                                                   |      Rows | Source                                                                                                                                     |
| ------------------------------------------------------- | --------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| property (with coordinates)                             | 1,087,462 | SANDAG / SanGIS parcels (assessor attributes, centroids)                                                                                   |
| ownership (owner-occupied flag, last recorded transfer) | 1,087,462 | same                                                                                                                                       |
| permit (one row per permit)                             | 1,726,127 | City of San Diego 1,267,442 · unincorporated county 448,808 · Carlsbad 9,877 (1,756,884 source rows; 30,757 duplicate listings reconciled) |
| permit status history                                   | 1,128,036 | County of San Diego                                                                                                                        |
| permit-contractor records                               |   310,314 | County of San Diego (with CSLB licence numbers)                                                                                            |
| CSLB licences                                           |   246,104 | California Contractors State License Board                                                                                                 |
| contractor (reconciled)                                 |   256,944 | CSLB + county permits, keyed on licence number                                                                                             |
| business                                                |    60,261 | City of San Diego active business tax certificates                                                                                         |
| rejects (kept, with reason)                             |     7,847 | all sources                                                                                                                                |

Roofing signals: 25,204 roofing permits (roof-mounted solar classed separately and excluded), 1,170 open, 251 open five years or more; 1,026,319 parcels have a roof year, 15,394 of them from a completed roofing permit and the rest from the assessor's effective year. Ownership: 1,077,377 parcels have a usable last-transfer date (93,286 certain, 984,091 resolved by a named rule). Per-source detail, measured speeds, licences and limits: [`SOURCES.md`](SOURCES.md).

## Continuous and incremental: the run history

| Run | Started (UTC, 25 Nov 2026) | What it was                                                                |      Read |  Inserted |   Updated | Unchanged |
| --: | -------------------------- | -------------------------------------------------------------------------- | --------: | --------: | --------: | --------: |
|   1 | 16:15:43                   | initial full load, window up to 15 Nov                                     | 5,922,627 | 5,918,730 |         0 |         0 |
|   2 | 16:22:28                   | incremental, window from 10 Nov (17 s)                                     |   507,201 |     2,755 |        50 |   504,389 |
|   3 | 16:22:47                   | forced full re-read: idempotence check                                     | 4,015,979 |         0 |         0 | 4,014,789 |
|   4 | 17:16:12                   | new source (Carlsbad) + coordinate rule                                    | 5,935,296 |    11,982 |       336 | 5,921,149 |
|   5 | 17:20:51                   | fresh county download: nothing missed                                      | 2,170,528 |         0 |         0 | 2,169,859 |
|   6 | 17:29:05                   | classification and status rule fixes                                       | 5,935,296 |         0 |   145,627 | 5,787,840 |
|   7 | 19:01:13                   | stricter roofing rule, duplicate permits reconciled, transfer dates graded | 5,935,296 |         0 | 1,093,390 | 4,840,077 |

Runs 3, 6 and 7 were published (below). Every run and its per-source counts are served live by the `getPipelineRuns` tool and shown in the explorer. Change detection per source: a cursor on the source's own change date where it has one (county permits, status history, contractors), an ETag or layer edit stamp for snapshot sources, and a row hash for everything, so re-reading unchanged data writes nothing.

A scheduled run is defined in [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) (daily, restores state from the mirror bucket, publishes only if something changed). It has not executed yet: it starts with the first push to GitHub. Until then runs are started by hand.

## Published snapshots (IPFS)

- The CAR and every CID are computed here, with the reference (Kubo) chunking, not by a vendor. Identity is the CID; URLs are locators.
- **Filebase** imports the CAR and must report our root CID. **Pinata** receives the ten files individually and must report our ten file CIDs. Both did, for both runs.
- Each run has a `manifest.json` (root CID, previous root CID, and for every object: CID, logical name, size, codec, SHA-256; pins; CAR name, size and digest) and a `verification.json`.
- Each publication names the previous root: run 7 points to run 6, run 6 to run 3. Earlier CIDs were not touched and still resolve.
- `npm run verify:ipfs -- --manifest publications/san-diego/run-0007/manifest.json` needs no credentials: it fetches every object from public gateways and compares size and SHA-256.

**About `ipfs.io` and `dweb.link`** (the story's example gateways): since September 2026 they answer scripts with HTTP 429 ("switching to a service worker gateway only") and put automated browsers through a bot challenge; they are meant for interactive use. Scripted checks therefore use other public, anonymous gateways and record each one's real status. Matching bytes were fetched from three independent gateways (`latam.orbitor.dev`, `ipfs.raribleuserdata.com`, `ipfs.hypha.coop`) and from the public gateways of the two pinning services (`gateway.pinata.cloud`, `ipfs.filebase.io`). `4everland.io` and `storry.tv` are also tried; at the time of writing they did not find this content.

The CAR files are 172 MB each, above GitHub's per-file limit, so they are not in git. Both are pinned at Filebase (the import is what produced the root CIDs above), any IPFS node can rebuild one with `ipfs dag export <rootCid>`, and the manifest carries each CAR's size and SHA-256. They will also be attached to the GitHub Release that accompanies this PR.

## Query layer, MCP and agent

- **DuckDB with no database server.** The serving function is an in-memory DuckDB whose only contents are views over the published Parquet files. On a cold start it copies one run from a private mirror bucket and checks each file against the manifest digest; bytes that do not match are refused. The mirror is a cache of content-addressed data, not a source of truth.
- **MCP** (`POST /mcp`, stateless streamable HTTP): `findRoofingLeads`, `getOracleProperty`, `getAtlasDatasetInfo`, `getAtlasSchema`, `queryAtlas`, `getPipelineRuns`, `getCoverage`, `getArtifactManifest`, `getPublicationHistory`. The roofing CRM uses the first five; nothing else reaches the data.
- **Story queries.** Radius search around a point; roofs older than N years (default 15, any N); open roofing permits, longest open first, with contractor, CSLB licence, and BBB rating or the stated reason it is missing; ownership unchanged for N years (`minYearsSinceTransfer`); out-of-area owners by the available proxy (`ownerOccupied: "no"`). Every row carries its source, source record id, source URL and fetch time.
- **Agent** (`POST /agent`): Vercel AI SDK, four Zod-typed tools, answers only from rows the tools returned, lists its assumptions and what is missing. A deterministic check flags any parcel number in the answer that no tool returned.
- **`queryAtlas` guard**: exactly one read-only SELECT, no file or network functions, 1,000-row cap applied from outside, 15-second interrupt, memory cap, and the engine's own external access switched off.

Example MCP call:

```bash
curl -s https://mywcppj2yl.execute-api.us-east-2.amazonaws.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"findRoofingLeads",
       "arguments":{"center":{"lat":32.8328,"lon":-117.2713},"radiusMiles":5,
                    "signal":"open_permit","minOpenYears":5,"sort":"open_days","limit":5}}}'
```

## Demo transcript, and where each line happens

| Transcript line                                                               | Where                                                                                   |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Pipeline run summary: run, sources, coverage, counts, timestamps, limitations | Explorer, "Run summary"                                                                 |
| Total uploaded records by source, with timestamps and provenance              | Explorer, "Records by source"                                                           |
| DuckDB-backed query layer, no Oracle-hosted database                          | Explorer, "Query layer (DuckDB)"                                                        |
| Published artifact manifest                                                   | Explorer, "Published artifacts (IPFS)"; `publications/san-diego/run-0007/manifest.json` |
| Retrieve an artifact by CID from two public gateways, bytes match             | Explorer "Verify now"; `npm run verify:ipfs`; `verification.json`                       |
| A later publish produced a new CID without mutating the previous one          | Explorer "Publication history"; `publications/san-diego/index.json`                     |
| UI: properties in a radius with roofs older than 15 years                     | Explorer, "Explore map"                                                                 |
| Open roofing permits, long-open first, with contractor and BBB                | Explorer, "Explore map", open-permit tab and row detail                                 |
| The two agent prompts                                                         | Explorer, "Ask the agent"                                                               |
| MCP-ready                                                                     | Explorer, "MCP": live tool catalogue, curl and client snippet                           |

## Zero standing cost

One Lambda function, one HTTP API, one mirror bucket holding about 170 MB, static hosting for the explorer. Nothing runs between requests. The pipeline itself runs on a developer machine or a scheduled CI runner and keeps no server. The published data lives on IPFS under two pinning services' free tiers.

## Run it

Requires Node 24 for the pipeline and tools (the deployed function runs on the Node 22 Lambda runtime).

```bash
npm ci
npm run check                                   # typecheck, lint, format, 218 tests (offline, recorded real rows)
npm run pipeline                                # full load into data/oracle.duckdb (about 7 minutes)
npm run pipeline -- --window 2026-11-10..       # incremental window
npm run query -- "SELECT * FROM run_history"    # ad-hoc SQL on the working database
npm run publish:ipfs                            # export, CAR, pins, manifest (keys from the environment)
npm run verify:ipfs -- --manifest publications/san-diego/run-0007/manifest.json
npm run serve -- --artifacts data/artifacts/publish/san-diego/run-0007   # local MCP on :8790
npm run build:lambda && npx cdk deploy -c artifactPrefix=san-diego/run-0007
cd explorer && npm ci && npm run dev            # explorer UI against the live API
```

Publishing keys (`FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `FILEBASE_BUCKET`, `PINATA_JWT`) come from the environment only. Without them the run is still exported, packed and written to a manifest, just not pinned. No secret is in this repository.

## Known limits, stated plainly

- **Permit coverage is 3 of 19 jurisdictions.** City of San Diego, the unincorporated county and Carlsbad (a frozen 2022-2023 snapshot) publish bulk permit data. The other cities checked expose only interactive portals or token-gated layers, which this pipeline does not scrape; `SOURCES.md` records what was found for each. Search results say so explicitly instead of returning a silent zero.
- **Ownership is partial.** No county-wide public source carries owner names or mailing addresses. The data has an owner-occupied flag and the last recorded transfer document. "Out-of-area owner" is therefore a proxy (not flagged owner-occupied) and over-counts. Two cities (Oceanside, El Cajon) expose owner name and mailing address on open parcel layers; they were deliberately not loaded, because that is homeowner personal data and its exposure looks unintended.
- **Ownership dates.** Most last-transfer dates arrive with two-digit years. 93,286 are certain; 984,091 are resolved to this century by two named rules (an owner-occupied exemption on the parcel, or a typed recorder document on a taxable parcel: only 58 last documents fall in 1927-1939 against tens of thousands a year for 2000-2026); 7,494 stay ambiguous and are left out of the "unchanged for N years" filter. Each row carries its confidence and rule.
- **BBB ratings are not collected.** There is no bulk source and BBB's terms limit copying. Every contractor row carries the reason, and the UI shows it.
- **Roof age is a proxy**: the last completed roofing permit where one exists (high confidence), otherwise the assessor's effective year (medium, or low when a two-digit year is ambiguous). Each row says which.
- **Roofing class comes from rules** over approval type and description, unit-tested on recorded real rows but not measured against a labelled set. A permit counts as roofing only when its type is building work and the text is about the roof itself; a re-roof inside a solar job counts only when the text says it is a full re-roof, which will miss some real ones.
- **The same permit can be listed twice by a source** (City "N" and "PMT-N"; county legacy "...1" and "...999"). 30,757 such pairs are reconciled to one permit, with the other id kept as an alias; 15 City pairs failed the date-or-parcel check and were left separate.
- **Decades-open county permits** are probably permits never finalled in the record, not active jobs.
- **Deletes are not tombstoned**: a record that disappears from a source keeps its last state, with `last_seen_run` showing when it was last present.
- **No IPNS name.** The manifest chain (`previousRootCid`) and the run index give the history; an IPNS pointer is optional in the story and was left out.

## Kit deviations, each deliberate

- No lexicon records, `elephant-cli`, Atlas PR or global IPNS: those belong to the county-onboarding route this exercise did not take (see "Shortest path"). The slug, query-table shape and gate, CAR, manifest fields and MCP tool names follow the conventions.
- The Filebase bucket is `oracle-open-data-san-diego-rv` in a personal account, not the organisation's `elephant-oracle-open-data-*`.
- The loader is TypeScript end to end, per the engineering guidelines; no Python.
- No custom API domain, PagerDuty service or Lexicon metric registration: those are tied to company accounts. Alarms go to an SNS topic.
- The agent is a single-turn tool loop with the Anthropic provider behind the Vercel AI SDK (a new personal AWS account has no Bedrock model access by default).
- External sources are read by a batch job with bounded concurrency, backoff and resumable downloads, not through SQS queues: the job has no interactive caller and no side effects on the sources.

## AI work log

- Built with Claude Code driving sub-agents; I set the entity contracts, the gates and the publish rules, and reviewed what came back.
- **Kit agents used as reviewers.** The kit's `oracle`, `machamp` and `metagross` agent definitions were run as read-only reviewers over both repositories (under Claude, not the model the definitions name). They scored the pipeline 35 (oracle) and 55 (machamp) before fixes, mostly for not using the lexicon / elephant-cli path. From their findings I fixed: publishing only runs that ended `ok`; a time and memory limit on `queryAtlas` (a three-way cross join had returned a 503); ownership filters for the "10 years" and "out-of-area" questions; a second publication with the run index and manifests committed; limitations text built from the data instead of hard-coded.
- **Rejected or corrected:** a Python loader (standard is TypeScript); a first "open permit" rule that counted applied-but-never-issued permits as open (141,190 rows moved to `pending`); a roofing rule that matched text before approval type and classed agreements and construction-change records as roofing (1,070 rows stopped being roofing); a publish step that looped on slow gateway downloads (verification is now a separate, credential-free command); a manifest schema mismatch that took the live API down for four minutes after a deploy (found by calling the live endpoint, fixed, and the serving layer is now tested locally against each new run before deploy).
- **From the independent evaluation of the live sites** (kit `slowking` definition, read-only): a planning review topped the long-open roofing list (roofing rule tightened: 1,471 open roofing permits became 1,170); the same permit appeared under two ids (30,757 pairs reconciled); the "unchanged 10 years" filter could use 9% of parcels (transfer dates graded: now 99%); a crafted statement could close the row-cap wrapper of `queryAtlas` (parentheses must balance; test added); gateway verification took 63 seconds (12-second budget per gateway, three independent gateways found).
- **Found by testing, not by reading:** the story's two example gateways no longer serve scripts; Pinata's free plan refuses CAR uploads but its plain uploads produce our CIDs once the chunking matches Kubo's.

## Timeline (UTC, 25 Nov 2026)

| Time  | Milestone                                                            |
| ----- | -------------------------------------------------------------------- |
| 14:26 | Assignment received                                                  |
| 15:36 | Work started                                                         |
| 16:22 | First full load complete (5.9M records)                              |
| 16:46 | Data API live on AWS                                                 |
| 16:58 | First publication (run 3) pinned at two services                     |
| 17:36 | Run 6 complete: third permit jurisdiction, rule fixes                |
| 17:41 | Second publication (run 6), linked to the first                      |
| 18:45 | Independent evaluation of the live sites (kit `slowking` definition) |
| 19:08 | Run 7 complete: evaluator data-truth findings fixed                  |
| 19:15 | Third publication (run 7), linked to the second                      |

---

# Original assignment (unchanged)

## Oracle Property Intelligence Platform Pipeline - San Diego County, CA

### Context

This repository is the **data gathering and ingestion pipeline** that supplies the [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm). The CRM helps roofing companies explore properties in their service area, identify aging roofs and open roofing permits, and turn those signals into leads. This pipeline story covers collecting, loading, reconciling, and exposing the underlying property and permit datasets; the CRM UI/workflow itself is out of scope here.

The Oracle ingestion pipeline has been started, but the full **San Diego County, CA** dataset has not been completely uploaded, reconciled, or demonstrated. The infrastructure must be designed so Oracle does not carry ongoing infrastructure cost by default. For this candidate exercise, the candidate acts as both Oracle and builder: they are responsible for completing the pipeline and proving the low-cost infrastructure approach.

The pipeline must be continuous and incremental (ongoing ingestion of new and changed records over time) and must publish eligible data artifacts to Elephant IPFS (the Elephant protocol’s decentralized storage layer, following Lexicon / elephant-cli / Filebase+IPNS conventions used by the Elephant oracle skills).

Published artifacts must remain independently retrievable from the public IPFS network after the candidate’s local environment, demo session, and any single pinning vendor are gone. **Content identifiers (CIDs) are the durable identity of each artifact.** A vendor HTTP gateway URL is a convenience locator, not the artifact.

In addition to standard property intelligence, the pipeline must surface signals relevant to **roofing lead generation**, including roof age, open roofing permits (especially long-open permits), contractor identity, BBB rating scores where available, ownership/contact fields where available, and accurate property coordinates for radius-based search.

### Description

Complete the Oracle pipeline by loading all available San Diego County, CA property, permit, ownership, business, contractor, location, and public-source data into an MCP-ready database. Use IPFS and DuckDB to minimize Oracle-hosted infrastructure costs while enabling UI and agent access to answer property intelligence questions that support the roofing CRM—especially aged-roof and open-permit lead discovery within a map radius.

The pipeline must demonstrate that data is ingested on an ongoing basis (not a one-shot bulk load): support incremental / windowed refreshes, preserve run history with record deltas and timestamps, and re-publish updated artifacts to Elephant IPFS as **new immutable CIDs** (do not mutate a previously published CID).

### Acceptance Criteria

#### Geography & coverage

- Target **San Diego County, CA** as the default and primary county for ingestion and demos.

#### Data loading

- Run the Oracle pipeline until all available county data is uploaded.
- Load available property records into the database.
- Load available permit records into the database, with emphasis on **roofing-related permits**.
- Preserve permit status, open/close dates (or equivalent), and duration-open signals so long-open permits can be identified.
- Load available ownership records into the database.
- Load available contractor records into the database.
- Load available BBB / contractor rating scores where publicly available.
- Load available business records into the database.
- Load available location and coordinate data into the database (required for GPS/pin-drop radius queries in the CRM).
- Capture roof age or best-available proxies (e.g., year built, last roofing permit/completion date) so properties with roofs older than a configurable threshold (default suggestion: **15 years**) can be queried.
- Reconcile duplicate entities across all uploaded datasets.
- Preserve source provenance for uploaded records.
- Design and implement the pipeline as continuous / incremental:
  - Support ongoing ingestion of new and changed records (scheduled or on-demand refreshes, change detection or bounded windows, idempotent steps).
  - Maintain a visible history of pipeline runs (timestamps, source list, record counts, deltas, any source limitations).
  - Demonstrate that data continues to be ingested and published over time (multiple runs or simulated ongoing updates).

#### Infrastructure & access

- Optimize pipeline performance where feasible.
- Identify slow source sites or constrained data sources.
- Document pipeline speed limitations and source constraints.
- Design the infrastructure so Oracle does not carry ongoing infrastructure cost by default.
- Use IPFS for decentralized storage of eligible dataset artifacts.
- Use DuckDB for local or portable analytical querying.
- Structure the database to support MCP access.
- Enable agent access to query the database.
- Provide a UI for exploring the uploaded data.

#### IPFS publication

- Treat IPFS **CIDs** as the durable identity of published artifacts. Do not treat a vendor-specific HTTP URL as the source of truth.
- Prefer **CIDv1** (base32) for every published object.
- Keep published bytes **retrievable from the public IPFS network**, not only from a private node, authenticated gateway, vendor dashboard, or laptop that is running during the demo.
- Publish a machine-readable **artifact manifest** (JSON) for each pipeline run. Include every eligible object (query table, coverage, indexes, sample extracts, and any directory roots) with at least:
  - `cid`
  - logical `name` / path
  - `size` in bytes
  - IPFS codec (`file` vs `directory`)
  - content digest (e.g. SHA-256 of the raw bytes, or equivalent)
  - optional provider `origins` (multiaddrs) if a candidate-operated node is still serving the blocks
- If IPNS is used, record both the IPNS name and the **resolved CID** for that run. IPNS is a pointer; the CID is the snapshot.
- On incremental republish, keep prior CIDs immutable. New data produces a new CID. Run history must retain previous CIDs.
- For directory artifacts, also publish a **CAR** of the DAG rooted at that CID so the snapshot can be imported by any IPFS node without re-encoding.
- Demonstrate that each listed CID can be fetched from **at least two independent public gateways** that this environment does not operate (for example `https://ipfs.io/ipfs/<cid>` and `https://dweb.link/ipfs/<cid>`), and that the retrieved bytes match the manifest size/digest.
- Include the artifact manifest (and CARs, if any) in the repository or demo packet so a third party can fetch the dataset by CID after the candidate environment is gone.

#### Roofing CRM–supporting queries

- Support radius-based property identification using coordinates (around a GPS point or map pin).
- Support questions about properties with roofs older than 15 years (or a configurable age threshold).
- Support questions about properties with **open roofing permits**, including those that have remained open for many years.
- Support returning permit details with contractor name and BBB rating score where available.
- Support questions about properties that have not exchanged ownership in more than 10 years.
- Support questions about properties with regional (or out-of-area) owners.
- Return source-backed answers where source data is available.

#### Demonstration

- Demonstrate the uploaded dataset through the UI.
- Demonstrate the uploaded dataset through an agent query aligned to roofing lead discovery.
- Demonstrate that Oracle can operate without carrying the infrastructure cost.
- Demonstrate public, CID-addressed IPFS publication using the artifact manifest and independent gateway retrieval (not a private-only locator).
- Confirm the candidate fulfilled both Oracle and builder responsibilities for this milestone.
- Pass the demo using real uploaded San Diego County records.

### Demo Transcript

- Presenter: “I will demonstrate that the Oracle pipeline has loaded the available dataset for San Diego County, California, that the data is queryable through DuckDB, that eligible artifacts are stored on IPFS as content-addressed snapshots, and that both the UI and agent can answer property intelligence questions that support roofing lead generation.”
- Presenter: “First, I am opening the pipeline run summary.”
  - Expected Result: The system displays the completed pipeline run, source list, county coverage, record counts, timestamps, and any documented source limitations.
- Presenter: “Show the total uploaded records by source.”
  - Expected Result: The system shows uploaded property, permit, ownership, contractor (with BBB rating where available), business, and coordinate records with collection timestamps and provenance.
- Presenter: “Now I am opening the DuckDB-backed query layer.”
  - Expected Result: The system confirms that the loaded data is available for structured querying without requiring Oracle-hosted database infrastructure.
- Presenter: “Show the published artifact manifest for this run.”
  - Expected Result: A JSON (or equivalent) listing every eligible artifact with CID, size, logical name, codec, and digest. Gateway URLs, if shown, are derived from those CIDs. An IPNS name, if used, is shown together with the resolved CID.
- Presenter: “Retrieve one published artifact by CID from a public gateway that this environment does not operate, then again from a second independent public gateway.”
  - Expected Result: Both fetches succeed and the bytes match the manifest size/digest. Serving the object only from a private, local, or authenticated gateway is a fail.
- Presenter: “Show that a later incremental publish produced a new CID without mutating the previous one.”
  - Expected Result: The prior CID still resolves; the new run has a distinct CID; IPNS (if used) now points at the new CID; both CIDs appear in run history. A CAR is available for any directory root.
- Presenter: “Using the UI, show properties within a sample radius that have roofs older than 15 years.”
  - Expected Result: Matching properties are returned with roof-age basis, coordinates, and source provenance.
- Presenter: “Show properties in that area with open roofing permits, prioritizing permits that have remained open for many years, including contractor and BBB rating where available.”
  - Expected Result: Results include permit status/open duration, contractor identity, BBB score when present, and clear source backing.
- Presenter: “Now I am asking the same type of questions through the agent.”
  - Agent Prompt: “Which properties in San Diego County within five miles of [city xyz] have roofs older than 15 years?”
    - Expected Result: The agent returns matching properties, explains the reasoning, and includes source-backed evidence.
  - Agent Prompt: “Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?”
    - Expected Result: The agent returns a filtered list with permit age/open duration, contractor details, BBB rating when available, and clearly identifies any assumptions or missing data.
- Presenter: “Finally, I will show that the system is MCP-ready.”
  - Expected Result: The system demonstrates an MCP-ready interface or documented MCP-compatible query structure that agents and the roofing CRM can use without changing the data model.

### Out of Scope

- Roofing CRM UI, map pin/GPS interaction design, and lead outreach workflows (covered in [roofing-crm](https://github.com/prismteam-ai/roofing-crm)).
- Live outbound messaging to property owners.

### Reference

- [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm)
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills)

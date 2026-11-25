# Slice 1 notes: the loader

Slice 1 is the tested, idempotent, incremental loader that puts real San Diego County records into one
DuckDB file, with provenance and run history. IPFS publication, the MCP interface and the UI are later
slices and are not started.

All numbers below are from the database built on 25 November 2026 (UTC). Run logs are in `docs/run-logs/`.

## How to run

Needs Node 24. No account, key or payment is needed for any source.

```
npm ci
npm run pipeline                               # everything, all sources
npm run pipeline -- --window 2026-11-10..      # incremental: changes since 10 Nov
npm run pipeline -- --window ..2026-11-15      # everything changed before 15 Nov
npm run pipeline -- --force                    # re-read snapshot sources even if unchanged
npm run pipeline -- --sources sdcounty_permits # one source
npm run query -- "SELECT * FROM run_history"   # ad-hoc SQL, prints JSON lines
npm test                                       # 78 offline tests
npm run check                                  # tsc, eslint, prettier, tests
```

Raw downloads go to `data/raw/<source>/<run-date>/` and the database to `data/oracle.duckdb`; both are
git-ignored. An interrupted run resumes: raw files already on disk for the run date are reused.

## What loaded

| Table                                          |       Rows | From                                                                                |
| ---------------------------------------------- | ---------: | ----------------------------------------------------------------------------------- |
| `property`                                     |  1,087,462 | SANDAG parcels                                                                      |
| `ownership`                                    |  1,087,462 | SANDAG parcels                                                                      |
| `permit`                                       |  1,744,902 | 1,272,410 City of San Diego + 472,492 unincorporated county                         |
| `permit_status_history`                        |  1,128,036 | County status history                                                               |
| `permit_contractor_record`                     |    310,314 | County permit contractors                                                           |
| `cslb_license`                                 |    246,104 | CSLB licence master (statewide)                                                     |
| `contractor`                                   |    256,944 | Reconciled: 246,104 from CSLB + 10,840 seen only on county permits                  |
| `business`                                     |     60,261 | City of San Diego business tax certificates                                         |
| `rejects`                                      |      4,400 | 3,247 bad source rows from run 1, plus 1,153 of the same rows logged again by run 3 |
| `permit_contractor` (derived)                  |    430,557 | Permit-to-contractor links with match method                                        |
| `business_contractor` (derived)                |      5,156 | Business-to-contractor name matches                                                 |
| `pipeline_run` / `run_source_stats` / `source` | 3 / 27 / 8 | Run history and source registry                                                     |

The DuckDB file is 888 MB. Raw downloads are 3.0 GB.

Every data row carries `source_id`, `source_record_id`, `source_url`, `fetched_at`, `first_seen_run`,
`last_seen_run` and `row_hash`.

### Run history (real, not simulated)

| Run | Window                     | Result                                                                                                                                                                                                                                                      |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | changes before 15 Nov 2026 | Initial load. County permits: 471,641 inserted.                                                                                                                                                                                                             |
| 2   | changes since 10 Nov 2026  | County permits: 851 inserted, 34 updated, 472 unchanged. Status history: 1,572 inserted, 720 unchanged. Permit contractors: 331 inserted, 166 unchanged. Parcels, city permits and businesses skipped as not modified. Contractors: 1 inserted, 16 updated. |
| 3   | same window, `--force`     | Idempotency at full scale: about 2.7 million source records re-read, **0 inserted, 0 updated**, everything unchanged.                                                                                                                                       |

Wall time: 6 min 40 s, 17 s and 2 min 8 s. An earlier cold pull of everything took 12 min 29 s
(see `SOURCES.md` for per-source speeds).

### Roofing signals

- **Roofing permits:** 30,259 (`is_roofing`): 26,323 reroof, 3,296 roof structural, 640 roof repair.
  195,225 further permits are roof-mounted solar and are classed `solar-on-roof`, not roofing.
- **Open roofing permits:** 2,135. Open two years or more: 1,428. Open five years or more: 1,237, of which
  1,078 name a contractor and 134 resolve to a CSLB licence.
- **Roof age:** 15,622 parcels take their roof year from a completed reroof permit (confidence high);
  758,590 from the assessor effective year with a certain century (medium; this includes 39,699 ambiguous years
  corroborated by a permit on the parcel in the three years before); 252,109 from an ambiguous two-digit year (low); 61,141 have no basis.
  947,616 parcels have a roof 15 or more years old on these bases.
- **Sample radius query** (5 miles around El Cajon, 32.7948, -116.9625): 100,227 parcels, 87,466 with a roof
  15 or more years old, 250 open roofing permits.

## Design choices worth knowing

- **Strict TypeScript, one adapter per source.** Each external source sits behind `SourceAdapter`
  (`fetch(window)` then `rows()` yielding validated rows). Swapping a provider means writing one file.
- **Validation at the step boundary.** Every row passes its entity's Zod schema or goes to `rejects` with a
  reason and the raw record. Checks: required keys, types, 10-digit APN, coordinates inside the county
  bounding box (lat 32.5 to 33.55, lon -117.65 to -116.05), dates not before 1900 and not in the future,
  no negative amounts, no unknown columns.
- **Bulk path.** Validated rows are written to NDJSON stage files and loaded with DuckDB `read_json`; upserts
  are set-based SQL. Nothing is inserted row by row.
- **Idempotent upsert.** Natural key plus a hash of the data columns: new key is inserted, changed hash is
  updated, same hash is counted unchanged. Keys are enforced by the loader and checked after every run
  (no duplicate keys in any table), rather than by database constraints.
- **Incremental.** County sources have a change column, so `--window` filters at the server. Parcel, city
  and business sources are whole snapshots: a change token (ETag or layer edit stamp) decides whether to
  read them, and row hashes find what changed.
- **Derived facts live in views and rebuilt tables,** so they never disturb change detection: `permit_enriched`
  (days open, best coordinate, primary contractor), `roof_signal` (roof year, age, basis, confidence) and the
  macros `haversine_miles`, `properties_within(lat, lon, miles)` and `roofs_older_than(years)`. The age
  threshold is always the caller's parameter.

### Reconciliation

- **Same parcel across sources:** APNs are reduced to 10 digits at the boundary (`498-320-16-00` and
  `4983201600` are one key). 1,066,896 of 1,272,410 city permits (84%) and 440,892 of 472,492 county permits
  (93%) match a parcel. Permits without their own coordinate fall back to the parcel centroid.
- **Duplicate records inside a source:** 5 parcels with two polygons (largest kept), 632 county permit ids
  listed twice, 20 city approvals present in both files (closed file wins). Counted per run in
  `run_source_stats.duplicates`.
- **Contractors:** keyed on CSLB licence number. 7,714 contractors appear in both the CSLB master and county
  permits and are one row each. 309,267 permit links are by licence number. City permits carry only a
  holder name, so they link by normalised name: 89,326 unique matches and 30,925 flagged ambiguous (more than
  one licence shares the name). `permit_contractor.match_method` records which.
- **Two-digit years:** a year cannot be in the future, so `yy` above 26 is 19yy for certain; `yy` of 26 or
  below is read as 20yy and flagged ambiguous; the raw value is kept. 293,132 parcels are ambiguous, 75,824
  of them the suspicious value `00`. `roof_signal.confidence` and `confidence_reason` expose this.

## What failed or is missing, and why

1. **Owner name and mailing address: not available.** No public layer carries them. `ownership` holds the
   owner-occupied flag (472,485 parcels), the last recorded document date (1,084,871 parcels) and document
   type. `out_of_area` is a proxy, "not flagged owner-occupied", and is true for 614,977 parcels, which
   certainly over-counts (it includes commercial and rented property). The basis is stated in a column.
2. **BBB ratings: not collected.** BBB's Terms of Use allow copying its content only for personal,
   non-commercial use. The columns exist and are null, with the reason on every contractor row.
3. **Permits cover the City of San Diego and the unincorporated county only.** The other 17 cities issue their
   own permits and were not sourced. Roofing permit coverage outside those two jurisdictions is zero.
4. **City reroof permits are few:** 5,791 of 1.27 million approvals, against 20,532 of 472,492 in the
   unincorporated county. I did not check the city's rules on when a reroof needs a permit. Most roof-age
   answers in the city therefore rest on the assessor effective year, not on a permit.
5. **3,247 source rows were rejected:** 2,073 county permits and 32 city permits geocoded outside the county
   (the county ones resolve to places such as Texas and New Jersey), 1,103 parcels with no APN, 20 contractor
   rows with neither licence nor name, 14 city permits with expiry dates beyond 2100, 4 businesses with
   start dates out of range, 1 county permit issued in 2099.

## Open issues

- **Rejecting a permit for a bad coordinate loses the permit.** The 2,105 rows rejected for coordinates may
  have good APNs. Nulling the coordinate and keeping the row would be kinder; I followed the brief
  ("reject bad rows") and am flagging it.
- **Last-transfer dates are flagged ambiguous for 991,585 parcels,** because any `yy` of 26 or below could be
  19yy. The flag is honest but too broad to be useful as it stands.
- **Deletes are not handled.** A row that disappears from a source stays in the table; `last_seen_run` shows
  it was not seen, but nothing marks it removed.
- **Roofing classification is text rules.** They were tuned on samples of the real data and are unit-tested
  on real descriptions, but precision and recall have not been measured against a labelled set. 16,230
  permits (13,696 city, 2,534 county) mention a roof and stay unclassified (`roof_mention_unclassified`).
- **City "open" status is taken at face value.** 306,589 city approvals are `Issued`; many are old permits the
  city never closed out, so "long-open" in the city means "never finalled in the record".
- **`rejects` grows on every full read** because it is a per-run log. A consumer should filter by `run_id`.
- **Engineering-standards gaps, deliberate for a local slice:** no AWS, CDK, Powertools, queues or PagerDuty.
  External calls are direct with timeouts, bounded concurrency and backoff with jitter; a failed source is
  recorded in run history and gives a non-zero exit code. CI is defined (`.github/workflows/ci.yml`) but has
  not run, because nothing was pushed.
- **Not started:** IPFS publication and manifest, MCP interface, UI, scheduling.

# Slice 1 notes: the loader

Slice 1 is the tested, idempotent, incremental loader that puts real San Diego County records into one
DuckDB file, with provenance and run history. IPFS publication, the MCP interface and the UI are later
slices and are not started.

All numbers below are from the database built on 25 November 2026 (UTC). Run logs are in `docs/run-logs/`.

## Update: run 7 (25 November 2026, 19:01 UTC)

This section is current. Where a number differs from a later section, this one wins.

### What changed

1. **`is_roofing` needs two things.** The approval type must be building or construction work, and the
   text must be about the roof itself.
   - Refused by type: planning and discretionary approvals (a "Substantial Conformance Review" was first in
     the long-open list), agreements, single-trade permits (electrical, mechanical, plumbing, fire), solar
     permits, and any type the loader does not recognise. A blank type is accepted.
   - Roof-structure work counts only when the structure is the object of a replace, repair, reframe or
     reinforce verb, or is a new roof structure over an existing building. "An integrated roof structure"
     on a new restaurant shell and "new roof framing" on an addition no longer count.
   - A reroof inside a solar job counts only when the text says the whole roof was redone ("FULL REROOF FOR
     PV"). "Uninstall and reinstall solar modules after reroofing" is a solar permit.
   - Under the county's new-building categories, a real reroof is kept but roof-structure and roof-repair
     phrases are treated as part of the new building.
2. **A permit listed twice is shown once.** The city lists 5,000 permits as both `N` and `PMT-N`; the county
   lists 25,757 legacy permits as both `<base>1` and `<base>999`. A pair is one permit when the ids match by
   that pattern and the applied date or APN agrees (15 city number matches failed that test and were left
   alone). The record further along is kept; on a tie, `PMT-N` and `<base>1`. `permit_alias` holds the pairs,
   `permit_enriched` leaves the alias row out and carries the other id in `alias_permit_id`. Both source rows
   stay in `permit`. The county `999` copies were often stuck at "Issued" while their twin was completed,
   so this also removed false long-open permits.
3. **Last-transfer dates are graded** in `ownership.last_transfer_confidence`, with the rule in
   `last_transfer_rule`:

   | Outcome   | Rule                                    | Parcels |          Held 10+ years |
   | --------- | --------------------------------------- | ------: | ----------------------: |
   | certain   | `yy_gt_current_19xx`                    |  93,286 |                  93,286 |
   | resolved  | `owner_occupied_exemption_20xx`         | 443,713 |                 170,797 |
   | resolved  | `typed_document_on_taxable_parcel_20xx` | 540,378 |                 192,762 |
   | ambiguous | `yy_le_current_no_corroboration`        |   7,494 | (5,088 if read as 20yy) |
   | no date   | `unparseable`                           |   2,591 |                         |

   "Ownership unchanged for 10+ years" can now use 456,845 parcels instead of 93,286. The document number
   was checked and does not help: it is a six-digit sequence with no year in it. The evidence for the second
   rule is the distribution of the certain dates: last documents dated 1927 to 1939 number 58 in thirteen
   years, against 11,000 to 85,000 a year for yy 00 to 26, and most pre-1960 documents carry no type code.
   The parcels left ambiguous are tax-exempt (public agencies, churches, utilities), which really can hold
   land for a century.

4. **Fetch times are UTC with a zone** and every source has one. See "Fetch times" in `SOURCES.md`.

### Roofing permits by class (all permit rows, before and after)

| Class                       | Before run 7 | After run 7 |
| --------------------------- | -----------: | ----------: |
| reroof                      |       26,420 |      25,712 |
| roof repair                 |        1,025 |         842 |
| roof structural             |        2,327 |         823 |
| solar-on-roof (not roofing) |      197,844 |     198,858 |

2,926 permits changed class; 2,399 stopped being roofing permits and 4 became one.

### Permits by jurisdiction (`permit_enriched`, one row per permit)

| Jurisdiction                                                      |       Permits |    Roofing | of which reroof | Open roofing | Open 2+ years | Open 5+ years |
| ----------------------------------------------------------------- | ------------: | ---------: | --------------: | -----------: | ------------: | ------------: |
| City of San Diego                                                 |     1,267,442 |      6,188 |           5,211 |          248 |           126 |            96 |
| County, unincorporated                                            |       448,808 |     18,560 |          17,992 |          643 |           184 |           155 |
| City of Carlsbad (applied 2022 to 2023, status as of 14 Jan 2024) |         9,877 |        456 |             413 |          279 |             4 |             0 |
| **Total**                                                         | **1,726,127** | **25,204** |      **23,616** |    **1,170** |       **314** |       **251** |

Open roofing permits were 1,471 before run 7. Of the 1,170 that remain, 1,069 are reroofs, 74 roof repairs
and 27 roof-structure permits. 61 still contain the letters "solar" or "PV": they are full reroofs done
ahead of a solar installation, or county reroof forms naming the "Landmark Solaris" shingle.

The longest-open roofing permits are now all county reroofs from 1990 to 1992 that the county's record
still shows as "Issued". That is what the source says; whether the work was done and never finalled cannot
be told from the data.

### Run 7 deltas

Ownership 1,084,871 updated (the transfer grading). City permits 7,803 updated, county permits 650,
Carlsbad 66 (classification). No inserts. Parcels, status history, contractors, businesses and licences
unchanged. Wall time 7 min 11 s. After the run, the alias rule was extended to the county pairs and the
derived tables were rebuilt in place with `scripts/rebuild-derived.ts`; that does not create a run.

Roof age after run 7: 15,394 parcels on a completed reroof permit, 761,493 medium, 249,432 low, 61,143 none.

### Open issues added

- "Solar job" versus "reroof" rests on the word FULL. A reroof done with solar but not described as full is
  classed with the solar job, which will miss some real reroofs.
- Unrecognised approval types are refused. A new building-work type the city introduces would be missed
  until the list in `src/roofing.ts` is extended.
- The two resolved transfer-date rules are inference, not record. Each row carries the rule so a consumer
  can use certain dates only.

## Update: runs 4 to 6 (25 November 2026, superseded where run 7 differs)

This section is current. The sections after it describe the database as it stood after run 3 and are kept
for the record; where a number differs, this section wins.

### What changed

1. **Carlsbad permits added** (`carlsbad_permits`). Of the eleven largest cities after San Diego, Carlsbad is
   the only one with a public permit feed. `SOURCES.md` lists what each city has.
2. **A permit with a coordinate outside the county is kept.** The coordinate is nulled and the discarded
   value is recorded in `permit.coord_note`. This recovered 2,105 permits (2,073 county, 32 city) that were
   rejected before; 846 of them still land on the map through their parcel.
3. **Roofing class is decided by approval type first.** Agreements, encroachment and right-of-way approvals,
   and construction-change or deferred-submittal records are never roofing work. The rule: such a record
   describes a project or revises another permit, so its roof text belongs to the parent permit, which is
   already in the data. 1,576 permits changed class; 1,070 stopped being roofing permits (961 of them were
   roof-structure mentions on revision records).
4. **A partial reroof is a repair, not a reroof.** "Picture frame" and "under array" reroofs done for solar
   no longer reset roof age.
5. **Status groups mean one thing each.** A new group, `pending`, holds everything applied for but not
   issued. `is_open` is true only for an issued permit that is not finalled. 141,190 permits changed group:
   139,423 from `other` to `pending`, and 1,767 county permits from `open` to `pending` (county "Open" and
   "PC About to Expire" are applications, not issued permits). The full status table is in `SOURCES.md`.
6. **Raw files are reused only to resume an interrupted fetch.** Before, a second run on the same day could
   silently reuse the first run's download.

### Permits by jurisdiction (after run 6)

| Jurisdiction                                 |       Permits | Roofing permits | of which reroof | Open roofing permits | Open 2 years or more | Pending roofing |
| -------------------------------------------- | ------------: | --------------: | --------------: | -------------------: | -------------------: | --------------: |
| City of San Diego                            |     1,272,442 |           7,885 |           5,714 |                  371 |                  180 |             621 |
| County, unincorporated                       |       474,565 |          21,365 |          20,285 |                  772 |                  310 |              50 |
| City of Carlsbad (applied 2022 to 2023 only) |         9,877 |             522 |             421 |                  328 |                    4 |               8 |
| **Total**                                    | **1,756,884** |      **29,772** |      **26,420** |            **1,471** |              **494** |         **679** |

Open five years or more: 403. The open counts fell from the run 3 figures (2,135 open, 1,237 at five years)
because construction-change records and county applications are no longer counted as open roofing permits.

**Carlsbad's open permits are open as of 14 January 2024,** the date its snapshot was last edited. Some will
have been finalled since. `permit.status_as_of` carries that date and `days_open` is measured up to it, which
is why only 4 show as open for two years.

Carlsbad publishes no APN. 8,709 of its 9,877 permits (88%) are tied to a parcel because their address
equals exactly one Carlsbad situs address; the same rule linked 9,106 city and 626 county permits that
arrived without an APN. 147 Carlsbad parcels now take their roof year from a completed reroof permit.

### Table counts (after run 6)

`permit` 1,756,884; `permit_contractor` 430,559; `permit_apn_link` 18,441 (new); `rejects` 6,705 (a per-run
log: 1,142 rows per full read now, down from 3,247); `pipeline_run` 6; `run_source_stats` 51; `source` 9.
`property`, `ownership`, `permit_status_history`, `permit_contractor_record`, `cslb_license`, `contractor`
and `business` are unchanged from the table below. Roof age: 15,670 parcels on a permit basis, 761,230
medium, 249,421 low, 61,141 none.

### Run history, continued

| Run | What it was                                                               | Deltas                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Full re-read, Carlsbad added, coordinate change                           | Carlsbad 9,877 inserted. County permits 2,073 inserted, 314 updated. City permits 32 inserted, 22 updated. Everything else unchanged.                                                                             |
| 5   | Fresh download of the three county sources                                | 0 inserted, 0 updated. Run 4 had reused county files downloaded earlier that day; this confirmed nothing had been missed.                                                                                         |
| 6   | Full re-read with the type and status rules; city file freshly downloaded | City permits 143,422 updated, county 1,805, Carlsbad 400. No inserts. Almost all are the status regrouping and the 1,576 class changes; the city figure also includes rows the city changed in its daily refresh. |

Wall time: 2 min 41 s, 3 min 55 s, 6 min 47 s. Summaries are in `docs/run-logs/2026-11-25-runs-4-to-6.txt`.

### New or changed columns

- `permit.coord_note`, `permit.status_as_of` (new). They enter the row hash only when set, so adding them
  did not make every existing row look updated.
- `permit.status_group` gains the value `pending`.
- `permit_enriched`: `apn` is now the source APN or, failing that, the address-matched one, with `apn_basis`
  saying which; new `days_pending` and `open_as_of`; `open_since` and `days_open` are null for pending rows.

### Open issues added

- Ten of the eleven target cities have no public permit feed. Closing that gap needs public-records requests
  or agreements, not engineering.
- Carlsbad's feed is two years stale and frozen.
- Electrical, mechanical and plumbing permits filed under a project titled as a reroof are still classed by
  that title (several hundred city rows). They indicate a roofing project but are not the roofing permit.
- Two city parcel layers expose owner names and mailing addresses publicly (see `SOURCES.md`). Not loaded;
  needs a decision.

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

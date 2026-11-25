# Sources

Every source below was fetched for real on 25 November 2026 (UTC).
Speeds are what the loader measured on its first full pull (`docs/run-logs/2026-11-25-first-full-load.txt`);
they are one sample, not a benchmark. No source needed a login, an API key or payment.

## Loaded

| Source id                     | What it is                                                 | Where                                                                                                                                | Rows at source |        Size | Fetch time |     Speed |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------: | ----------: | ---------: | --------: |
| `sandag_parcels`              | Every assessor parcel in the county, with centroid         | [SANDAG ArcGIS feature service](https://geo.sandag.org/server/rest/services/Hosted/Parcels/FeatureServer/0)                          |      1,088,570 | 755 MB JSON |       26 s | 29.4 MB/s |
| `sdcounty_permits`            | Building permits, unincorporated county, 1987 to date      | [Socrata `red2-qccu`](https://data.sandiegocounty.gov/d/red2-qccu)                                                                   |        475,198 | 478 MB JSON |      112 s |  4.3 MB/s |
| `sdcounty_permit_status`      | Status history for those permits                           | [Socrata `beua-23q8`](https://data.sandiegocounty.gov/d/beua-23q8)                                                                   |      1,128,036 | 177 MB JSON |       70 s |  2.5 MB/s |
| `sdcounty_permit_contractors` | Contractor on each county permit, with CSLB licence number | [Socrata `4ju2-mf55`](https://data.sandiegocounty.gov/d/4ju2-mf55)                                                                   |        310,350 | 135 MB JSON |       15 s |  9.2 MB/s |
| `sdcity_permits`              | City of San Diego development approvals, active and closed | [data.sandiego.gov](https://data.sandiego.gov/datasets/development-permits-set2/)                                                    |      1,272,476 |  680 MB CSV |       67 s | 10.1 MB/s |
| `sdcity_businesses`           | City of San Diego active business tax certificates         | [data.sandiego.gov](https://data.sandiego.gov/datasets/business-listings/)                                                           |         60,265 |   19 MB CSV |        2 s |  8.2 MB/s |
| `cslb_license_master`         | California contractor licences, statewide                  | [CSLB data portal](https://www.cslb.ca.gov/onlineservices/dataportal/ContractorList.aspx)                                            |        246,104 |   78 MB CSV |      298 s | 0.26 MB/s |
| `carlsbad_permits`            | City of Carlsbad building permits, applied 2022 to 2023    | [Carlsbad ArcGIS feature service](https://services.arcgis.com/ay9ePoQ2UfAX3U38/arcgis/rest/services/BuildingPermits/FeatureServer/0) |          9,886 |   6 MB JSON |        1 s |  4.6 MB/s |

The whole first load, fetch plus validation plus merge for the first seven, took 12 minutes 29 seconds.
The one slow source is CSLB, which accounts for five of those minutes.

## Licence, limits and how change is detected

### `sandag_parcels`

- **Licence / terms.** Public ArcGIS feature service, no login. The layer's attribution reads "SanGIS using
  legal recorded data provided by the County Recorders and Assessor's Office".
- **Limits.** 2,000 records per query. The loader asks for fixed `objectid` ranges, four requests in flight,
  545 requests in all. No throttling was seen at that rate.
- **Change detection.** There is no per-row change date. The layer's `editingInfo.lastEditDate` is the change
  token: if it has not moved since the last load the source is skipped, otherwise the whole layer is
  re-read and row hashes find what changed.
- **What is missing.** Owner name and owner mailing address are not in this layer, nor in any other public
  layer checked (see "Checked and not usable"). Years are two digits ("48"), and the last-document date is
  `MMDDYY`.
- **Coordinates.** The service returns each parcel's centroid in WGS84 on request, so no local reprojection.

### `sdcounty_permits`, `sdcounty_permit_status`, `sdcounty_permit_contractors`

- **Licence / terms.** County of San Diego open data portal. The datasets declare no licence in their
  metadata; they are published for public use without login.
- **Limits.** Socrata paging (`$limit`/`$offset`); the loader uses 50,000-row pages, one at a time, with no
  app token. Anonymous clients share a throttled pool; no 429 was seen.
- **Change detection.** Server-side window on `last_updated` (permits, contractors) and `status_date` (status
  history). This is what `--window` drives.
- **Coverage.** Unincorporated county only. The 18 incorporated cities issue their own permits.
- **Quirks.** 632 `record_id` values appear twice in the source (the loader keeps one). The permit dataset has
  no close date, so completion dates come from the status history. The contractor dataset's company column
  really is spelled `constractor_company_name`.

### `sdcity_permits`

- **Licence / terms.** City of San Diego Open Data Portal; the dataset page links the Open Data Commons
  Public Domain Dedication and Licence (PDDL).
- **Limits.** Two whole files (270 MB active, 410 MB closed), refreshed daily. No row-level feed. The
  "set 1 / set 2" file names in older documentation now return HTTP 301; the `approvals_*` files replace them.
- **Change detection.** The HTTP `ETag` is the change token; row hashes find the changed rows.
- **Coverage.** City of San Diego only. No contractor licence number, only a free-text permit holder.

### `sdcity_businesses`

- **Licence / terms.** As above (PDDL).
- **Limits.** One 19 MB file, daily. Active certificates only; the five inactive files were not loaded.
- **Change detection.** `ETag`.

### `cslb_license_master`

- **Licence / terms.** Public record published by the Contractors State License Board. Email addresses are
  withheld by the Board (Business and Professions Code section 27).
- **Limits.** Slow: 0.26 MB/s, about five minutes for 78 MB. The portal's form postback is refused for
  scripts by its firewall (HTTP 503 "The requested URL was rejected"); the download handler the form links
  to answers a plain GET, and that is what the loader uses. Only renewed or renewable licences are listed,
  so cancelled and revoked licences are absent.
- **Change detection.** The handler sends no `ETag`, so the file is downloaded once per run date and row
  hashes find the changes.

## Checked and not usable

| Lead                                                                                            | What happened                                                                                                                                                                                                                                                                                                                                                                                    | Consequence                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BBB ratings** (bbb.org)                                                                       | No bulk file or public API. `robots.txt` allows profile and category pages but disallows every URL with a query string, which rules out search and result paging. More decisively, the [Terms of Use](https://www.bbb.org/terms-of-use) state BBB content may be used and copied only "for your personal, non-commercial use" without written consent. A roofing-lead product is commercial use. | No BBB data was collected. `contractor.bbb_rating`, `bbb_url` and `bbb_checked_at` exist and are null; `bbb_note` on every row says why. Getting ratings lawfully needs BBB's written consent or a licensed data feed. |
| **Owner name and mailing address**                                                              | Not present in the SANDAG `Parcels`, `Parcels_North/South/East` or `Parcel_Historical` layers, nor in the County's `parcels_all_for_public_use` or `ISRP_PARCELS` layers. Two City of San Diego parcel services answer "Token Required".                                                                                                                                                         | `ownership.owner_name` and the `mail_*` columns are null with a note. "Out-of-area owner" is approximated as "not flagged owner-occupied".                                                                             |
| **SanGIS bulk parcel download**                                                                 | Needs a free SanGIS account. No account was created.                                                                                                                                                                                                                                                                                                                                             | Not used; the SANDAG service gives the same parcels without login.                                                                                                                                                     |
| **County public parcel layer** (`gis-public.sandiegocounty.gov/.../parcels_all_for_public_use`) | Works (1,088,311 parcels) but has only APN and situs address, 1,000 records per query, and no centroid option.                                                                                                                                                                                                                                                                                   | Kept as a documented fallback, not loaded.                                                                                                                                                                             |
| **CSLB "by classification and county" list**                                                    | Same firewall refusal on the form postback as the master list.                                                                                                                                                                                                                                                                                                                                   | Not needed: the master file carries classification and county for every licence.                                                                                                                                       |
| **Other cities' permits**                                                                       | Investigated on 25 November 2026; see "City permit feeds" below. Only Carlsbad publishes one.                                                                                                                                                                                                                                                                                                    | Permit coverage is the City of San Diego, the unincorporated county and Carlsbad (2022 to 2023 only).                                                                                                                  |

## City permit feeds

The eleven largest cities after San Diego were checked for a lawful, public, bulk or API permit feed:
ArcGIS Online and ArcGIS Hub search, each city's own ArcGIS server and public ArcGIS organisation (every
service name listed and screened), and Socrata and CKAN endpoints on the obvious `data.<city>` hosts.
Interactive permit-search portals were not opened, queried or scraped, so whether a portal offers its own
export was not checked.

| City (parcels)       | Feed? | What was seen                                                                                                                                                                                           |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Carlsbad (87,924)    | Yes   | `carlsbad_permits`: public feature service "Building Permits", 9,886 permits. Loaded. Limits below.                                                                                                     |
| Chula Vista (71,738) | No    | The city's ArcGIS server (`gisweb.chulavistaca.gov`) has an `accela` folder that answers "Token Required". Its public ArcGIS organisation has 77 services, none a permit layer.                         |
| Oceanside (64,079)   | No    | `gis.oceansideca.org` has 131 services. The two `TrakIT_GIS` services hold only base layers for the permitting system (addresses, parcels, streets), no permits.                                        |
| Escondido (38,869)   | No    | Most folders on `gis.escondido.gov` answer "Token Required". The public organisation has 144 services: development-activity and code-compliance layers, no building permits.                            |
| San Marcos (28,473)  | No    | `maps.san-marcos.net` has a public `Clariti` service with site addresses and parcels only; its `OpenGov` folder answers "Token Required".                                                               |
| Vista (25,011)       | No    | `gis.vista.gov` has 79 services, none permit-related.                                                                                                                                                   |
| Encinitas (23,790)   | No    | `Unsecured/Plan_Permitting` holds 16,666 planning and engineering records (for example sewer permits), last edited in 2022, not building permits. The "Enterprise Permitting Data" service answers 403. |
| El Cajon (23,300)    | No    | The public organisation has an `EnerGov` service with base layers only (addresses, parcels, zoning), no permits.                                                                                        |
| Santee (19,976)      | No    | 22 public services; the nearest is "Active Projects".                                                                                                                                                   |
| La Mesa (17,393)     | No    | 38 public services; the nearest is "Active Development Projects".                                                                                                                                       |
| Poway (16,605)       | No    | `powaygis.poway.org` has 46 services, none permit-related.                                                                                                                                              |

No Socrata or CKAN portal answered for any of these cities. National City, Imperial Beach, Coronado,
Del Mar, Solana Beach and Lemon Grove were searched on ArcGIS Online only, with no permit layer found.
For the ten cities without a feed, permit data would need a public-records request or an agreement with
the city; it is a constrained source, not a slow one.

### `carlsbad_permits`

- **Where.** `https://services.arcgis.com/ay9ePoQ2UfAX3U38/arcgis/rest/services/BuildingPermits/FeatureServer/0`
- **Licence / terms.** Public feature service owned by the City of Carlsbad GIS, tagged "open data" and
  "data snapshot", no login. The item declares no licence text.
- **Limits.** A frozen snapshot: 9,886 permits applied between 1 January 2022 and 29 December 2023, last
  edited 14 January 2024. Nothing before 2022 and nothing since. Statuses are as of the snapshot, so a permit
  shown as "Issued - Active" may have been finalled in the two years since; `permit.status_as_of` carries
  the snapshot date on every row. 2,000 records per query; five requests in all.
- **What is missing.** No APN, no contractor, no valuation. Permits are tied to a parcel only when the
  street address equals exactly one parcel's situs address in Carlsbad (`permit_apn_link`).
- **Change detection.** The layer's `lastEditDate`; unchanged means skipped.

### A related finding, not loaded: owner names on two city parcel layers

Two of the services above publish assessor owner name and mailing address fields without login:
Oceanside `TrakIT_GIS/TrakIT_geotype` layer 3 (99,758 parcels) and El Cajon `EnerGov` layer 2 (23,025
parcels). They would fill the ownership gap for those two cities. They were **not** loaded: they are
outside this task, they are personal data about homeowners, and they look like base layers for permitting
software rather than a deliberate open-data release. Using them needs a decision first.

## Permit status values and how they are grouped

Every distinct status in the loaded data (run 6), with the group the loader gives it. The groups mean the
same thing in every source:

- **open**: issued, work not finalled. The only group with `is_open = true`. `open_since` and `days_open`
  are set.
- **pending**: applied for but not issued (created, opened, in review, awaiting payment, plan check).
  `is_open` is false, `open_since` and `days_open` are null, and `days_pending` counts from the
  application date.
- **completed**: finalled or closed. **expired**: lapsed without a final. **cancelled**: cancelled,
  withdrawn, denied, void or revoked. For these three, `days_open` runs from issue to close when both
  dates exist.
- **other**: the source gave no status.

Durations for open and pending permits run to today, except for a frozen snapshot (Carlsbad), where they
run to the snapshot date; `permit_enriched.open_as_of` says which.

Two mappings are judgement calls and are stated here so they can be challenged. County "Open" is treated
as pending because only 3 of 1,450 such records have an issue date. City "Opened" is treated as pending
because only 13 of 22,249 have one.

| Jurisdiction            | Source status                 | Group     | `is_open` | Permits | Roofing permits |
| ----------------------- | ----------------------------- | --------- | --------- | ------: | --------------: |
| City of Carlsbad        | Issued - Active               | open      | yes       |   5,287 |             328 |
| City of Carlsbad        | Closed - Finaled              | completed | no        |   3,852 |             176 |
| City of Carlsbad        | Under Review - Active         | pending   | no        |     235 |               3 |
| City of Carlsbad        | Closed - Withdrawn            | cancelled | no        |     159 |               4 |
| City of Carlsbad        | Approved - Ready to Issue     | pending   | no        |     100 |               3 |
| City of Carlsbad        | Closed - Expired              | expired   | no        |      72 |               0 |
| City of Carlsbad        | Pending - Incomplete          | pending   | no        |      58 |               2 |
| City of Carlsbad        | Closed - Error                | cancelled | no        |      48 |               3 |
| City of Carlsbad        | Closed - Denied               | cancelled | no        |      43 |               2 |
| City of Carlsbad        | Closed - Revoked              | cancelled | no        |      16 |               1 |
| City of Carlsbad        | Pending                       | pending   | no        |       6 |               0 |
| City of Carlsbad        | Submitted Online              | pending   | no        |       1 |               0 |
| City of San Diego       | Completed                     | completed | no        | 439,975 |           5,270 |
| City of San Diego       | Issued                        | open      | yes       | 306,604 |             292 |
| City of San Diego       | Cancelled                     | cancelled | no        | 180,553 |           1,108 |
| City of San Diego       | Closed                        | completed | no        | 174,069 |             439 |
| City of San Diego       | Created                       | pending   | no        |  98,613 |             469 |
| City of San Diego       | Opened                        | pending   | no        |  22,249 |             116 |
| City of San Diego       | Inspection Followup           | open      | yes       |  15,769 |              79 |
| City of San Diego       | Cancelled Application Expired | cancelled | no        |  10,309 |              53 |
| City of San Diego       | Pending Invoice Payment       | pending   | no        |   7,868 |              25 |
| City of San Diego       | Approved Upon Final Payment   | pending   | no        |   6,994 |              10 |
| City of San Diego       | Final Closed                  | completed | no        |   2,897 |              10 |
| City of San Diego       | Cancelled Utilization Not Met | cancelled | no        |   1,931 |               8 |
| City of San Diego       | Open                          | pending   | no        |   1,335 |               1 |
| City of San Diego       | Withdrawn                     | cancelled | no        |     838 |               0 |
| City of San Diego       | Recheck Required              | pending   | no        |     724 |               0 |
| City of San Diego       | Invoice Paid                  | pending   | no        |     616 |               0 |
| City of San Diego       | (no status)                   | other     | no        |     199 |               4 |
| City of San Diego       | All Fees Paid                 | pending   | no        |     189 |               0 |
| City of San Diego       | Inspecting                    | open      | yes       |     170 |               0 |
| City of San Diego       | Application Pending Payment   | pending   | no        |     154 |               0 |
| City of San Diego       | Agreement Processing          | pending   | no        |     111 |               0 |
| City of San Diego       | In Review                     | pending   | no        |      78 |               0 |
| City of San Diego       | Finaled                       | completed | no        |      52 |               1 |
| City of San Diego       | Expired                       | expired   | no        |      26 |               0 |
| City of San Diego       | Canceled                      | cancelled | no        |      24 |               0 |
| City of San Diego       | Resubmitted                   | pending   | no        |      22 |               0 |
| City of San Diego       | Hearing Scheduled             | pending   | no        |      17 |               0 |
| City of San Diego       | Review Phase Complete         | pending   | no        |      14 |               0 |
| City of San Diego       | Updates Required              | pending   | no        |      10 |               0 |
| City of San Diego       | Revisions Required            | pending   | no        |       9 |               0 |
| City of San Diego       | In Queue                      | pending   | no        |       8 |               0 |
| City of San Diego       | Ready for Issuance            | pending   | no        |       3 |               0 |
| City of San Diego       | Application Expired           | expired   | no        |       3 |               0 |
| City of San Diego       | In Progress                   | pending   | no        |       2 |               0 |
| City of San Diego       | Pre-Screen                    | pending   | no        |       2 |               0 |
| City of San Diego       | Reviews Complete              | pending   | no        |       1 |               0 |
| City of San Diego       | Final Version Signed Off      | pending   | no        |       1 |               0 |
| City of San Diego       | Issuance Checklist Submitted  | pending   | no        |       1 |               0 |
| City of San Diego       | Started                       | pending   | no        |       1 |               0 |
| City of San Diego       | Issuance Pending              | pending   | no        |       1 |               0 |
| County (unincorporated) | Completed                     | completed | no        | 378,283 |          16,955 |
| County (unincorporated) | Issued Invalid Expired        | expired   | no        |  27,908 |           1,099 |
| County (unincorporated) | PC Expired                    | expired   | no        |  19,773 |             682 |
| County (unincorporated) | Issued Expired                | expired   | no        |  17,110 |             601 |
| County (unincorporated) | Issued                        | open      | yes       |  11,661 |             728 |
| County (unincorporated) | Expired                       | expired   | no        |  10,748 |           1,046 |
| County (unincorporated) | PC Invalid Expired            | expired   | no        |   6,385 |             160 |
| County (unincorporated) | Open                          | pending   | no        |   1,450 |              44 |
| County (unincorporated) | Issued About to Expire        | open      | yes       |     870 |              39 |
| County (unincorporated) | PC About to Expire            | pending   | no        |     317 |               6 |
| County (unincorporated) | Issued in Plan Change         | open      | yes       |      60 |               5 |

## Estimated time for a full pull

Measured on 25 November 2026, not estimated:

| Run                                            | What it did                                                                                                              |   Wall time |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------: |
| Cold full pull                                 | Downloaded and loaded all seven sources                                                                                  | 12 min 29 s |
| Windowed incremental (`--window 2026-11-10..`) | County sources filtered server-side; parcel, city and business sources skipped as "not modified"; CSLB re-read from disk |        17 s |
| Forced full re-read (`--force`)                | Re-validated and re-merged about 2.7 million source records from the raw files already on disk                           |   2 min 8 s |

Nothing was truncated, so there is no remaining volume to estimate for these sources.

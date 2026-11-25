# Sources

Every source below was fetched for real on 25 November 2026 (UTC).
Speeds are what the loader measured on its first full pull (`docs/run-logs/2026-11-25-first-full-load.txt`);
they are one sample, not a benchmark. No source needed a login, an API key or payment.

## Loaded

| Source id                     | What it is                                                 | Where                                                                                                       | Rows at source |        Size | Fetch time |     Speed |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------: | ----------: | ---------: | --------: |
| `sandag_parcels`              | Every assessor parcel in the county, with centroid         | [SANDAG ArcGIS feature service](https://geo.sandag.org/server/rest/services/Hosted/Parcels/FeatureServer/0) |      1,088,570 | 755 MB JSON |       26 s | 29.4 MB/s |
| `sdcounty_permits`            | Building permits, unincorporated county, 1987 to date      | [Socrata `red2-qccu`](https://data.sandiegocounty.gov/d/red2-qccu)                                          |        475,198 | 478 MB JSON |      112 s |  4.3 MB/s |
| `sdcounty_permit_status`      | Status history for those permits                           | [Socrata `beua-23q8`](https://data.sandiegocounty.gov/d/beua-23q8)                                          |      1,128,036 | 177 MB JSON |       70 s |  2.5 MB/s |
| `sdcounty_permit_contractors` | Contractor on each county permit, with CSLB licence number | [Socrata `4ju2-mf55`](https://data.sandiegocounty.gov/d/4ju2-mf55)                                          |        310,350 | 135 MB JSON |       15 s |  9.2 MB/s |
| `sdcity_permits`              | City of San Diego development approvals, active and closed | [data.sandiego.gov](https://data.sandiego.gov/datasets/development-permits-set2/)                           |      1,272,476 |  680 MB CSV |       67 s | 10.1 MB/s |
| `sdcity_businesses`           | City of San Diego active business tax certificates         | [data.sandiego.gov](https://data.sandiego.gov/datasets/business-listings/)                                  |         60,265 |   19 MB CSV |        2 s |  8.2 MB/s |
| `cslb_license_master`         | California contractor licences, statewide                  | [CSLB data portal](https://www.cslb.ca.gov/onlineservices/dataportal/ContractorList.aspx)                   |        246,104 |   78 MB CSV |      298 s | 0.26 MB/s |

The whole first load, fetch plus validation plus merge for all seven, took 12 minutes 29 seconds.
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
| **Other cities' permits** (Chula Vista, Oceanside, Escondido, Carlsbad and 13 more)             | Not investigated in this slice.                                                                                                                                                                                                                                                                                                                                                                  | Permit coverage is the City of San Diego plus the unincorporated county. See `docs/SLICE1-NOTES.md`.                                                                                                                   |

## Estimated time for a full pull

Measured on 25 November 2026, not estimated:

| Run                                            | What it did                                                                                                              |   Wall time |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------: |
| Cold full pull                                 | Downloaded and loaded all seven sources                                                                                  | 12 min 29 s |
| Windowed incremental (`--window 2026-11-10..`) | County sources filtered server-side; parcel, city and business sources skipped as "not modified"; CSLB re-read from disk |        17 s |
| Forced full re-read (`--force`)                | Re-validated and re-merged about 2.7 million source records from the raw files already on disk                           |   2 min 8 s |

Nothing was truncated, so there is no remaining volume to estimate for these sources.

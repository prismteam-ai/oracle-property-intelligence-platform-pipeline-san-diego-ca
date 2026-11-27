# San Diego County through `elephant-cli`: a five-parcel slice

The main pipeline in this repository loads San Diego County in bulk and does not use the
Elephant county-onboarding route. This folder checks that route on a small real sample:
five parcels taken through `elephant-cli` from seed to hash, with a hand-written scripts
bundle and no model. Nothing was uploaded, no wallet or key was used, and no output file
was edited by hand.

**Result: 5 of 5 parcels validate against the live lexicon with 0 errors and hash.** Three
things had to be worked around first, listed under "What did not work as documented".

## What was run

Run on 26 Nov 2026, Windows 11, Node 24.13.1, Git Bash.

```bash
ELEPHANT_CLI="node /path/to/elephant-cli/bin/elephant-cli" bash elephant/san-diego/run.sh
```

`run.sh` does this for each row of [`seed.csv`](seed.csv), one parcel at a time:

```bash
elephant-cli transform --input-zip seed-input.zip --output-zip seed-bundle.zip      # 1 seed
elephant-cli prepare prepare-input.zip --output-zip prepared-site.zip               # 2 live fetch
elephant-cli transform --input-zip prepared-site.zip --scripts-zip scripts.zip \
  --output-zip transformed-data.zip                                                  # 3 scripts
elephant-cli validate transformed-data.zip --output-csv validate-errors.csv         # 4 validate
elephant-cli hash transformed-data.zip --output-zip hashed-data.zip \
  --output-csv hash-results.csv                                                      # 5 hash
```

- `seed-input.zip` holds one row of `seed.csv`. `prepare-input.zip` holds
  `property_seed.json` and `unnormalized_address.json` from step 1. `scripts.zip` is the
  [`scripts/`](scripts) folder. [`tools.py`](tools.py) builds and unpacks these ZIPs and
  copies bytes only.
- The seed `url` is the per-parcel query on the same layer the bulk adapter reads
  (`geo.sandag.org/.../Hosted/Parcels/FeatureServer/0/query`, `where=apn='<APN>'`,
  `outFields=*`, `f=json`), plus `returnCentroid=true` and `outSR=4326` so the polygon and
  centroid arrive as latitude and longitude. `prepare` fetched all five live; no response
  was fetched by other means.
- CLI: `elephant-xyz/elephant-cli` `main` at commit `0876091` (19 Nov 2026), built locally.
  It reports version 1.58.1, the same string as the npm package, which does not work (see
  below). Lexicon manifest: `https://lexicon.elephant.xyz/api/manifest`.
- After each parcel, [`coverage.cjs`](coverage.cjs) compares every non-blank source
  attribute with the files written.

## Result per parcel

| APN        | What it is                                                          | Validate errors | Seconds | Classes written                                                               |
| ---------- | ------------------------------------------------------------------- | --------------: | ------: | ----------------------------------------------------------------------------- |
| 4500440300 | Single-family home, San Diego; completed re-roof `PMT-3220549`      |               0 |    27.7 | property, address, parcel, lot, tax, structure, sales_history, deed, geometry |
| 1250702200 | Single-family home, Fallbrook; open re-roof `PDS2026-RESALT-005424` |               0 |    24.8 | same nine                                                                     |
| 3450726021 | Condominium unit, San Diego                                         |               0 |    18.9 | same, without lot                                                             |
| 1471950500 | Office building, Oceanside (use code 211)                           |               0 |    19.4 | same nine                                                                     |
| 6601203000 | Non-taxable parcel, Jacumba; no street address, use code 000        |               0 |    26.2 | same, without structure                                                       |

The permits named in the table come from this repository's database. They are why the
parcels were picked; they are not in the Elephant output (see the last section).

CIDs from `hash` (the property CID is the CID of the seed data group):

| APN        | Property CID (seed)                                             | County data group CID                                           |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| 4500440300 | `baguqeerahokgryhg2hm4lra5okapl2oqyhy3sdgwacesruxpswgf4ebfewwa` | `baguqeeral4fvlvi5emth5runnhhoo64hwjez4za7ikmwtcxtzbachm6ttxxq` |
| 1250702200 | `baguqeeraqbwysvxrs2adlklcfybkjzyl7fb4lxs7mmid5ab7gqlyotvyzuaa` | `baguqeerajojecacilrvaszz5jycg4b2ihkxxmprucvz5tegoxuljtimp6r5q` |
| 3450726021 | `baguqeera36u7kehodcoydqfsmk6uriictywbqiphy3zw2gx2sxxinrl23maq` | `baguqeera57bbnoeee7j7u3kbsf35s4a434wzkk2wfgjatg66m6msnysdeyiq` |
| 1471950500 | `baguqeerag3atgnre7vpu3ziuh4kj7zgderzbw5ifu5ywmtn3mgkdrdgdi3ra` | `baguqeeracldxl7wis6ip4sdwcjvc44zpaswikrb44dmkogwzkr3siqlijora` |
| 6601203000 | `baguqeerageosb3zhx6v5y2yud4jp7j6mfwy6r7ohksllot3hyw52cqcsnkma` | `baguqeeratt3fx25qvfc72qa6rcs7qhqws6jwahqpawm2jwyfzxcf6c7khubq` |

The chain was run twice. Parcel 4500440300 had the same two CIDs both times.

In [`output/`](output), per parcel: `source.json` (the record `prepare` fetched),
`data/*.json` (the transform output), `validate-errors.csv` (header only when there are no
errors), `hash-results.csv` and `coverage.json`. `timings.csv` and `run-info.txt` cover the
run.

## What did not work as documented

1. **The npm package `@elephant-xyz/cli` 1.58.1 fails at the first step.** It reads the
   schema list from `https://lexicon.elephant.xyz/json-schemas/schema-manifest.json`, which
   now returns a web page: `SyntaxError: Unexpected token '<', "<!doctype "... is not valid
JSON`. 1.58.1 is the newest version on npm. The `main` branch on GitHub reads
   `/api/manifest` and works.
2. **`npm i github:elephant-xyz/elephant-cli#main` fails on Windows**: its build script
   uses `mkdir -p` and `cp`, which `cmd.exe` rejects. A clone built with
   `npm ci --script-shell <path to bash.exe>` works. The CLI source was not changed.
3. **The first full run validated 4 of 5.** Parcel 6601203000 failed with
   `/relationships/property_has_address/from/build_status: must be one of: VacantLand,
Improved, UnderConstruction`, value `null`. The lexicon types `build_status` as string or
   null, but its list of allowed values has no null. The field is optional, so the
   transform now leaves it out when the status is unknown. The second run is the one in
   `output/`.

## What the source filled, and what it could not

Source: one feature of the SANDAG / SanGIS Parcels layer (assessor attributes and the
parcel polygon). Code tables in [`scripts/sd_common.js`](scripts/sd_common.js) are copied
from the layer's own metadata document.

| Lexicon class            | Filled from the source                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `property`               | `parcel_identifier` (APN), `property_legal_description_text`, `property_type` and `property_usage_type` (from the assessor use code), `livable_floor_area`, `number_of_units`, `subdivision`, `build_status`, `ownership_estate_type` (condominiums only) |
| `address`                | street number, direction, name, suffix, unit, city, municipality, ZIP and ZIP+4, county, and the parcel centroid as latitude and longitude                                                                                                                |
| `parcel`                 | `parcel_identifier`                                                                                                                                                                                                                                       |
| `lot`                    | `lot_area_sqft` (polygon area), `lot_size_acre`, `lot_type` (from the area). Not written for a condominium unit: its polygon and acreage are the whole project's                                                                                          |
| `tax`                    | assessed land, improvement and total values                                                                                                                                                                                                               |
| `structure`              | `primary_framing_material` only (first character of the assessor quality-class code)                                                                                                                                                                      |
| `sales_history` + `deed` | recorded document number and, for grant and quit-claim deeds, the deed type                                                                                                                                                                               |
| `geometry`               | the parcel polygon, linked from `parcel`                                                                                                                                                                                                                  |

Across the five parcels, 10 to 20 source attributes per parcel reached a lexicon field and
22 to 29 did not (`coverage.json` lists each with its value and reason). The ones that
matter:

- **Year built: not written.** The layer has only `year_effective`, two digits, and its
  metadata says "Do Not use the effective date to determine the age of the property". Both
  `property_structure_built_year` and `property_effective_built_year` are null.
- **Roof: nothing.** The layer has no roof attribute. The seven required `roof_*` fields of
  `structure` are null and the optional `roof_date` is not written.
- **Bedrooms, baths, garage stalls, pool: not written.** The lexicon has no count fields.
  Each room is a `layout` record, and `layout` requires non-null `is_finished` and
  `is_exterior`, which the assessor record does not state.
- **Owner: nothing.** The public layer has no owner name or mailing address, so no
  `person` or `company` record. The owner-occupied flag has no lexicon field.
- **Transfer date: null on all five.** `docdate` is `MMDDYY`. The transform fills it only
  when the year cannot be in this century; all five could be either. (The main pipeline
  resolves these with its own graded rules; that logic was not carried over.) No sale price
  exists in the source.
- **Tax year and tax amounts: null.** The layer gives current assessed values without a
  roll year and without a tax bill.
- **Fields with no lexicon home:** taxable / non-taxable status, tax rate area, level-pad
  area, view flag, addition area, the assessor's generalized zone code (so `zoning` is
  null), subdivision map number, and the raw use code itself. The published class schemas
  have no free-form field for these (`additionalProperties` is false and there is no
  `source_payload` property), so they are dropped from the Elephant output and kept only in
  `source.json`.
- **Judgment calls.** `property_type` is required and has no "unknown" value. For use code
  000 (parcel 6601203000) the transform writes `LandParcel`, with `property_usage_type`
  `Unknown`. For non-residential codes it writes `Building` when the assessor carries an
  improvement value. `state_code` `CA` and `country_code` `US` are constants of the source,
  not attributes of the record. The use-code table covers 55 of the 225 codes the metadata
  lists; any other code falls back to `Building` or `LandParcel` with usage from its
  hundred-block or null.
- The CLI also writes three relationship files per parcel that no data-group root
  references (`relationship_property_parcel`, `_deed_1`, `_geometry_parcel_1`). `validate`
  accepted them.

## What this route gives and what it does not, for this county

Measured here:

- **It works for parcel records.** Five varied parcels produce lexicon-valid, hashed
  County and Seed data groups from the public layer with five small scripts.
- **One property per ZIP, one HTTP request per property.** Seed-mode `transform` reads only
  the first row of `seed.csv`, and `prepare` makes one request per parcel. The bulk adapter
  in `src/adapters/sandagParcels.ts` reads the same layer 2,000 records per request, so 544
  requests instead of 1,087,462.
- **Time.** Mean 23.4 s per parcel for the five steps on this laptop, one at a time
  (`output/timings.csv`: 18.9 to 27.7 s). Each step is a separate Node process taking 3 to 8
  s; `prepare` averaged 3.8 s, although a single `curl` of the same per-parcel query returned in 0.3 s, so
  most of the time is CLI start-up and schema loading, not the county server. At 23.4 s,
  1,087,462 parcels would take about 295 days on one sequential worker; at the `prepare`
  step alone, about 48 days. The first run, with a cold schema cache, took 49 s for the
  first parcel. The main README states about 7 minutes for the bulk load; that figure was
  not re-measured here. Parallel workers or a long-lived process would change these
  numbers; neither was tried.
- **No upload or on-chain step was run**, so nothing here shows that these CIDs resolve on
  IPFS or would be accepted by the contract.

Checked in the lexicon (class and data-group schemas fetched by the manifest's CIDs), not
run:

- **Permits have a home.** The `Property Improvement` data group links a
  `property_improvement` record to the parcel, with `improvement_type` (which includes
  `Roofing`), `improvement_status` (`Completed`, `InProgress`, `Permitted`, `Cancelled` and
  others), `permit_number`, and issue, close and completion dates. It has no field for the
  permit description or valuation.
- **Contractors only partly.** The contractor is a `company` record whose fields are `name`
  and `sunbiz_document_number` (a Florida registry number). There is no field for a
  California CSLB licence number, classification (C-39) or licence status, and none for a
  BBB rating.
- **Roof signals have fields but no source.** `structure` has `roof_date` and
  `roof_age_years`; the parcel layer cannot fill them. They would have to be derived from
  roofing permits, which is what the main pipeline does outside the lexicon.

So the story's questions would still need, on top of this route:

- **Radius search:** coordinates do land in the output (`address.latitude` / `longitude`,
  `geometry.polygon`), but as one small JSON document per property. A radius query needs
  them in one table with a distance function. CLI `main` has an `export-tables` command for
  the table step; it was not run here.
- **Roof age:** a permit transform into `property_improvement` for the three permit sources
  (City of San Diego, the unincorporated county, Carlsbad), then a derivation of the last
  completed roofing permit per parcel. None of the permit sources was put through
  `elephant-cli` here.
- **Open roofing permits with contractor standing:** the same permit transform, plus a
  place for the CSLB licence fields, which the lexicon does not have today.

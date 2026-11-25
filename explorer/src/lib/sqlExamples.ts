export interface SqlExample {
  id: string;
  label: string;
  sql: string;
  /** True for the example that is meant to be refused by the read-only guard. */
  forbidden?: boolean;
  /** True for the example that is meant to run into the 15-second time limit. */
  slow?: boolean;
}

const LAT = 32.7157;
const LON = -117.1611;

export const SQL_EXAMPLES: readonly SqlExample[] = [
  {
    id: 'aged-roofs',
    label: 'Roofs older than 15 years near a point',
    sql: `-- Parcels within 1 mile of downtown San Diego whose roof is older than 15 years, oldest first
SELECT address, city,
       year(current_date) - roof_year AS roof_age_years,
       roof_year, roof_basis, roof_confidence,
       round(lat, 5) AS lat, round(lon, 5) AS lon, apn
FROM parcel
WHERE lat BETWEEN ${LAT} - 1 / 69.0 AND ${LAT} + 1 / 69.0
  AND lon BETWEEN ${LON} - 1 / 58.0 AND ${LON} + 1 / 58.0
  AND 3958.7613 * 2 * asin(sqrt(
        pow(sin(radians(lat - ${LAT}) / 2), 2) +
        cos(radians(${LAT})) * cos(radians(lat)) * pow(sin(radians(lon - (${LON})) / 2), 2))) <= 1
  AND year(current_date) - roof_year > 15
  AND address IS NOT NULL
ORDER BY roof_age_years DESC, address
LIMIT 200`,
  },
  {
    id: 'long-open-permits',
    label: 'Long-open roofing permits with contractor',
    sql: `-- Open roofing permits, longest open first. The county feed lists some permits twice
-- under two ids, so this shows one row per address and open date.
SELECT min(permit_id) AS permit_id,
       address,
       any_value(jurisdiction) AS jurisdiction,
       any_value(status) AS status,
       open_since,
       date_diff('day', open_since, current_date) AS days_open,
       round(date_diff('day', open_since, current_date) / 365.25, 1) AS years_open,
       coalesce(max(coalesce(contractor_name, holder_name)), '(none listed)') AS contractor,
       coalesce(max(contractor_license_no), '(none listed)') AS licence_no,
       count(*) AS source_records
FROM permit
WHERE is_roofing AND is_open AND open_since IS NOT NULL AND address IS NOT NULL
GROUP BY address, open_since
ORDER BY days_open DESC, address
LIMIT 100`,
  },
  {
    id: 'owners-unchanged',
    label: 'Owners unchanged for more than 10 years',
    sql: `-- Parcels whose last recorded ownership document is more than 10 years old.
-- Dates whose century is uncertain are left out.
SELECT address, city, last_transfer_date,
       date_diff('year', last_transfer_date, current_date) AS years_held,
       CASE WHEN owner_occupied THEN 'yes' ELSE 'no' END AS owner_occupied_flag,
       apn
FROM parcel
WHERE last_transfer_date <= current_date - INTERVAL 10 YEAR
  AND NOT coalesce(last_transfer_ambiguous, false)
  AND address IS NOT NULL
ORDER BY last_transfer_date
LIMIT 200`,
  },
  {
    id: 'out-of-area',
    label: 'Out-of-area owners (with basis)',
    sql: `-- out_of_area is a proxy; out_of_area_basis says what it rests on
SELECT CASE WHEN out_of_area THEN 'out of area (proxy)' ELSE 'owner-occupied' END AS owner_group,
       count(*) AS parcels,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS percent_of_parcels,
       out_of_area_basis AS basis
FROM parcel
GROUP BY out_of_area, out_of_area_basis
ORDER BY parcels DESC`,
  },
  {
    id: 'top-contractors',
    label: 'Top roofing contractors by open permits',
    sql: `-- Contractors holding the most open roofing permits
SELECT coalesce(contractor_name, holder_name) AS contractor,
       coalesce(max(contractor_license_no), '(none listed)') AS licence_no,
       count(DISTINCT permit_id) AS open_roofing_permits,
       min(open_since) AS oldest_open_since
FROM permit
WHERE is_roofing AND is_open AND coalesce(contractor_name, holder_name) IS NOT NULL
GROUP BY 1
ORDER BY open_roofing_permits DESC, contractor
LIMIT 25`,
  },
  {
    id: 'forbidden',
    label: 'Try a forbidden statement (DELETE)',
    forbidden: true,
    sql: `DELETE FROM permit WHERE is_open`,
  },
  {
    id: 'timeout',
    label: 'Try a runaway query (stopped after 15 s)',
    slow: true,
    sql: `-- A three-way cross join of 1.09 million parcels: the server stops it after 15 seconds
SELECT count(*) FROM parcel a, parcel b, parcel c`,
  },
];

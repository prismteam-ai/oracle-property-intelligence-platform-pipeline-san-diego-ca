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
    sql: `-- Parcels within 1 mile of downtown San Diego whose roof is older than 15 years
SELECT apn, address, city, roof_year,
       year(current_date) - roof_year AS roof_age_years,
       roof_basis, roof_confidence, lat, lon, source_id, source_url
FROM parcel
WHERE lat BETWEEN ${LAT} - 1 / 69.0 AND ${LAT} + 1 / 69.0
  AND lon BETWEEN ${LON} - 1 / 58.0 AND ${LON} + 1 / 58.0
  AND 3958.7613 * 2 * asin(sqrt(
        pow(sin(radians(lat - ${LAT}) / 2), 2) +
        cos(radians(${LAT})) * cos(radians(lat)) * pow(sin(radians(lon - (${LON})) / 2), 2))) <= 1
  AND year(current_date) - roof_year > 15
ORDER BY roof_age_years DESC
LIMIT 200`,
  },
  {
    id: 'long-open-permits',
    label: 'Long-open roofing permits with contractor',
    sql: `-- Open roofing permits, longest open first, with contractor and licence
SELECT permit_id, address, status, open_since,
       round(date_diff('day', open_since, current_date) / 365.25, 1) AS years_open,
       coalesce(contractor_name, holder_name) AS contractor,
       contractor_license_no, contractor_license_status,
       bbb_rating, bbb_note, source_id, source_url
FROM permit
WHERE is_roofing AND is_open AND open_since IS NOT NULL
ORDER BY open_since
LIMIT 100`,
  },
  {
    id: 'owners-unchanged',
    label: 'Owners unchanged for more than 10 years',
    sql: `-- Parcels whose last recorded ownership document is more than 10 years old
SELECT apn, address, city, last_transfer_date,
       date_diff('year', last_transfer_date, current_date) AS years_held,
       owner_occupied
FROM parcel
WHERE last_transfer_date <= current_date - INTERVAL 10 YEAR
ORDER BY last_transfer_date
LIMIT 200`,
  },
  {
    id: 'out-of-area',
    label: 'Out-of-area owners (with basis)',
    sql: `-- out_of_area is a proxy; out_of_area_basis says what it rests on
SELECT out_of_area, out_of_area_basis, count(*) AS parcels
FROM parcel
GROUP BY out_of_area, out_of_area_basis
ORDER BY parcels DESC`,
  },
  {
    id: 'top-contractors',
    label: 'Top roofing contractors by open permits',
    sql: `-- Contractors holding the most open roofing permits
SELECT coalesce(contractor_name, holder_name) AS contractor,
       contractor_license_no, contractor_license_status,
       count(*) AS open_roofing_permits,
       min(open_since) AS oldest_open_since
FROM permit
WHERE is_roofing AND is_open AND coalesce(contractor_name, holder_name) IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY open_roofing_permits DESC
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

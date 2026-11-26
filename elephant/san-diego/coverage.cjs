// Field-inventory diff for one parcel: every non-blank attribute of the captured source
// record against the lexicon files the transform wrote.
//
//   node coverage.cjs <output/<apn>>      prints JSON to stdout
//
// status "mapped"     : a lexicon field written for this parcel carries the value
// status "not_filled" : the attribute has a lexicon home but the transform left it out for
//                       this parcel (the reason says why)
// status "gap"        : the lexicon has no field for it, or the source value cannot be
//                       turned into the lexicon's value without asserting something
'use strict';

const fs = require('fs');
const path = require('path');

const ADDRESS = 'address.json';
/** source attribute -> lexicon targets ([file, field]) and/or the reason it has no home. */
const FIELDS = {
  apn: {
    to: [
      ['property.json', 'parcel_identifier'],
      ['parcel.json', 'parcel_identifier'],
    ],
  },
  legldesc: { to: [['property.json', 'property_legal_description_text']] },
  nucleus_use_cd: {
    to: [
      ['property.json', 'property_type'],
      ['property.json', 'property_usage_type'],
    ],
    note: 'mapped through the code table in sd_common.js; the raw code itself has no lexicon field',
  },
  subname: { to: [['property.json', 'subdivision']] },
  total_lvg_area: {
    to: [['property.json', 'livable_floor_area']],
    unfilled: '0 or the 99999 cap means unknown',
  },
  unitqty: { to: [['property.json', 'number_of_units']], unfilled: '0 is not written' },
  asr_land: { to: [['tax_1.json', 'property_land_amount']] },
  asr_impr: { to: [['tax_1.json', 'property_building_amount']] },
  asr_total: { to: [['tax_1.json', 'property_assessed_value_amount']] },
  situs_address: { to: [[ADDRESS, 'street_number']], unfilled: '0 means no situs number' },
  situs_street: { to: [[ADDRESS, 'street_name']] },
  situs_suffix: {
    to: [[ADDRESS, 'street_suffix_type']],
    unfilled: 'suffix is not one of the lexicon street_suffix_type values',
  },
  situs_pre_dir: { to: [[ADDRESS, 'street_pre_directional_text']] },
  situs_post_dir: { to: [[ADDRESS, 'street_post_directional_text']] },
  situs_suite: { to: [[ADDRESS, 'unit_identifier']] },
  situs_community: { to: [[ADDRESS, 'city_name']] },
  situs_zip: { to: [[ADDRESS, 'postal_code']] },
  situs_juris: {
    to: [[ADDRESS, 'municipality_name']],
    unfilled: 'CN is the unincorporated county: no municipality',
  },
  acreage: {
    to: [['lot.json', 'lot_size_acre']],
    unfilled: 'for a sub-unit APN the acreage belongs to the whole underlying parcel',
  },
  SHAPE__Area: {
    to: [['lot.json', 'lot_area_sqft']],
    unfilled: 'for a sub-unit APN the polygon is the whole underlying parcel',
  },
  qual_class_shape: {
    to: [['structure.json', 'primary_framing_material']],
    unfilled: 'framing code has no lexicon value',
    note: 'only the first character (framing) maps; quality class and shape have no lexicon field',
  },
  docnmbr: { to: [['deed_1.json', 'instrument_number']] },
  doctype: {
    to: [['deed_1.json', 'deed_type']],
    unfilled: 'only codes 1 (grant deed) and 2 (quit claim) have an exact lexicon deed_type',
  },
  docdate: {
    to: [['sales_history_1.json', 'ownership_transfer_date']],
    unfilled: 'MMDDYY with a two-digit year that fits two centuries; left null',
  },
  year_effective: {
    gap: 'two-digit year; layer metadata: "Do Not use the effective date to determine the age of the property". Not written to property_structure_built_year or property_effective_built_year',
  },
  bedrooms: {
    gap: 'count only; lexicon needs one layout record per room with non-null is_finished / is_exterior',
  },
  baths: { gap: 'count only; same layout limitation as bedrooms' },
  garage_stalls: { gap: 'count only; same layout limitation' },
  carport_stalls: { gap: 'count only; same layout limitation' },
  pool: { gap: 'Y/N flag; a lexicon pool is a layout record with required fields the source lacks' },
  garage_conversion: { gap: 'no lexicon field' },
  addition_area: { gap: 'no lexicon field for added area' },
  par_view: { gap: 'Y/N flag; lexicon lot.view needs the kind of view' },
  usable_sq_feet: { gap: 'level pad area; no lexicon field' },
  taxstat: { gap: 'taxable / non-taxable flag; no field in the lexicon tax class' },
  ownerocc: { gap: 'owner-occupied flag; no lexicon field (and the layer has no owner to attach it to)' },
  fractint: { gap: 'fractional-interest code; no lexicon field' },
  tranum: { gap: 'tax rate area number; no lexicon field in the classes used' },
  submap: { gap: 'subdivision / parcel map number; no lexicon field' },
  nucleus_zone_cd: { gap: 'assessor generalized zone, not a zoning designation; property.zoning left null' },
  asr_zone: { gap: 'legacy copy of nucleus_zone_cd' },
  asr_landuse: { gap: 'legacy two-digit copy of nucleus_use_cd' },
  apn_8: { gap: 'first eight digits of the APN; derivable, no lexicon field' },
  overlay_juris: { gap: 'jurisdiction by map overlay; duplicates situs_juris' },
  situs_fraction: { gap: 'house-number fraction; no lexicon field' },
  situs_building: { gap: 'building identifier; no lexicon field' },
  nucleus_situs_from_nbr: { gap: 'address range start; duplicates situs_address' },
  nucleus_situs_thru_nbr: { gap: 'address range end; no lexicon field' },
  nucleus_situs_thru_fractn: { gap: 'address range fraction; no lexicon field' },
  x_coord: { gap: 'State Plane centroid; the WGS84 centroid is written instead' },
  y_coord: { gap: 'State Plane centroid; the WGS84 centroid is written instead' },
  SHAPE__Length: { gap: 'polygon perimeter; no lexicon field' },
  parcelid: { gap: 'SanGIS internal polygon id' },
  objectid: { gap: 'layer row id' },
  sub_type: { gap: 'SanGIS parcel sub-type code; no lexicon field' },
  multi: { gap: 'assessor mapping flag; no lexicon field' },
};

const dir = process.argv[2];
const source = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8'));
const dataDir = path.join(dir, 'data');
const written = {};
if (fs.existsSync(dataDir)) {
  for (const name of fs.readdirSync(dataDir)) {
    if (name.endsWith('.json')) {
      written[name] = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
    }
  }
}

const feature = source.features && source.features[0] ? source.features[0] : { attributes: {} };
const result = { mapped: {}, not_filled: {}, gap: {}, unlisted: {} };
for (const [name, raw] of Object.entries(feature.attributes).sort()) {
  const blank = raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (blank) continue;
  const value = typeof raw === 'string' ? raw.trim() : raw;
  const rule = FIELDS[name];
  if (rule === undefined) {
    result.unlisted[name] = { value };
  } else if (rule.to === undefined) {
    result.gap[name] = { value, reason: rule.gap };
  } else {
    const filled = rule.to
      .filter(([file, field]) => written[file] !== undefined && written[file][field] != null)
      .map(([file, field]) => `${file.replace('.json', '')}.${field}`);
    if (filled.length > 0) {
      result.mapped[name] = { value, to: filled, ...(rule.note ? { note: rule.note } : {}) };
    } else {
      result.not_filled[name] = { value, reason: rule.unfilled ?? 'transform wrote no value' };
    }
  }
}
const geometryFiles = Object.keys(written).filter((n) => n.startsWith('geometry_parcel_'));
result.geometry = {
  source_rings: (source.features || []).reduce(
    (count, f) => count + (f.geometry && f.geometry.rings ? f.geometry.rings.length : 0),
    0,
  ),
  geometry_records_written: geometryFiles.length,
  centroid_written_to_address: written[ADDRESS] !== undefined && written[ADDRESS].latitude != null,
};
result.counts = {
  mapped: Object.keys(result.mapped).length,
  not_filled: Object.keys(result.not_filled).length,
  gap: Object.keys(result.gap).length,
  unlisted: Object.keys(result.unlisted).length,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

// data_extractor.js: turns one SANDAG / SanGIS Parcels feature (the per-APN ArcGIS query
// response that `elephant-cli prepare` saved as input.json) into lexicon class files under
// data/. Runs after the four *Mapping.js scripts, with cwd = the CLI work folder.
//
// Rules this file keeps:
//   - a lexicon field is filled only from a source attribute that means the same thing;
//   - a required field the source cannot supply is written as null where the schema allows;
//   - nothing is derived from YEAR_EFFECTIVE: the layer metadata says it is a two-digit year
//     and "Do Not use the effective date to determine the age of the property";
//   - `source_http_request` and `request_identifier` are left to the CLI, which copies them
//     from the seed record onto every class file.
'use strict';

const path = require('path');
const {
  DEED_TYPES,
  JURISDICTIONS,
  mapDirection,
  mapSuffix,
  mapUseCode,
  readFeature,
  readJson,
  text,
  writeJson,
} = require('./sd_common.js');

const workDir = process.cwd();
const dataDir = path.join(workDir, 'data');
const out = (name, value) => {
  writeJson(path.join(dataDir, name), value);
};
const link = (name, from, to) => {
  out(name, { from: { '/': `./${from}` }, to: { '/': `./${to}` } });
};

const seed = readJson(path.join(workDir, 'property_seed.json'));
const seedAddress = readJson(path.join(workDir, 'unnormalized_address.json'));
const feature = readFeature(workDir);
if (feature === null) {
  throw new Error(`source returned no feature for parcel ${seed.parcel_id}`);
}
const a = feature.attributes;
const apn = text(a.apn);
if (apn === null || apn !== String(seed.parcel_id)) {
  throw new Error(`source APN ${apn} does not match the seed parcel ${seed.parcel_id}`);
}
const structureData = readJson(path.join(workDir, 'owners', 'structure_data.json'));

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const assessedLand = num(a.asr_land);
const assessedImprovements = num(a.asr_impr);
const assessedTotal = num(a.asr_total);
const livingArea = num(a.total_lvg_area);
const use = mapUseCode(a.nucleus_use_cd, assessedImprovements !== null && assessedImprovements > 0);
// APN = book-page-block-parcel-subunit; a non-zero subunit is a condo-style sub-id whose
// polygon and acreage belong to the whole underlying parcel, not to the unit.
const isSubUnit = apn.length === 10 && apn.slice(8) !== '00';

// ---- property -------------------------------------------------------------------------
const units = num(a.unitqty);
const UNIT_WORDS = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four' };
let buildStatus = null;
if (use.vacant) buildStatus = 'VacantLand';
else if ((assessedImprovements !== null && assessedImprovements > 0) || (livingArea ?? 0) > 0)
  buildStatus = 'Improved';

const property = {
  parcel_identifier: apn,
  property_legal_description_text: text(a.legldesc),
  property_type: use.property_type,
  property_usage_type: use.property_usage_type,
  ownership_estate_type: use.condo ? 'Condominium' : null,
  // TOTAL_LVG_AREA is capped at 99999 in the source, so that value is "unknown", not an area.
  livable_floor_area:
    livingArea !== null && livingArea >= 10 && livingArea < 99999 ? String(livingArea) : null,
  number_of_units: units !== null && units > 0 ? units : null,
  number_of_units_type: units !== null && UNIT_WORDS[units] !== undefined ? UNIT_WORDS[units] : null,
  subdivision: text(a.subname),
  property_structure_built_year: null,
  property_effective_built_year: null,
  structure_form: null,
  zoning: null,
};
// build_status is optional, and its enum has no null even though its type allows one: an
// unknown status has to be left out, a null fails validation.
if (buildStatus !== null) property.build_status = buildStatus;
out('property.json', property);

// ---- parcel ---------------------------------------------------------------------------
out('parcel.json', { parcel_identifier: apn });

// ---- address --------------------------------------------------------------------------
const streetNumber = num(a.situs_address);
const streetName = text(a.situs_street);
const zip = text(a.situs_zip);
const zipMatch = zip === null ? null : /^(\d{5})(?:-(\d{4}))?$/.exec(zip);
const community = text(a.situs_community);
const centroid = feature.wkid === 4326 && feature.centroid !== null ? feature.centroid : { x: null, y: null };
const jurisCode = text(a.situs_juris);
// The lexicon rejects a street_name that contains a bare direction word; such a record keeps
// the seed's unnormalized address instead of being forced into the structured shape.
const streetNameFits = streetName === null || !/\b(E|N|NE|NW|S|SE|SW|W)\b/.test(streetName);
if (streetNameFits) {
  out('address.json', {
    street_number: streetNumber !== null && streetNumber > 0 ? String(streetNumber) : null,
    street_pre_directional_text: mapDirection(a.situs_pre_dir),
    street_name: streetName,
    street_suffix_type: mapSuffix(a.situs_suffix),
    street_post_directional_text: mapDirection(a.situs_post_dir),
    unit_identifier: text(a.situs_suite),
    city_name: community !== null && /^[A-Z\s\-']+$/.test(community) ? community : null,
    municipality_name:
      jurisCode !== null && JURISDICTIONS[jurisCode] !== undefined ? JURISDICTIONS[jurisCode] : null,
    postal_code: zipMatch === null ? null : zipMatch[1],
    plus_four_postal_code: zipMatch === null || zipMatch[2] === undefined ? null : zipMatch[2],
    // The layer covers San Diego County, California only; these three are facts about the
    // source, not attributes of the record.
    state_code: 'CA',
    country_code: 'US',
    county_name: 'San Diego',
    latitude: centroid.y,
    longitude: centroid.x,
    route_number: null,
    township: null,
    range: null,
    section: null,
    block: null,
    lot: null,
  });
} else {
  out('address.json', {
    unnormalized_address: seedAddress.full_address,
    county_name: 'San Diego',
    latitude: centroid.y,
    longitude: centroid.x,
  });
}

// ---- lot ------------------------------------------------------------------------------
// SHAPE__Area is the polygon area in square feet (State Plane feet), which the metadata
// calls the "approximate parcel size". ACREAGE is the assessor's taxable acreage, blank
// under 0.5 acre. Neither describes a single unit of a condominium project.
const shapeArea = num(a.SHAPE__Area);
const acreage = num(a.acreage);
const lotArea = !isSubUnit && shapeArea !== null && shapeArea >= 1 ? Math.round(shapeArea) : null;
const lotAcre = !isSubUnit && acreage !== null && acreage > 0 ? acreage : null;
if (lotArea !== null || lotAcre !== null) {
  let lotType = null;
  if (lotArea !== null) {
    lotType = lotArea > 10890 ? 'GreaterThanOneQuarterAcre' : 'LessThanOrEqualToOneQuarterAcre';
  }
  out('lot.json', {
    lot_type: lotType,
    lot_area_sqft: lotArea,
    lot_size_acre: lotAcre,
    lot_length_feet: null,
    lot_width_feet: null,
    landscaping_features: null,
    view: null,
    fencing_type: null,
    fence_height: null,
    fence_length: null,
    driveway_material: null,
    driveway_condition: null,
    lot_condition_issues: null,
  });
}

// ---- tax (assessed values) --------------------------------------------------------------
// The layer gives the current assessed land, improvement and net total values but not the
// roll year they belong to, and no tax amount, so tax_year and the tax amounts stay null.
if (assessedLand !== null || assessedImprovements !== null || assessedTotal !== null) {
  const tax = {
    tax_year: null,
    property_land_amount: assessedLand,
    property_building_amount: assessedImprovements,
    monthly_tax_amount: null,
    yearly_tax_amount: null,
    period_start_date: null,
    period_end_date: null,
  };
  if (assessedTotal !== null) tax.property_assessed_value_amount = assessedTotal;
  out('tax_1.json', tax);
}

// ---- structure --------------------------------------------------------------------------
if (structureData.primary_framing_material !== null) {
  const structure = { primary_framing_material: structureData.primary_framing_material };
  for (const field of [
    'architectural_style_type',
    'attachment_type',
    'exterior_wall_material_primary',
    'exterior_wall_material_secondary',
    'exterior_wall_condition',
    'exterior_wall_insulation_type',
    'flooring_material_primary',
    'flooring_material_secondary',
    'subfloor_material',
    'flooring_condition',
    'interior_wall_structure_material',
    'interior_wall_surface_material_primary',
    'interior_wall_surface_material_secondary',
    'interior_wall_finish_primary',
    'interior_wall_finish_secondary',
    'interior_wall_condition',
    'roof_covering_material',
    'roof_underlayment_type',
    'roof_structure_material',
    'roof_design_type',
    'roof_condition',
    'roof_age_years',
    'gutters_material',
    'gutters_condition',
    'roof_material_type',
    'foundation_type',
    'foundation_material',
    'foundation_waterproofing',
    'foundation_condition',
    'ceiling_structure_material',
    'ceiling_surface_material',
    'ceiling_insulation_type',
    'ceiling_height_average',
    'ceiling_condition',
    'exterior_door_material',
    'interior_door_material',
    'window_frame_material',
    'window_glazing_type',
    'window_operation_type',
    'window_screen_material',
    'secondary_framing_material',
    'structural_damage_indicators',
  ]) {
    structure[field] = null;
  }
  out('structure.json', structure);
  // The CLI does not link structure files by itself; this name is the one it recognises.
  link('relationship_property_structure.json', 'property.json', 'structure.json');
}

// ---- recorded document (sales_history + deed) -------------------------------------------
// DOCDATE is MMDDYY. A two-digit year later than the current one cannot be 20YY and is read
// as 19YY; any other value fits two centuries and the date is left null.
const docDate = text(a.docdate);
const docNumber = text(a.docnmbr);
const docType = text(a.doctype);
let transferDate = null;
if (docDate !== null && /^\d{6}$/.test(docDate)) {
  const month = Number(docDate.slice(0, 2));
  const day = Number(docDate.slice(2, 4));
  const yy = Number(docDate.slice(4, 6));
  const currentYy = new Date().getUTCFullYear() % 100;
  if (yy > currentYy && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    const iso = `19${docDate.slice(4, 6)}-${docDate.slice(0, 2)}-${docDate.slice(2, 4)}`;
    if (!Number.isNaN(Date.parse(iso))) transferDate = iso;
  }
}
if (docNumber !== null || transferDate !== null) {
  out('sales_history_1.json', { ownership_transfer_date: transferDate });
  if (docNumber !== null) {
    const deed = { instrument_number: docNumber };
    if (docType !== null && DEED_TYPES[docType] !== undefined) deed.deed_type = DEED_TYPES[docType];
    out('deed_1.json', deed);
    link('relationship_sales_history_1_deed_1.json', 'sales_history_1.json', 'deed_1.json');
  }
}

// ---- geometry ---------------------------------------------------------------------------
// Only written when the response is in WGS84 (the seed asks for outSR=4326). The lexicon
// polygon is one closed ring, so each ring becomes its own geometry record.
if (feature.wkid === 4326) {
  let index = 0;
  for (const f of feature.features) {
    const rings = f.geometry && Array.isArray(f.geometry.rings) ? f.geometry.rings : [];
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      index += 1;
      const geometry = {
        polygon: ring.map((point) => ({ longitude: point[0], latitude: point[1] })),
      };
      if (index === 1 && centroid.x !== null) {
        geometry.latitude = centroid.y;
        geometry.longitude = centroid.x;
      }
      out(`geometry_parcel_${index}.json`, geometry);
      link(
        `relationship_parcel_has_geometry_parcel_${index}.json`,
        'parcel.json',
        `geometry_parcel_${index}.json`,
      );
    }
  }
}

// Shared helpers for the San Diego County (SANDAG / SanGIS Parcels layer) scripts bundle.
// CommonJS on purpose: elephant-cli extracts the bundle to a temp folder and runs each
// script with plain `node`, cwd = a work folder holding input.json, property_seed.json and
// unnormalized_address.json.
//
// Every code table below is copied from the layer's own metadata document
// (<layer>/metadata, attribute definitions for NUCLEUS_USE_CD, DOCTYPE, OVERLAY_JURIS and
// QUAL_CLASS_SHAPE). Nothing here is guessed: a code without an entry maps to null.
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/** Trimmed string, or null when the source value is null, not a string, or blank. */
function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The single feature of the per-parcel ArcGIS response, or null when it has none. */
function readFeature(workDir) {
  const input = readJson(path.join(workDir, 'input.json'));
  if (!input || !Array.isArray(input.features)) {
    throw new Error('input.json is not an ArcGIS query response (no "features" array)');
  }
  if (input.features.length === 0) return null;
  // One APN can own several polygons (a parcel split by a road). The assessor attributes
  // repeat on each; the first carries them, every feature contributes its rings.
  return {
    attributes: input.features[0].attributes || {},
    centroid: input.features[0].centroid || null,
    features: input.features,
    wkid: input.spatialReference ? input.spatialReference.wkid : null,
  };
}

/** SANDAG stores small integers as zero-padded text: "003" bedrooms, "025" = 2.5 baths. */
function paddedInt(value) {
  const t = text(value);
  return t !== null && /^\d+$/.test(t) ? Number(t) : null;
}

// NUCLEUS_USE_CD -> lexicon property_type / property_usage_type.
// `type: null` means "decide from the record" (Building when the assessor carries an
// improvement value, LandParcel otherwise). `vacant` marks the codes the assessor itself
// labels VACANT.
const USE_CODES = {
  '000': { label: 'UNKNOWN', type: null, usage: 'Unknown' },
  '067': { label: 'INFO PARCEL-TIME SHARE', type: 'Timeshare', usage: 'Residential' },
  '070': { label: 'TIME SHARE GENERIC', type: 'Timeshare', usage: 'Residential' },
  '072': { label: 'TIME SHARE INDEXED', type: 'Timeshare', usage: 'Residential' },
  109: { label: 'SINGLE FAMILY RESIDENCE WITH ADU', type: 'SingleFamily', usage: 'Residential' },
  110: { label: 'SINGLE FAMILY RESIDENCE - GENERIC', type: 'SingleFamily', usage: 'Residential' },
  111: { label: 'SINGLE FAMILY RESIDENCE', type: 'SingleFamily', usage: 'Residential' },
  112: {
    label: 'SINGLE FAMILY RESIDENCE W/GRANNY FLAT',
    type: 'SingleFamily',
    usage: 'Residential',
  },
  113: { label: 'SINGLE FAMILY GATED COMMUNITY', type: 'SingleFamily', usage: 'Residential' },
  114: { label: 'SINGLE FAMILY ATTACHED/PUD', type: 'SingleFamily', usage: 'Residential' },
  115: { label: 'SINGLE FAMILY DETACHED/PUD', type: 'SingleFamily', usage: 'Residential' },
  116: {
    label: 'SINGLE FAMILY RESIDENCE W/SHARED WATER SYS',
    type: 'SingleFamily',
    usage: 'Residential',
  },
  117: { label: 'SINGLE FAMILY WITH AG BUILDINGS', type: 'SingleFamily', usage: 'Residential' },
  118: {
    label: 'SINGLE FAMILY RESIDENCE ATTACHED - AGE RESTRICTED',
    type: 'SingleFamily',
    usage: 'Residential',
  },
  119: {
    label: 'SINGLE FAMILY RESIDENCE DETACHED - AGE RESTRICTED',
    type: 'SingleFamily',
    usage: 'Residential',
  },
  120: { label: 'DUPLEX - GENERIC', type: 'Duplex', usage: 'Residential' },
  130: { label: '2 - 4 UNITS - GENERIC', type: 'MultiFamilyLessThan10', usage: 'Residential' },
  // 5 - 15 units straddles the lexicon's 10-unit split, so only the generic type fits.
  140: { label: '5 - 15 UNITS GENERIC', type: 'MultipleFamily', usage: 'Residential' },
  150: { label: '16 - 60 UNITS GENERIC', type: 'MultiFamilyMoreThan10', usage: 'Residential' },
  152: {
    label: '16 - 60 UNITS SENIOR HOUSING',
    type: 'MultiFamilyMoreThan10',
    usage: 'Residential',
  },
  153: {
    label: '16 - 60 UNITS - RESTRICTED RENTS',
    type: 'MultiFamilyMoreThan10',
    usage: 'Residential',
  },
  160: { label: '61 UNITS AND UP GENERIC', type: 'MultiFamilyMoreThan10', usage: 'Residential' },
  162: {
    label: '61 UNITS AND UP SENIOR HOUSING',
    type: 'MultiFamilyMoreThan10',
    usage: 'Residential',
  },
  163: {
    label: '61 UNITS AND UP RESTRICTED HOUSING',
    type: 'MultiFamilyMoreThan10',
    usage: 'Residential',
  },
  170: {
    label: 'CONDOS AND OTHER RES CLASSIFICATIONS',
    type: 'Condominium',
    usage: 'Residential',
    condo: true,
  },
  171: { label: 'CONDOS ATTACHED', type: 'Condominium', usage: 'Residential', condo: true },
  172: { label: 'CONDOS DETACHED', type: 'DetachedCondominium', usage: 'Residential', condo: true },
  175: {
    label: 'CONDOS ATTACHED - AGE RESTRICTED',
    type: 'Condominium',
    usage: 'Residential',
    condo: true,
  },
  176: {
    label: 'CONDOS DETACHED - AGE RESTRICTED',
    type: 'DetachedCondominium',
    usage: 'Residential',
    condo: true,
  },
  180: { label: 'CO-OP GENERIC', type: 'Cooperative', usage: 'Residential' },
  182: { label: 'CO-OP ON LEASED LAND', type: 'Cooperative', usage: 'Residential' },
  191: {
    label: 'COMMON AREA, RECREATION FACILITY FOR DEVELOP',
    type: 'ResidentialCommonElementsAreas',
    usage: 'ResidentialCommonElementsAreas',
  },
  200: { label: 'VACANT LAND COMMERCIAL', type: 'VacantLand', usage: 'Commercial', vacant: true },
  210: {
    label: 'GENERIC COMMERCIAL OFFICE/RETAIL 1-3 STORIES',
    type: null,
    usage: 'Commercial',
  },
  211: { label: '1 - 3 STORY OFFICE ONLY', type: null, usage: 'OfficeBuilding' },
  212: { label: 'OFFICE/RETAIL BUILDING', type: null, usage: 'Commercial' },
  213: { label: 'SINGLE TENANT STAND ALONE RETAIL BLDG', type: null, usage: 'RetailStore' },
  214: { label: 'CONVENIENCE STORE (7/11, CIRCLE K, ETC)', type: null, usage: 'RetailStore' },
  215: { label: 'DEPARTMENT STORE', type: null, usage: 'DepartmentStore' },
  216: { label: 'SINGLE STORY STRIP RETAIL', type: null, usage: 'RetailStore' },
  220: {
    label: 'GENERIC-4 AND MORE STORY OFFICE BUILDING',
    type: null,
    usage: 'OfficeBuilding',
  },
  221: { label: '4 AND MORE STORY OFFICE', type: null, usage: 'OfficeBuilding' },
  230: { label: 'REGIONAL SHOPPING CENTER', type: null, usage: 'ShoppingCenterRegional' },
  240: { label: 'COMMUNITY SHOPPING CENTER', type: null, usage: 'ShoppingCenterCommunity' },
  261: { label: 'HOTEL', type: null, usage: 'Hotel' },
  271: { label: 'SERVICE STATION', type: null, usage: 'ServiceStation' },
  281: { label: 'MEDICAL-DENTAL OFFICE', type: null, usage: 'MedicalOffice' },
  351: { label: 'RESTAURANT - INDEPENDENT', type: null, usage: 'Restaurant' },
  392: { label: 'BANK', type: null, usage: 'FinancialInstitution' },
  400: { label: 'VACANT INDUSTIAL', type: 'VacantLand', usage: 'Industrial', vacant: true },
  410: { label: 'FACTORY/LIGHT MANUFACTURING', type: null, usage: 'LightManufacturing' },
  420: { label: 'FACTORY HEAVY MANUFACTURING', type: null, usage: 'HeavyManufacturing' },
  430: {
    label: 'WAREHOUSE-PROCESSING/STORAGE/DISTRIBUTION',
    type: null,
    usage: 'Warehouse',
  },
  710: { label: 'CHURCH', type: null, usage: 'Church' },
  820: { label: 'GOLF COURSE', type: null, usage: 'GolfCourse' },
};

// Hundred-block headings from the same metadata list, used only for property_usage_type
// when a code has no entry above.
const USE_BLOCKS = { 2: 'Commercial', 3: 'Commercial', 4: 'Industrial', 5: 'Agricultural' };

/**
 * Map the assessor use code. Returns the lexicon values plus `mapped: false` when the code
 * is not in the table, so the caller can report it instead of dropping the parcel.
 */
function mapUseCode(rawCode, hasImprovementValue) {
  const code = text(rawCode);
  const entry = code === null ? undefined : USE_CODES[code];
  const fallbackType = hasImprovementValue ? 'Building' : 'LandParcel';
  if (entry === undefined) {
    const block = code !== null && /^\d{3}$/.test(code) ? USE_BLOCKS[code[0]] : undefined;
    return {
      code,
      label: null,
      mapped: false,
      property_type: fallbackType,
      property_usage_type: block === undefined ? null : block,
      vacant: false,
      condo: false,
    };
  }
  return {
    code,
    label: entry.label,
    mapped: true,
    property_type: entry.type === null ? fallbackType : entry.type,
    property_usage_type: entry.usage,
    vacant: entry.vacant === true,
    condo: entry.condo === true,
  };
}

// SITUS_JURIS -> municipality. CN is the unincorporated county: no municipality.
const JURISDICTIONS = {
  CB: 'Carlsbad',
  CO: 'Coronado',
  CV: 'Chula Vista',
  DM: 'Del Mar',
  EC: 'El Cajon',
  EN: 'Encinitas',
  ES: 'Escondido',
  IB: 'Imperial Beach',
  LG: 'Lemon Grove',
  LM: 'La Mesa',
  NC: 'National City',
  OC: 'Oceanside',
  PW: 'Poway',
  SD: 'San Diego',
  SM: 'San Marcos',
  SO: 'Solana Beach',
  ST: 'Santee',
  VS: 'Vista',
};

// DOCTYPE -> lexicon deed_type. Codes 0, 3, 4, 5, 6, 7 and 8 have no exact lexicon deed type.
const DEED_TYPES = { 1: 'Grant Deed', 2: 'Quitclaim Deed' };

// First character of QUAL_CLASS_SHAPE -> lexicon primary_framing_material.
// B (box), M (manufactured) and S (special) have no lexicon value.
const FRAMING = { A: 'Steel Frame', C: 'Masonry', D: 'Wood Frame' };

// Street suffixes: the lexicon wants USPS abbreviations in title case (St, Rd, Dr ...).
const SUFFIX_ENUM = new Set(
  (
    'Rds Blvd Lk Pike Ky Vw Curv Psge Ldg Mt Un Mdw Via Cor Kys Vl Pr Cv Isle Lgt Hbr Btm Hl Mews ' +
    'Hls Pnes Lgts Strm Hwy Trwy Skwy Is Est Vws Ave Exts Cvs Row Rte Fall Gtwy Wls Clb Frk Cpe ' +
    'Fwy Knls Rdg Jct Rst Spgs Cir Crst Expy Smt Trfy Cors Land Uns Jcts Ways Trl Way Trlr Aly ' +
    'Spg Pkwy Cmn Dr Grns Oval Cirs Pt Shls Vly Hts Clf Flt Mall Frds Cyn Lndg Mdws Rd Xrds Ter ' +
    'Prt Radl Grvs Rdgs Inlt Trak Byu Vlgs Ctr Ml Cts Arc Bnd Riv Flds Mtwy Msn Shrs Rue Crse ' +
    'Cres Anx Drs Sts Holw Vlg Prts Sta Fld Xrd Wall Tpke Ft Bg Knl Plz St Cswy Bgs Rnch Frks Ln ' +
    'Mtn Ctrs Orch Iss Brks Br Fls Trce Park Gdns Rpds Shl Lf Rpd Lcks Gln Pl Path Vis Lks Run ' +
    'Frg Brg Sqs Xing Pln Glns Blfs Plns Dl Clfs Ext Pass Gdn Brk Grn Mnr Cp Pne Spur Opas Upas ' +
    'Tunl Sq Lck Ests Shr Dm Mls Wl Mnrs Stra Frgs Frst Flts Ct Mtns Frd Nck Ramp Vlys Pts Bch ' +
    'Loop Byp Cmns Fry Walk Hbrs Dv Hvn Blf Grv Crk'
  ).split(' '),
);

/** "ST" -> "St". Returns null when the title-cased source suffix is not a lexicon value. */
function mapSuffix(raw) {
  const t = text(raw);
  if (t === null) return null;
  const titled = t[0].toUpperCase() + t.slice(1).toLowerCase();
  return SUFFIX_ENUM.has(titled) ? titled : null;
}

const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

function mapDirection(raw) {
  const t = text(raw);
  return t !== null && DIRECTIONS.has(t.toUpperCase()) ? t.toUpperCase() : null;
}

module.exports = {
  DEED_TYPES,
  FRAMING,
  JURISDICTIONS,
  mapDirection,
  mapSuffix,
  mapUseCode,
  paddedInt,
  readFeature,
  readJson,
  text,
  writeJson,
};

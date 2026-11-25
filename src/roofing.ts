/**
 * Deterministic roofing classification for permit text.
 *
 * Neither permit source has a "roofing" permit type, and most permits that mention a roof are
 * roof-mounted solar or rooftop equipment. Rules run in order and the first match wins. The matched
 * rule name is stored on every permit row so any classification can be traced and audited.
 */

export type RoofingClass = 'reroof' | 'roof repair' | 'roof structural' | 'solar-on-roof' | 'other';

export interface RoofingResult {
  readonly roofingClass: RoofingClass;
  /** True only for real roofing work: reroof, roof repair, roof structural. */
  readonly isRoofing: boolean;
  /** Name of the rule that decided the class. Null when the text never mentions a roof. */
  readonly rule: string | null;
}

interface Rule {
  readonly name: string;
  readonly roofingClass: RoofingClass;
  readonly pattern: RegExp;
  /** The rule does not apply when this also matches. */
  readonly unless?: RegExp;
}

const NOT_EQUIPMENT =
  '(?!\\s*-?\\s*(?:MOUNT|TOP|TRUSS|FRAM|STRUCT|RAFTER|EQUIP|HVAC|A\\/?C\\b|UNIT|PACKAGE|EXHAUST|DRAIN|SOLAR|PV\\b|DECK|ACCESS|HATCH|SIGN|LADDER|VENT|FAN))';
// Real spellings include "photo voltaic", "Photovoltec" and "PVS".
const SOLAR = '\\b(?:PHOTO ?VOLT\\w*|PVS?|SOLAR)\\b';
const REROOF_WORD = '\\bRE-?\\s?ROOF(?:ING|ED|S)?\\b';
// A solar system, as opposed to the "solar reflectance" and "solar ready" wording of cool-roof forms.
const SOLAR_SYSTEM = '\\b(?:PHOTO ?VOLT\\w*|PVS?\\b|SOLAR\\b(?! REFLECT| READY))';
const ROOF_MEMBER = '(?:TRUSS(?:ES)?|FRAMING|RAFTERS?|STRUCTUR\\w+|BEAMS?|JOISTS?|DIAPHRAGM)';
const STRUCTURAL_VERB =
  '(?:REPLAC\\w*|REPLCMNT|REPAIR\\w*|RE-?FRAM\\w*|REBUIL\\w*|RECONSTRUCT\\w*|REINFORC\\w*|STRENGTHEN\\w*|MODIF\\w*)';

export const ROOFING_RULES: readonly Rule[] = [
  {
    // "NO REROOF", "DOES NOT INCLUDE RE-ROOF", "REROOF UNDER SEPARATE PERMIT".
    // Deliberately narrow: "NO PLAN PERMIT FOR RE-ROOF" is a real reroof and must not match.
    name: 'reroof_negated',
    roofingClass: 'other',
    pattern: new RegExp(
      `\\bNO (?:NEW |ANY )?${REROOF_WORD}|\\b(?:NOT|W\\/O|WITHOUT|EXCLUD\\w*)(?: (?:TO|A|ANY|THE|INCLUDE|INCLUDES|INCLUDING))* ${REROOF_WORD}|${REROOF_WORD}[^.;:]{0,30}\\b(?:SEPARATE PERMIT|NOT INCLUDED|NOT A PART|BY OTHERS)\\b`,
    ),
  },
  {
    // A solar job that touches the roof on the way: "UNINSTALL AND REINSTALL OF 14 SOLAR MODULES AFTER
    // REROOFING", "PARTIAL LIFT & RELAY REROOF FOR 9.84KW ROOF-MOUNT PV". The permit is for the array.
    // It counts as roofing only when it says the whole roof was redone ("FULL REROOF FOR PV").
    name: 'solar_job_reroof_incidental',
    roofingClass: 'solar-on-roof',
    pattern: new RegExp(
      `^(?=.*${SOLAR_SYSTEM})(?=.*(?:${REROOF_WORD}|\\bNEW ROOFING\\b|\\bROOF(?:ING)? REPLACEMENT\\b))`,
    ),
    unless: /\b(?:FULL|ENTIRE|COMPLETE|WHOLE)\b/,
  },
  {
    // "PICTURE FRAME PARTIAL REROOF FOR 14.35KW ROOF-MOUNT PV": only the area under the array is redone.
    // Real roofing work, but it must not reset the roof's age, so it is classed as a repair.
    name: 'reroof_partial',
    roofingClass: 'roof repair',
    // Solar installers also write "picture frame" or "under array" for the same thing.
    pattern: new RegExp(
      `\\b(?:PARTIAL|PICTURE FRAME|UNDER ARRAY)\\b[^.;:]{0,40}${REROOF_WORD}|${REROOF_WORD}[^.:]{0,30}\\b(?:PARTIAL|PICTURE FRAME|UNDER ARRAY)\\b`,
    ),
    // "PICTURE FRAME TILE FULL REROOF" says the whole roof was redone.
    unless: /\bFULL\b/,
  },
  { name: 'reroof_explicit', roofingClass: 'reroof', pattern: new RegExp(REROOF_WORD) },
  {
    name: 'roof_replacement',
    roofingClass: 'reroof',
    pattern: new RegExp(
      `\\bROOF(?:ING)? (?:COVERING )?REPLACEMENT\\b|\\bREPLAC(?:E|ES|ED|ING|EMENT OF)\\b(?: (?:THE|AN?|ALL|ENTIRE|EXISTING|EXIST|EXTG|\\(E\\)|E|OLD|DAMAGED|[0-9,]+ ?(?:SQ\\.? ?FT\\.?|SF|SQUARES?)(?: OF)?))* ROOF(?:ING)?\\b${NOT_EQUIPMENT}|\\bREMOVE (?:AND|&) REPLACE (?:THE |EXISTING |\\(E\\) )?ROOF(?:ING)?\\b${NOT_EQUIPMENT}`,
    ),
  },
  {
    name: 'roof_tear_off_or_overlay',
    roofingClass: 'reroof',
    pattern:
      /\bTEAR[- ]?OFF\b|\bROOF(?:ING)? (?:OVERLAY|RECOVER)\b|\bNEW ROOF(?:ING)? (?:COVERING|MATERIALS?|SHINGLES?|TILES?|MEMBRANE)\b|\bNEW ROOFING\b|\bREMOVE (?:THE |ALL |EXISTING |\(E\) )*ROOF(?:ING)? (?:SYSTEM|COVERING|MATERIALS?|SHINGLES?|TILES?)\b/,
  },
  {
    // Checked before the repair/structural rules: "ROOF MOUNTED PV, REPAIR ROOF RAFTERS" is a solar permit.
    name: 'solar_on_roof',
    roofingClass: 'solar-on-roof',
    pattern: new RegExp(`${SOLAR}[\\s\\S]*\\bROOF|\\bROOF[\\s\\S]*${SOLAR}`),
  },
  {
    name: 'roof_mounted_equipment',
    roofingClass: 'other',
    pattern:
      /\bROOF[- ]?(?:TOP|MOUNT(?:ED)?)\b[^.;]{0,60}\b(?:A\/?C|HVAC|UNITS?|RTU|MECHANICAL|ANTENNAS?|EQUIPMENT|CONDENS\w*|PACKAGE|FAU|HEAT PUMP|EXHAUST|FANS?|SIGNS?)\b|\b(?:A\/?C|HVAC|RTU|MECHANICAL|ANTENNAS?|EQUIPMENT|CONDENS\w*|PACKAGE UNITS?|HEAT PUMPS?|EXHAUST FANS?)\b[^.;]{0,40}\b(?:ON|AT|ONTO) (?:THE |EXISTING |\(E\) )?ROOF\b/,
  },
  {
    // The roof structure itself must be the thing worked on: "REPLACE DAMAGED ROOF TRUSSES",
    // "ROOF STRUCTURE REPLACEMENT OVER GARAGE", "NEW ROOF STRUCTURE OVER EXISTING DUPLEX", flat to
    // pitched. A bare mention ("INTEGRATED ROOF STRUCTURE" of a new shell, "VENT TO PENETRATE THROUGH
    // ROOF STRUCTURE", "NEW ROOF FRAMING" of an addition) is not roofing work and falls through.
    name: 'roof_structural',
    roofingClass: 'roof structural',
    pattern: new RegExp(
      `\\b${STRUCTURAL_VERB}\\b[^.;,]{0,40}\\bROOF ${ROOF_MEMBER}\\b|\\bROOF ${ROOF_MEMBER}\\b[^.;,]{0,25}\\b${STRUCTURAL_VERB}\\b|\\bNEW ROOF STRUCTURE (?:OVER|FOR|ON) (?:AN? |THE )?(?:EXISTING|EXIST|EXTG|\\(E\\))|\\b(?:RAISE|RAISING|ALTER\\w*|MODIFY\\w*|CHANGE\\w*)\\b[^.;]{0,20}\\bROOF ?LINE\\b|\\b(?:FLAT|PITCHED) ROOF TO (?:A )?(?:FLAT|PITCHED)\\b|\\bROOF[^.;,]{0,30}\\bFROM FLAT TO PITCHED\\b`,
    ),
  },
  {
    name: 'roof_repair',
    roofingClass: 'roof repair',
    pattern: new RegExp(
      `\\bROOF(?:ING)? (?:REPAIRS?|PATCH\\w*|MAINTENANCE|LEAKS?|COATING|SHEATHING|DAMAGE\\w*)\\b|\\b(?:REPAIR\\w*|PATCH\\w*|RESTOR\\w*)\\b(?: (?:THE|AN?|ALL|TO|OF|EXISTING|\\(E\\)|DAMAGED|FIRE|WATER|PORTION))* ROOF(?:ING)?\\b${NOT_EQUIPMENT}`,
    ),
  },
  {
    // Roofing materials named without a verb: usually a description of new construction, not roof work.
    name: 'roof_material_mention',
    roofingClass: 'other',
    pattern:
      /\bROOFING\b|\bROOF (?:COVERING|TILES?|SHINGLES?|MEMBRANE|UNDERLAYMENT)\b|\b(?:COMP(?:OSITION)?|ASPHALT) SHINGLES?\b|\b(?:TPO|TORCH[- ]DOWN|CAP SHEET|COOL ROOF)\b/,
  },
  { name: 'roof_mention_unclassified', roofingClass: 'other', pattern: /ROOF/ },
];

const ROOFING_CLASSES: ReadonlySet<RoofingClass> = new Set<RoofingClass>([
  'reroof',
  'roof repair',
  'roof structural',
]);

/**
 * Approval types that are never roofing work, whatever their text says. The text of such a record
 * describes a project or another permit, not work authorised by this record.
 */
const NON_ROOFING_TYPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    // "Construction Change to PTS 295778 ... changing from existing roof trusses to new prefabricated
    // trusses": a revision to a permit that is already in the data. Counting it would count the roof twice
    // and date it by the paperwork. The same goes for deferred submittals reviewed against a parent permit.
    name: 'revision_of_another_permit',
    pattern: /\bCONSTRUCTION CHANGE\b|\bDEFERRED DOCUMENT REVIEW\b/,
  },
  {
    // A single-trade or solar permit. Its text is often the whole project's scope ("Building permit for
    // roof repair ..." on the Electrical Pmt of that project); the roofing permit is the building permit.
    // "No-Plan - Residential - Combination Mech/Elec/Plum" is not caught: the city files real reroofs there.
    name: 'trade_permit_not_building_work',
    pattern:
      /^(?:ELECTRICAL|MECHANICAL|PLUMBING|FIRE)\b|\b(?:ELECTRICAL|MECHANICAL|PLUMBING) PMT\b|- (?:ELECTRICAL|MECHANICAL|PLUMBING)$|\bPHOTOVOLTAIC\b|\bPV\b|\bSOLAR\b/,
  },
  {
    // Agreements, encroachments, right-of-way and traffic-control permits, planning and discretionary
    // approvals (conformance reviews, use and development permits, maps), signs, grading and demolition
    // authorise something other than building a roof.
    name: 'approval_type_not_building_work',
    pattern:
      /\bAGREEMENT\b|\bENCROACH\w*|\bRIGHT[- ]OF[- ]WAY\b|\bROW PERMIT\b|\bTRAFFIC CONTROL\b|\bDEVELOPMENT\b|\bUSE PERMIT\b|\bCONFORMANCE\b|\bREVIEW\b|\bZONING\b|\bVARIANCE\b|\bSIGN PERMIT\b|\bDEMOLITION\b|\bGRADING\b|\bMAP\b|\bEASEMENT\b/,
  },
];

/** Types that are building or construction work. Anything else that is not blank is refused. */
const BUILDING_WORK_TYPE =
  /\bBUILDING\b|\bBLDG\b|\bCOMBINATION\b|\bALTERATION\b|\bADDN\b|\bSTRUCTURE\b|\bSTRUC\b|\bRESIDENTIAL\b|\bCOMMERCIAL\b|\bTRACT\b|\bMH PARK\b/;

/**
 * County categories for new buildings. A real reroof is sometimes filed under them and is kept, but a
 * roof-structure or roof-repair phrase there describes the new building, so the roof is incidental.
 */
const NEW_CONSTRUCTION_TYPE = /^NEW \b|\bTRACT\b|\bPARENT\b/;

/**
 * Classification for a permit record. `is_roofing` needs both halves:
 *  1. the approval type is building or construction work (a blank type is accepted; a type that is
 *     planning, an agreement, a single trade, solar, or simply unrecognised is not), and
 *  2. the text rules find roofing work on the roof itself.
 * When the type refuses a record whose text mentions a roof, the type rule is recorded.
 */
export function classifyPermitRoofing(
  permitType: string | null | undefined,
  ...parts: readonly (string | null | undefined)[]
): RoofingResult {
  const byText = classifyRoofing(permitType, ...parts);
  if (byText.rule === null) return byText;
  const type = (permitType ?? '').toUpperCase().trim();
  const refuse = (rule: string): RoofingResult => ({ roofingClass: 'other', isRoofing: false, rule });
  const excluded = NON_ROOFING_TYPES.find((t) => t.pattern.test(type));
  if (excluded !== undefined) {
    // Solar permits keep their own class; everything else refused by type becomes `other`.
    return byText.roofingClass === 'solar-on-roof' ? byText : refuse(excluded.name);
  }
  if (type !== '' && !BUILDING_WORK_TYPE.test(type)) {
    return byText.roofingClass === 'solar-on-roof' ? byText : refuse('approval_type_not_building_work');
  }
  if (NEW_CONSTRUCTION_TYPE.test(type) && byText.isRoofing && byText.roofingClass !== 'reroof') {
    return refuse('new_construction_roof_incidental');
  }
  return byText;
}

export function classifyRoofing(...parts: readonly (string | null | undefined)[]): RoofingResult {
  const text = parts
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join(' . ')
    .toUpperCase()
    .replace(/\s+/g, ' ');
  if (!text.includes('ROOF')) return { roofingClass: 'other', isRoofing: false, rule: null };
  for (const rule of ROOFING_RULES) {
    if (rule.pattern.test(text) && rule.unless?.test(text) !== true) {
      return {
        roofingClass: rule.roofingClass,
        isRoofing: ROOFING_CLASSES.has(rule.roofingClass),
        rule: rule.name,
      };
    }
  }
  return { roofingClass: 'other', isRoofing: false, rule: null };
}

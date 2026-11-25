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
    name: 'roof_structural',
    roofingClass: 'roof structural',
    pattern:
      /\bROOF (?:TRUSS(?:ES)?|FRAMING|RAFTERS?|STRUCTUR\w+|BEAMS?|JOISTS?|DIAPHRAGM)\b|\b(?:RAISE|RAISING|EXTEND\w*|ALTER\w*|MODIFY\w*|CHANGE\w*)\b[^.;]{0,20}\bROOF ?LINE\b|\bROOF (?:ADDITION|EXTENSION|CONVERSION)\b|\bROOF[- ]TO[- ]WALL\b|\b(?:FLAT|PITCHED) ROOF TO (?:A )?(?:FLAT|PITCHED)\b/,
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
    // Agreements, encroachments, right-of-way and traffic-control permits, land-use approvals, signs
    // and demolition authorise something other than building a roof.
    name: 'approval_type_not_building_work',
    pattern:
      /\bAGREEMENT\b|\bENCROACH\w*|\bRIGHT[- ]OF[- ]WAY\b|\bROW PERMIT\b|\bTRAFFIC CONTROL\b|\bDEVELOPMENT PERMIT\b|\bUSE PERMIT\b|\bZONING\b|\bVARIANCE\b|\bSIGN PERMIT\b|\bDEMOLITION\b|\bGRADING\b|\b(?:TENTATIVE|PARCEL|FINAL) MAP\b|\bEASEMENT\b/,
  },
];

/**
 * Classification for a permit record: the approval type is checked first, then the text rules.
 * A non-roofing type that mentions a roof is classed `other` with the type rule recorded.
 */
export function classifyPermitRoofing(
  permitType: string | null | undefined,
  ...parts: readonly (string | null | undefined)[]
): RoofingResult {
  const byText = classifyRoofing(permitType, ...parts);
  if (byText.rule === null) return byText;
  const type = (permitType ?? '').toUpperCase();
  const excluded = NON_ROOFING_TYPES.find((t) => t.pattern.test(type));
  return excluded === undefined ? byText : { roofingClass: 'other', isRoofing: false, rule: excluded.name };
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

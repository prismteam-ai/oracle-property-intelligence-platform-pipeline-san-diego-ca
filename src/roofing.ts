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
      /\bTEAR[- ]?OFF\b|\bROOF(?:ING)? (?:OVERLAY|RECOVER)\b|\bNEW ROOF(?:ING)? (?:COVERING|MATERIALS?|SHINGLES?|TILES?|MEMBRANE)\b|\bNEW ROOFING\b/,
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

export function classifyRoofing(...parts: readonly (string | null | undefined)[]): RoofingResult {
  const text = parts
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join(' . ')
    .toUpperCase()
    .replace(/\s+/g, ' ');
  if (!text.includes('ROOF')) return { roofingClass: 'other', isRoofing: false, rule: null };
  for (const rule of ROOFING_RULES) {
    if (rule.pattern.test(text)) {
      return {
        roofingClass: rule.roofingClass,
        isRoofing: ROOFING_CLASSES.has(rule.roofingClass),
        rule: rule.name,
      };
    }
  }
  return { roofingClass: 'other', isRoofing: false, rule: null };
}

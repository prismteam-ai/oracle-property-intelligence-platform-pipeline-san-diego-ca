import { describe, expect, it } from 'vitest';
import { carlsbadStatusGroup } from '../src/adapters/carlsbadPermits.js';
import { ROOFING_RULES, classifyRoofing, type RoofingClass } from '../src/roofing.js';

/**
 * Every description below is real permit text recorded from the City of San Diego approvals files or
 * the County of San Diego building permits dataset (shortened only by cutting the tail).
 */
type Case = readonly [text: string, expectedClass: RoofingClass, expectedRule: string | null];

const REAL_REROOFS: readonly Case[] = [
  [
    'Cross street: PAMOSSA Activity Code: 426X05 Description of Work: REROOF SFD AND BARN ICBO 2310 CONCRETE TILE TO CONCRETE TILE',
    'reroof',
    'reroof_explicit',
  ],
  [
    'Cross street: MORRO HILLS Activity Code: 42R114 Description of Work: RE-ROOF, 2300 SQ. FT. COMP, ICBO 5415 TB: 1047, E6',
    'reroof',
    'reroof_explicit',
  ],
  ['CROSS STREET: DURGIN DESCRIPTION OF WORK: REROOF', 'reroof', 'reroof_explicit'],
  [
    'Cross street: PASEO PALMAS DR Description of Work: 1800 SQFT If a re-roof project is proposed, the following specifications apply. Existing roofing material: CONCRETE TILE Proposed roofing material: CONCRETE TILE',
    'reroof',
    'reroof_explicit',
  ],
  // "No plan" is a City permit type, not a negation. An earlier draft of the rules got these wrong.
  [
    'Re-roof // Combination no plan permit for a re-roof to an existing single family residence. Scope of work to include tear off of existing asphalt shingles',
    'reroof',
    'reroof_explicit',
  ],
  [
    'Rodriguez Reroof // SOUTHEASTERN...Combo Permit NO PLAN to reroof & some resheathing for existing SDU. Type A Shingle.',
    'reroof',
    'reroof_explicit',
  ],
  [
    'Small Residence Re-roof // For a no plan permit to re-roof an existing SDU with attached garage. House buit in 1968.',
    'reroof',
    'reroof_explicit',
  ],
  [
    'Ruiz Roof Replacement // Roof replacement at an existing single family residence. Work includes roof covering replacement and less than 25% of sheathing to be replaced.',
    'reroof',
    'roof_replacement',
  ],
  [
    'General-Standard-Building Construction:4804/Baylor // Proposed roof replacement at (E) 2-story SDU.',
    'reroof',
    'roof_replacement',
  ],
  [
    'Haselbeck Residence // Combination Building Permit to replace existing roof cool roof assembly',
    'reroof',
    'roof_replacement',
  ],
  [
    "Castro's Apartments // Building permit for replacing the roof, includes electrical, plumbing, stucco and replacement of all windows with same size due to fire damage",
    'reroof',
    'roof_replacement',
  ],
  [
    'Cross street: SIETE LENGUAS T.B. 1168 Description of Work: TEAR-OFF ROOF ADD LIGHTWEIGHT TILE (ICBO 2656)',
    'reroof',
    'roof_tear_off_or_overlay',
  ],
  ['COMBINATION BUILDING PERMIT // INSTALL NEW ROOF SHINGLES', 'reroof', 'roof_tear_off_or_overlay'],
  [
    'General-Standard-Building Construction:4044/Hamilton // Building permit for new roof covering to an existing single family residence. HRB # 909',
    'reroof',
    'roof_tear_off_or_overlay',
  ],
  [
    'Park de la Cruz - Rec/Gym Remo // For minor remodel and voluntary ADA upgrades; new roofing.',
    'reroof',
    'roof_tear_off_or_overlay',
  ],
];

const REAL_REPAIR_AND_STRUCTURAL: readonly Case[] = [
  [
    'Roof Repair // No Plans Building Permit to repair in kind damage roof area',
    'roof repair',
    'roof_repair',
  ],
  [
    'Modernaire Apts Roof Repair // No Plan building permit for roof repair at several apartment buildings.',
    'roof repair',
    'roof_repair',
  ],
  [
    'Walker Fire Damage Repair // Combination permit to repair fire damaged roof, drywall, electrical, mechanical & plumbing for extg sdu.',
    'roof repair',
    'roof_repair',
  ],
  [
    'Cole Roof Structure // REDO EXISTING FLAT ROOF TO PITCHED ROOF 1357SF',
    'roof structural',
    'roof_structural',
  ],
  [
    'CROSS STREET: WISCONSON DESCRIPTION OF WORK: NEW ROOF STRUCTURE OVER EXISTING DUPLEX',
    'roof structural',
    'roof_structural',
  ],
  [
    'Wolf Residence Addition // New addition to single family residence. Includes new extension of den, new patio cover and roof framing.',
    'roof structural',
    'roof_structural',
  ],
  [
    'Cross street: CHEROKEE LANE Description of Work: MISC FIRE DAMAGE REPAIRS. REPAIR TO ROOF JOIST. REPLACE HVAC PACKAGE UNIT.',
    'roof structural',
    'roof_structural',
  ],
];

/** Text that mentions a roof but is not roofing work. These are the false positives a keyword search returns. */
const REAL_NOT_ROOFING: readonly Case[] = [
  ['8002 - REN - Solar Photovoltaic Roof Mount Residential - Online', 'solar-on-roof', 'solar_on_roof'],
  ['8002 - REN - (Online) RES Roof Mt Solar PV No Meter Upgrade (HRA)', 'solar-on-roof', 'solar_on_roof'],
  [
    'PVS 13872 Bassmore Dr // Electrical permit to install roof mounted photo voltaic system for extg sdu.',
    'solar-on-roof',
    'solar_on_roof',
  ],
  [
    'PVS 4395 Murphy Canyon Rd // KEARNY MESA: Building and electricl permit for installation of roof mounted PVS at (E) commercial buidling. IL2-1',
    'solar-on-roof',
    'solar_on_roof',
  ],
  [
    'For supression work associated with 6 plex with a roof mounted Photovoltec per Master Plan PRJ 1055004 Type J',
    'solar-on-roof',
    'solar_on_roof',
  ],
  [
    'Photovoltaic - SB 379 // Install 5.2 kW roof mounted PV system with 13 modules',
    'solar-on-roof',
    'solar_on_roof',
  ],
  ['E-permit Multiple // E-permit Multiple Cut in new A/C 3 ton on roof', 'other', 'roof_mounted_equipment'],
  [
    "Slater's 50/50 T.I. // Tenant improvement to an existing restaurant. Scope of work includes adding a 3 foot type-1hood to existing kitchen, as well as an exhaust fan on roof.",
    'other',
    'roof_mounted_equipment',
  ],
  [
    'Ann Taylor Loft Outlet TI #152 // Electrical Approval for tenant improvement: partitions, ceiling, storefront, elec, plbg & new rooftop RTU mechanical units for extg retail space #152.',
    'other',
    'roof_mounted_equipment',
  ],
  [
    'CROSS STREET: COLE GRADE DESCRIPTION OF WORK: BURNOUT STORAGE BUILDING - REPAIRING WINDOWS AND ADDING AND REPAIRING INTERIOR WALLS NO REROOF OR FINISH WORK',
    'other',
    'reroof_negated',
  ],
  [
    'Mira Woods Apartment Complex adding 10 linear feet of parapet to the roof, and 33.25 sq ft canopiesas a tenant improvement',
    'other',
    'roof_mention_unclassified',
  ],
  [
    'For the proposed (N) 2 story SFR. Work to include attached garage and 2 story deck, new foundation, wall, flooring. doors , windows, roofing and associated MEP',
    'other',
    'roof_material_mention',
  ],
  [
    'Cross street: DEL RIO RD Description of Work: AC & FAU REPLACEMENT WITH DUCTING FOR EXISTING SFD, MISC MECHANICAL',
    'other',
    null,
  ],
  [
    'Coca Cola // w.o. 40-0158 Community Plan Amendment and Rezone of 1.77 acre site located at 1352-96 47th Street',
    'other',
    null,
  ],
];

describe('classifyRoofing on real permit descriptions', () => {
  it.each([...REAL_REROOFS, ...REAL_REPAIR_AND_STRUCTURAL])(
    'roofing work: %s',
    (text, expectedClass, expectedRule) => {
      const result = classifyRoofing(text);
      expect({ c: result.roofingClass, rule: result.rule }).toEqual({ c: expectedClass, rule: expectedRule });
      expect(result.isRoofing).toBe(true);
    },
  );

  it.each(REAL_NOT_ROOFING)('not roofing work: %s', (text, expectedClass, expectedRule) => {
    const result = classifyRoofing(text);
    expect({ c: result.roofingClass, rule: result.rule }).toEqual({ c: expectedClass, rule: expectedRule });
    expect(result.isRoofing).toBe(false);
  });

  it('never calls roof-mounted solar a roofing permit, however it is spelled', () => {
    for (const [text] of REAL_NOT_ROOFING.filter(([, c]) => c === 'solar-on-roof')) {
      expect(classifyRoofing(text).isRoofing, text).toBe(false);
    }
  });

  it('lets an explicit reroof win when a permit covers both a reroof and solar', () => {
    const result = classifyRoofing('REROOF 2,400 SF COMP SHINGLE AND INSTALL 6KW ROOF MOUNTED PV SYSTEM');
    expect(result).toEqual({ roofingClass: 'reroof', isRoofing: true, rule: 'reroof_explicit' });
  });

  it('classifies across the separate fields a source provides', () => {
    expect(classifyRoofing('Combination Building Permit', 'Landon Re-roof permit', null).roofingClass).toBe(
      'reroof',
    );
    expect(classifyRoofing(null, undefined, '').rule).toBeNull();
  });

  it('is deterministic and every rule has a unique name', () => {
    const names = ROOFING_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [text] of REAL_REROOFS) expect(classifyRoofing(text)).toEqual(classifyRoofing(text));
  });
});

/** Real descriptions recorded from the City of Carlsbad building-permit layer (test/fixtures/carlsbad_permits). */
const CARLSBAD: readonly Case[] = [
  ['REROOF: LIFT & RELAY (E-REVIEW)', 'reroof', 'reroof_explicit'],
  [
    'LIFT AND LAY TILE FULL REROOF. 3 000SF. 30 SQUARES. 6 ROOF FACES. CONCRETE TILE. (E-REVIEW)',
    'reroof',
    'reroof_explicit',
  ],
  [
    'COMPOSITE SHINGLE REMOVE AND REPLACE FULL REROOF. 2 900SQFT. 29 SQUARES. COASTAL SLATE. CRRC:0676-0131A. (E-REVIEW)',
    'reroof',
    'reroof_explicit',
  ],
  [
    '7723 CALLE MADERO; RE-ROOF (32 SQUARES) REMOVING EXISTING CONCRETE TILE INSTALLING ASPHALT SHINGLES (E-REVIEW)',
    'reroof',
    'reroof_explicit',
  ],
  // A full reroof done together with solar is still a reroof ...
  [
    '28SQRS FULL COMP SHINGLE REROOF FOR 6.48KW ROOF-MOUNT PV W// 16MODULES & 16MICRO-INVERTERS (E-REVIEW)',
    'reroof',
    'reroof_explicit',
  ],
  [
    'PLATT / 20SQRS FULL LIFT & RELAY REROOF FOR ROOF-MOUNT PV / 4.92KW W// 12 MODULES & 12 MICRO-INVERTERS (E-REVIEW)',
    'reroof',
    'reroof_explicit',
  ],
  [
    'MITCHELL / PICTURE FRAME TILE FULL REROOF. 700SQFT. 7 SQUARES ROOF MOUNTED INSTALLATION / 4.92KW W// 12 MODULES AND 12 MICRO INVERTERS (E-REVIEW)',
    'reroof',
    'reroof_explicit',
  ],
  [
    'RUSSELL: ROOF MOUNT SOLAR WITH 20 MODULES  7.30 KW.  AND REROOF 15 SQUARES COMP SHINGLE (E-REVIEW)',
    'reroof',
    'reroof_explicit',
  ],
  // ... but a partial reroof under the array is a repair: real roofing work that must not reset the roof's age.
  [
    '15SQRS PICTURE FRAME PARTIAL REROOF FOR 14.35KW ROOF-MOUNT PV W// 35MODULES & 35MICRO-INVERTERS (E-REVIEW)',
    'roof repair',
    'reroof_partial',
  ],
  [
    '1300SQ FT PARTIAL LIFT & RELAY REROOF FOR 6.48KW ROOF-MOUNT PV ADDER W// 16MODULES  16MICRO-INVERTERS; 3.84KW ENERGY STORAGE (E-REVIEW)',
    'roof repair',
    'reroof_partial',
  ],
  ['900SQFT LIFT & LAY PARTIAL REROOF (E-REVIEW)', 'roof repair', 'reroof_partial'],
  [
    'REROOF; PARTIAL COMP UNDER ARRAY/PICTURE FRAME TILE (20 SQUARES)  (E-REVIEW)',
    'roof repair',
    'reroof_partial',
  ],
  ['HERFURTH; REROOF; COMP UNDER ARRAY 7 SQUARES (E-REVIEW)', 'roof repair', 'reroof_partial'],
  ['PICTURE FRAME RE-ROOF.  215 SF UL790. ASTM-1561. (E-REVIEW)', 'roof repair', 'reroof_partial'],
  [
    'PARTIAL RE-ROOF FOR FUTURE SOLAR. REMOVE EXISTING TILE. INSTALL 30# FELT  INSTALL COMPOSITION SHINGLES. BACKFILL TILE AROUND SOLAR ARRAY. (E-REVIEW)',
    'roof repair',
    'reroof_partial',
  ],
  // Solar with no roofing work.
  [
    'NEW 3.597DC KW ROOF MOUNTED PHOTOVOLTAIC SYSTEM W/ 11 MODS AND 11 MICRO INV (E-REVIEW)',
    'solar-on-roof',
    'solar_on_roof',
  ],
  ['SO; 14.4 KW SOLAR ROOF MOUNT  36 MODULES  2 BATTERIES (E-REVIEW)', 'solar-on-roof', 'solar_on_roof'],
  ['REES / ROOF TOP SOLAR / 4.74KW W// 12 MODULES & 1 INVERTER (E-REVIEW)', 'solar-on-roof', 'solar_on_roof'],
  [
    'KAKADELA: 15 ROOF MOUNTED PV SOLAR PANELS  1 INVERTER  1 NEW SUB PANEL  SYSTEM SIZE 6 KW DC (E-REVIEW)',
    'solar-on-roof',
    'solar_on_roof',
  ],
];

describe('classifyRoofing on real Carlsbad permit descriptions', () => {
  it.each(CARLSBAD)('%s', (text, expectedClass, expectedRule) => {
    const result = classifyRoofing(text);
    expect({ c: result.roofingClass, rule: result.rule }).toEqual({ c: expectedClass, rule: expectedRule });
    expect(result.isRoofing).toBe(expectedClass !== 'solar-on-roof');
  });

  it('groups Carlsbad statuses', () => {
    expect(carlsbadStatusGroup('Issued - Active')).toBe('open');
    expect(carlsbadStatusGroup('Closed - Finaled')).toBe('completed');
    expect(carlsbadStatusGroup('Closed - Expired')).toBe('expired');
    expect(carlsbadStatusGroup('Closed - Withdrawn')).toBe('cancelled');
    expect(carlsbadStatusGroup('Closed - Error')).toBe('cancelled');
    expect(carlsbadStatusGroup('Under Review - Active')).toBe('other');
    expect(carlsbadStatusGroup('Approved - Ready to Issue')).toBe('other');
  });
});

import { describe, expect, it } from 'vitest';
import { carlsbadStatusGroup } from '../src/adapters/carlsbadPermits.js';
import { ROOFING_RULES, classifyPermitRoofing, classifyRoofing, type RoofingClass } from '../src/roofing.js';

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
    'Huynh Roof Structure Change // Replace the roof structure with trusses & electrical panel upgrade for extg sdu.',
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

  it('treats a reroof done for a solar job as roofing only when it says the whole roof was redone', () => {
    expect(classifyRoofing('28SQRS FULL COMP SHINGLE REROOF FOR 6.48KW ROOF-MOUNT PV W// 16MODULES')).toEqual(
      {
        roofingClass: 'reroof',
        isRoofing: true,
        rule: 'reroof_explicit',
      },
    );
    expect(
      classifyRoofing('BONAS / 14SQRS COMP SHINGLE REROOF FOR ROOF-MOUNT PV / 8.91KW W// 22 MODULES'),
    ).toEqual({
      roofingClass: 'solar-on-roof',
      isRoofing: false,
      rule: 'solar_job_reroof_incidental',
    });
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
    'solar-on-roof',
    'solar_job_reroof_incidental',
  ],
  // ... but a reroof that is only part of a solar job (no "FULL") is classed with the solar job, and a
  // partial reroof with no solar is a repair: real roofing work that must not reset the roof's age.
  [
    '15SQRS PICTURE FRAME PARTIAL REROOF FOR 14.35KW ROOF-MOUNT PV W// 35MODULES & 35MICRO-INVERTERS (E-REVIEW)',
    'solar-on-roof',
    'solar_job_reroof_incidental',
  ],
  [
    '1300SQ FT PARTIAL LIFT & RELAY REROOF FOR 6.48KW ROOF-MOUNT PV ADDER W// 16MODULES  16MICRO-INVERTERS; 3.84KW ENERGY STORAGE (E-REVIEW)',
    'solar-on-roof',
    'solar_job_reroof_incidental',
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
    'solar-on-roof',
    'solar_job_reroof_incidental',
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
    expect(carlsbadStatusGroup('Under Review - Active')).toBe('pending');
    expect(carlsbadStatusGroup('Approved - Ready to Issue')).toBe('pending');
  });
});

/**
 * Real City of San Diego rows where the text mentions roof work but the record is not a roofing permit.
 * Each tuple is [approval type, project title, scope, expected rule].
 */
const NOT_BUILDING_WORK: readonly (readonly [string, string, string, string])[] = [
  // Reported from the live site: a revision note on another permit (approval 1101363, 624 Bonair Pl).
  [
    'Construction Change - Building',
    'Const. Change to PTS 295778',
    'Construction Change to PTS 295778, Approval Number: 1036523. Changes to include changing from existing roof trusses to new prefabricated trusses.',
    'revision_of_another_permit',
  ],
  [
    'Construction Change - Building',
    'Const. Chg. to Project 634429',
    'Construction change to project 634429, approval 2278014 - (Delta 1) revision to show roof framing at interior remodel',
    'revision_of_another_permit',
  ],
  // An agreement record that inherits its project's scope text (AGR-0001970, AGR-0003729).
  [
    'Approval - Process - Agreement',
    'Rapid Review-Standard-Building Construction:5265/Arlene',
    'CLAIREMONT MESA: Combination building permit for existing one story SDU. Scope of work includes addition and convert an existing bedroom into a new Junior Accessory dwelling unit adding new bathroom, new kitchen, non-bearing walls, new doors and windows and re-roofing a section in the existing SDU..',
    'approval_type_not_building_work',
  ],
  [
    'Approval - Process - Agreement',
    'General-Express-Building Construction:2314/Harrison',
    'SOUTHEASTERN SAN DIEGO. Building, mechanical, plumbing & electrical permits to remove parapet, replace damaged northeast wall, replace damaged roof trusses & (N) MPE work at existing commercial building.',
    'approval_type_not_building_work',
  ],
  // A sidewalk closure so that someone else can fix a roof (approvals 1390716, 1607046).
  [
    'ROW Permit-Traffic Control',
    'Traffic control permit 65933',
    'Traffic Control Permit for parking lane closure and sidewalk closure for reroofing. Start Date: 11/17/2014 End Date: 11/25/2014',
    'approval_type_not_building_work',
  ],
  [
    'ROW Permit-Traffic Control',
    'Traffic Control Permit 69249',
    'Traffic Control Permit for: Parking Lane closure to assist with roof repair. Work only on 12/7 and 12/14 2015',
    'approval_type_not_building_work',
  ],
  // The approval type reported from the live site (629 J St, 2005), with a roof-structure scope.
  [
    'Encroachment Agreement',
    'EMRA',
    'EMRA for subterranean parking structure under ROW and extended Roof Structure.',
    'approval_type_not_building_work',
  ],
];

describe('classifyPermitRoofing: the approval type is checked before the text', () => {
  it.each(NOT_BUILDING_WORK)('%s / %s is not roofing work', (type, title, scope, expectedRule) => {
    expect(classifyPermitRoofing(type, title, scope)).toEqual({
      roofingClass: 'other',
      isRoofing: false,
      rule: expectedRule,
    });
  });

  it('leaves real building permits exactly as the text rules class them', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      [
        'Combination Building Permit',
        'Ruiz Roof Replacement',
        'Roof replacement at an existing single family residence.',
      ],
      [
        'Building Permit',
        'Modernaire Apts Roof Repair',
        'No Plan building permit for roof repair at several apartment buildings.',
      ],
      [
        'Combination Building Permit',
        'Cole Roof Structure',
        'REDO EXISTING FLAT ROOF TO PITCHED ROOF 1357SF',
      ],
      ['Residential Alteration-Addn', '', 'CROSS STREET: DURGIN DESCRIPTION OF WORK: REROOF'],
    ];
    for (const [type, title, scope] of cases) {
      expect(classifyPermitRoofing(type, title, scope)).toEqual(classifyRoofing(type, title, scope));
      expect(classifyPermitRoofing(type, title, scope).isRoofing).toBe(true);
    }
  });

  it('does not invent a rule for a non-roofing type that never mentions a roof', () => {
    expect(
      classifyPermitRoofing('Encroachment Agreement', 'Sidewalk cafe', 'Outdoor dining railing'),
    ).toEqual({
      roofingClass: 'other',
      isRoofing: false,
      rule: null,
    });
  });
});

/**
 * The second pass of live-site defects. Real rows, each [approval type, title, scope, class, rule].
 * `is_roofing` now needs a building-work type AND roofing evidence about the roof itself.
 */
const LIVE_DEFECTS: readonly (readonly [string | null, string, string, RoofingClass, string])[] = [
  // City 256673: a planning review that was first in the long-open roofing list.
  [
    'Substantial Conformance Review',
    'All Hollow Church SCR',
    'La Jolla, J.O.#42-5130. Substantial Conformance Review for amendments to approved Conditional Use Permit No. 8410, amendment to Conditional Use Permit No. C-2560, and Coastal Development Permit No. 8409, to remove courtyard structure from scope, modifications to roof structure',
    'other',
    'approval_type_not_building_work',
  ],
  // City PMT-2163994: a new restaurant shell; the roof is part of a new building.
  [
    'Building Permit',
    'General-Express- East Village Green Park',
    'To construct a commercial shell space (restaurant) atop a proposed parking structure. Work includes an integrated roof structure connected to the parking structure stair well and vent',
    'other',
    'roof_mention_unclassified',
  ],
  // A vent through the roof on a plumbing permit.
  [
    'Plumbing Permit',
    '5980 Fairmount Av Improvements',
    'For installing a gas line and mechanical vent connections to future coffee roaster. Vent to penetrate through roof structure',
    'other',
    'trade_permit_not_building_work',
  ],
  // City PMT-3255927: the Electrical Pmt of a project whose building permit is the roof repair.
  [
    'Electrical Pmt',
    'General-Express-Building Construction:1606/Fern',
    'Building permit for roof repair on an existing commercial building. HRB #: 1276, District Contributor #: 1276-NC CED# 0517517',
    'other',
    'trade_permit_not_building_work',
  ],
  // City PMT-3375246 and PMT-3337990: solar permits that mention the reroof they wait on.
  [
    'Photovoltaic - SB 379',
    '',
    'This is an uninstall/reinstall project uninstall/reinstall of 3 (E) POWERXT 360-PD SOLAR MODULE AFTER RE-ROOFING',
    'solar-on-roof',
    'solar_job_reroof_incidental',
  ],
  [
    'Photovoltaic - SB 379',
    '',
    'Removal and reinstall existing PV system to accommodate new roofing at existing location.',
    'solar-on-roof',
    'solar_job_reroof_incidental',
  ],
  // An addition whose new roof framing is incidental.
  [
    'Combination Building Permit',
    'Wolf Residence Addition',
    'New addition to single family residence. Includes new extension of den, new patio cover and roof framing.',
    'other',
    'roof_mention_unclassified',
  ],
  // A county new-building category: the roof-structure phrase describes the new building.
  [
    'New Primary Residential SFD-MH',
    '1010 - RES - New Primary Residential Structure',
    'Cross street: MARILLA Description of Work: *** BURN OUT*** REPAIR and MINOR REMODELING FOR FIRE DAMAGE ON EXISTING SFD as Follows: replacing 26x16 sub floor framing at Living Room; Repair 11 roof trusses;',
    'other',
    'new_construction_roof_incidental',
  ],
];

const STILL_ROOFING: readonly (readonly [string | null, string, string, RoofingClass, string])[] = [
  // The city files real reroofs under this "Mech/Elec/Plum" no-plan type (PMT-3277117).
  [
    'No-Plan - Residential - Combination Mech/Elec/Plum',
    '',
    'Re-roof - 32 squares like for like',
    'reroof',
    'reroof_explicit',
  ],
  // City PMT-3112859.
  [
    'Building Permit',
    'Rapid Review-Standard-Building Construction:3006/Beech',
    'For the proposed repair/replace in kind of roof framing due to fire damage at the (E) mixed use building.',
    'roof structural',
    'roof_structural',
  ],
  [
    'Residential Alteration-Addn',
    '',
    'CROSS STREET: VISTA GRANDE DESCRIPTION OF WORK: ROOF STRUCTURE REPLACEMENT OVER GARAGE/NEW DRYWALL INSIDE GARAGE',
    'roof structural',
    'roof_structural',
  ],
  [
    'Residential Alteration-Addn',
    '',
    'CROSS STREET: VIA DIEGO DESCRIPTION OF WORK: NEW ROOF STRUCTURE OVER EXISTING GARAGE FROM FLAT TO PITCHED',
    'roof structural',
    'roof_structural',
  ],
  // A real reroof filed under a county new-building category is kept.
  [
    'New Commercial Acc Structure',
    '',
    'CROSS STREET: KEEMO TERR DESCRIPTION OF WORK: RE-ROOF FROM SHAKE TO COMP SHING',
    'reroof',
    'reroof_explicit',
  ],
  // The cool-roof form names a shingle called "Landmark Solaris" and "solar reflectance": not a solar job.
  [
    'Commercial Alteration-Addn',
    '',
    'Cross street: RANCHWOOD DR Description of Work: 21,900 SQFT RE-ROOF (4 BUILDINGS) FOR EXISTING CONDO COMPLEX. Manufacturer: CERTAINTEED Brand and model: LANDMARK SOLARIS ESR-1389 Color (if cool roof required): solar reflectance 0.25',
    'reroof',
    'reroof_explicit',
  ],
];

describe('is_roofing needs a building-work type and evidence about the roof itself', () => {
  it.each(LIVE_DEFECTS)('not roofing: %s / %s', (type, title, scope, expectedClass, expectedRule) => {
    expect(classifyPermitRoofing(type, title, scope)).toEqual({
      roofingClass: expectedClass,
      isRoofing: false,
      rule: expectedRule,
    });
  });

  it.each(STILL_ROOFING)('roofing: %s / %s', (type, title, scope, expectedClass, expectedRule) => {
    expect(classifyPermitRoofing(type, title, scope)).toEqual({
      roofingClass: expectedClass,
      isRoofing: true,
      rule: expectedRule,
    });
  });

  it('refuses a type it does not recognise, and accepts a blank one', () => {
    expect(classifyPermitRoofing('Special Event Approval', '', 'Tent on roof repair area').isRoofing).toBe(
      false,
    );
    expect(classifyPermitRoofing(null, '', 'REROOF: LIFT & RELAY (E-REVIEW)').isRoofing).toBe(true);
  });
});

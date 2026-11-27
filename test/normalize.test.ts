import { describe, expect, it } from 'vitest';
import { normalizeClassifications } from '../src/adapters/cslbLicenses.js';
import { cityStatusGroup } from '../src/adapters/cityPermits.js';
import { countyStatusGroup } from '../src/adapters/countySocrata.js';
import {
  cityPermitHolder,
  coordinate,
  countyCoordinate,
  isoDatePart,
  normalizeApn,
  normalizeLicense,
  normalizeName,
  resolveMmddyy,
  resolveTransferDate,
  resolveTwoDigitYear,
  usDate,
  zip5,
} from '../src/normalize.js';

describe('normalizeApn', () => {
  it('reduces the dashed, spaced and plain forms to the same 10 digits', () => {
    expect(normalizeApn('498-320-16-00')).toBe('4983201600');
    expect(normalizeApn('498 320 16 00')).toBe('4983201600');
    expect(normalizeApn('4983201600')).toBe('4983201600');
  });
  it('refuses anything that is not 10 digits', () => {
    expect(normalizeApn('498-320-16')).toBeNull();
    expect(normalizeApn('N/A')).toBeNull();
    expect(normalizeApn('  ')).toBeNull();
    expect(normalizeApn(null)).toBeNull();
  });
});

describe('normalizeName', () => {
  it('gives one key to the spellings of one contractor', () => {
    expect(normalizeName('Cal Roof, Inc.')).toBe('CAL ROOF');
    expect(normalizeName('CAL ROOF INC')).toBe('CAL ROOF');
    expect(normalizeName('WALTER ANDERSON PLUMBING LLC')).toBe('WALTER ANDERSON PLUMBING');
    expect(normalizeName('Walter Anderson Plumbing, L.L.C.')).toBe('WALTER ANDERSON PLUMBING');
    expect(normalizeName('A & B Roofing Co.')).toBe('A AND B ROOFING');
  });
  it('keeps a name that is only a suffix word and returns null for blanks', () => {
    expect(normalizeName('COMPANY')).toBe('COMPANY');
    expect(normalizeName(' , ')).toBeNull();
  });
});

describe('normalizeLicense', () => {
  it('accepts CSLB numbers and drops leading zeros', () => {
    expect(normalizeLicense('1066575')).toBe('1066575');
    expect(normalizeLicense('0359625')).toBe('359625');
    expect(normalizeLicense('# 359625')).toBe('359625');
  });
  it('refuses non-licence text recorded in the licence field', () => {
    expect(normalizeLicense('22-PEOP-00023')).toBeNull();
    expect(normalizeLicense('OWNER')).toBeNull();
    expect(normalizeLicense('0')).toBeNull();
  });
});

describe('two-digit assessor years (reference year 2026)', () => {
  it('reads yy above the current yy as 19yy, with certainty', () => {
    expect(resolveTwoDigitYear('48', 2026)).toEqual({
      year: 1948,
      ambiguous: false,
      rule: 'yy_gt_current_19xx',
    });
    expect(resolveTwoDigitYear('27', 2026)).toEqual({
      year: 1927,
      ambiguous: false,
      rule: 'yy_gt_current_19xx',
    });
  });
  it('reads yy at or below the current yy as 20yy and flags it', () => {
    expect(resolveTwoDigitYear('13', 2026)).toEqual({
      year: 2013,
      ambiguous: true,
      rule: 'yy_le_current_assumed_20xx',
    });
    expect(resolveTwoDigitYear('26', 2026)).toEqual({
      year: 2026,
      ambiguous: true,
      rule: 'yy_le_current_assumed_20xx',
    });
    expect(resolveTwoDigitYear('00', 2026)).toEqual({
      year: 2000,
      ambiguous: true,
      rule: 'yy_00_assumed_2000',
    });
  });
  it('never invents a year', () => {
    expect(resolveTwoDigitYear('  ', 2026).year).toBeNull();
    expect(resolveTwoDigitYear('1948', 2026)).toEqual({ year: null, ambiguous: false, rule: 'unparseable' });
  });
});

describe('MMDDYY recorder dates (today 2026-11-25)', () => {
  const today = '2026-11-25';
  it('resolves the century and flags the ambiguous case', () => {
    expect(resolveMmddyy('013196', today)).toEqual({
      date: '1996-01-31',
      ambiguous: false,
      rule: 'yy_gt_current_19xx',
    });
    expect(resolveMmddyy('081713', today)).toEqual({
      date: '2013-08-17',
      ambiguous: true,
      rule: 'yy_le_current_assumed_20xx',
    });
  });
  it('will not place a transfer in the future', () => {
    expect(resolveMmddyy('122026', today)).toEqual({
      date: '1926-12-20',
      ambiguous: false,
      rule: 'future_as_20xx_so_19xx',
    });
  });
  it('rejects impossible dates instead of rolling them over', () => {
    expect(resolveMmddyy('023099', today).rule).toBe('unparseable');
    expect(resolveMmddyy('000000', today).rule).toBe('unparseable');
    expect(resolveMmddyy(null, today).rule).toBe('blank');
  });
});

describe('dates, coordinates and zips', () => {
  it('parses the date formats the sources use', () => {
    expect(isoDatePart('2025-11-20T00:00:00.000')).toBe('2025-11-20');
    expect(isoDatePart('1974-07-01 12:00:00')).toBe('1974-07-01');
    expect(isoDatePart('2025-02-30')).toBeNull();
    expect(usDate('01/10/2015')).toBe('2015-01-10');
    expect(usDate('13/10/2015')).toBeNull();
  });
  it('treats zero coordinates as missing', () => {
    expect(coordinate('0')).toBeNull();
    expect(coordinate('32.80628294')).toBeCloseTo(32.80628294);
    expect(coordinate('')).toBeNull();
  });
  it('keeps the 5-digit zip', () => {
    expect(zip5('92020-8306')).toBe('92020');
    expect(zip5('920208306')).toBe('92020');
    expect(zip5('CA')).toBeNull();
  });
});

describe('status groups: every status value the sources use maps to one group', () => {
  // Every distinct county status in the loaded data.
  it.each([
    ['Completed', 'completed'],
    ['Issued', 'open'],
    ['Issued About to Expire', 'open'],
    ['Issued in Plan Change', 'open'],
    ['Issued Expired', 'expired'],
    ['Issued Invalid Expired', 'expired'],
    ['PC Expired', 'expired'],
    ['PC Invalid Expired', 'expired'],
    ['Expired', 'expired'],
    // "Open" is an open application (3 of 1,450 have an issue date), and PC is plan check.
    ['Open', 'pending'],
    ['PC About to Expire', 'pending'],
    ['Withdrawn', 'cancelled'],
    [null, 'other'],
  ] as const)('county %s -> %s', (status, group) => {
    expect(countyStatusGroup(status)).toBe(group);
  });

  // Every distinct City of San Diego status in the loaded data.
  it.each([
    ['Completed', 'completed'],
    ['Closed', 'completed'],
    ['Final Closed', 'completed'],
    ['Finaled', 'completed'],
    ['Issued', 'open'],
    ['Inspection Followup', 'open'],
    ['Inspecting', 'open'],
    ['Cancelled', 'cancelled'],
    ['Canceled', 'cancelled'],
    ['Cancelled Application Expired', 'cancelled'],
    ['Cancelled Utilization Not Met', 'cancelled'],
    ['Withdrawn', 'cancelled'],
    ['Expired', 'expired'],
    ['Application Expired', 'expired'],
    // Reported from the live site: "Opened" (AGR-0003944, PMT-3329633) is an application, not an issued permit.
    ['Opened', 'pending'],
    ['Open', 'pending'],
    ['Created', 'pending'],
    ['Pending Invoice Payment', 'pending'],
    ['Approved Upon Final Payment', 'pending'],
    ['Recheck Required', 'pending'],
    ['Invoice Paid', 'pending'],
    ['All Fees Paid', 'pending'],
    ['Application Pending Payment', 'pending'],
    ['Agreement Processing', 'pending'],
    ['In Review', 'pending'],
    ['Resubmitted', 'pending'],
    ['Hearing Scheduled', 'pending'],
    ['Review Phase Complete', 'pending'],
    ['Updates Required', 'pending'],
    ['Revisions Required', 'pending'],
    ['In Queue', 'pending'],
    ['Ready for Issuance', 'pending'],
    ['Pre-Screen', 'pending'],
    ['In Progress', 'pending'],
    ['Issuance Checklist Submitted', 'pending'],
    ['Reviews Complete', 'pending'],
    ['Issuance Pending', 'pending'],
    ['Started', 'pending'],
    ['Final Version Signed Off', 'pending'],
    [null, 'other'],
  ] as const)('city %s -> %s', (status, group) => {
    expect(cityStatusGroup(status)).toBe(group);
  });
});

describe('CSLB classifications', () => {
  it('normalises spellings and finds C-39', () => {
    expect(normalizeClassifications('C-39')).toBe('C39');
    expect(normalizeClassifications('C39| B')).toBe('B|C39');
    expect(normalizeClassifications('')).toBeNull();
  });
});

describe('countyCoordinate: a bad geocode costs the coordinate, never the permit', () => {
  it('passes a coordinate inside the county through untouched', () => {
    expect(countyCoordinate(32.77124, -116.93181)).toEqual({ lat: 32.77124, lon: -116.93181, note: null });
    expect(countyCoordinate('32.80628294', '-117.1205532')).toEqual({
      lat: 32.80628294,
      lon: -117.1205532,
      note: null,
    });
  });
  it('nulls a coordinate outside the county and records what it was (real county-permit geocodes)', () => {
    // These two values are real: 105 and 46 county permits were geocoded to Texas and Pennsylvania.
    expect(countyCoordinate(33.1272, -96.87502)).toEqual({
      lat: null,
      lon: null,
      note: 'source coordinate outside San Diego County (33.1272, -96.87502); discarded',
    });
    expect(countyCoordinate(40.53515, -75.5815).note).toContain('(40.53515, -75.5815)');
  });
  it('treats blanks and zero placeholders as simply absent, with no note', () => {
    expect(countyCoordinate(null, undefined)).toEqual({ lat: null, lon: null, note: null });
    expect(countyCoordinate('0', '0')).toEqual({ lat: null, lon: null, note: null });
  });
  it('discards half a coordinate', () => {
    expect(countyCoordinate(32.7, null)).toEqual({
      lat: null,
      lon: null,
      note: 'source coordinate incomplete (32.7, null); discarded',
    });
  });
});

describe('resolveTransferDate: the century of a last-recorded document, three outcomes', () => {
  const today = '2026-11-25';
  const taxableTyped = { ownerOccupied: false, taxable: true, docType: '1' };

  it('is certain when the two digits allow only one century', () => {
    // Real: APN 4982604500, docdate 013196.
    expect(resolveTransferDate('013196', today, taxableTyped)).toEqual({
      date: '1996-01-31',
      confidence: 'certain',
      rule: 'yy_gt_current_19xx',
    });
    expect(resolveTransferDate('122026', today, taxableTyped)).toEqual({
      date: '1926-12-20',
      confidence: 'certain',
      rule: 'future_as_20xx_so_19xx',
    });
  });

  it('resolves an owner-occupied parcel to 20yy and names the rule', () => {
    // Real: APN 4982603900, docdate 081713, owner-occupied Y, doc type 3.
    expect(
      resolveTransferDate('081713', today, { ownerOccupied: true, taxable: true, docType: '3' }),
    ).toEqual({
      date: '2013-08-17',
      confidence: 'resolved',
      rule: 'owner_occupied_exemption_20xx',
    });
  });

  it('resolves a taxable parcel with a typed document to 20yy and names the rule', () => {
    expect(resolveTransferDate('062105', today, taxableTyped)).toEqual({
      date: '2005-06-21',
      confidence: 'resolved',
      rule: 'typed_document_on_taxable_parcel_20xx',
    });
  });

  it('leaves a tax-exempt parcel or an untyped document ambiguous, still dated and flagged', () => {
    expect(
      resolveTransferDate('062105', today, { ownerOccupied: false, taxable: false, docType: '1' }),
    ).toEqual({
      date: '2005-06-21',
      confidence: 'ambiguous',
      rule: 'yy_le_current_no_corroboration',
    });
    expect(
      resolveTransferDate('062105', today, { ownerOccupied: false, taxable: true, docType: null }).confidence,
    ).toBe('ambiguous');
  });

  it('gives no confidence where there is no date', () => {
    expect(resolveTransferDate('000000', today, taxableTyped)).toEqual({
      date: null,
      confidence: null,
      rule: 'unparseable',
    });
    expect(resolveTransferDate(null, today, taxableTyped).confidence).toBeNull();
  });
});

// Holder strings below are real values of APPROVAL_PERMIT_HOLDER in the City of San Diego files.
describe('cityPermitHolder', () => {
  it('keeps one copy when the firm is listed twice', () => {
    expect(cityPermitHolder('Elor Energy, Elor Energy')).toEqual({
      name: 'Elor Energy',
      nameNorm: 'ELOR ENERGY',
    });
    expect(cityPermitHolder('Crest Construction , Crest Construction')).toEqual({
      name: 'Crest Construction',
      nameNorm: 'CREST CONSTRUCTION',
    });
    expect(cityPermitHolder('SolarCity, SolarCity').nameNorm).toBe('SOLARCITY');
  });
  it('does not split on the comma before a legal form', () => {
    expect(cityPermitHolder('Haaland Builders Inc., Haaland Builders Inc.')).toEqual({
      name: 'Haaland Builders Inc.',
      nameNorm: 'HAALAND BUILDERS',
    });
    expect(cityPermitHolder('Lennar Homes of California, LLC')).toEqual({
      name: 'Lennar Homes of California, LLC',
      nameNorm: 'LENNAR HOMES OF CALIFORNIA',
    });
    expect(cityPermitHolder('Western Fire Protection, Inc, Western Fire Protection')).toEqual({
      name: 'Western Fire Protection, Inc',
      nameNorm: 'WESTERN FIRE PROTECTION',
    });
    expect(cityPermitHolder('Sunrun, Inc., Daniel Altman')).toEqual({
      name: 'Sunrun, Inc., Daniel Altman',
      nameNorm: 'SUNRUN',
    });
  });
  it('treats two spellings that normalise to the same name as one firm', () => {
    expect(cityPermitHolder('Symons Fire Protection Inc., Symons Fire Protection')).toEqual({
      name: 'Symons Fire Protection Inc.',
      nameNorm: 'SYMONS FIRE PROTECTION',
    });
  });
  it('keeps the text and matches on the firm when the second part is a contact person', () => {
    expect(cityPermitHolder('Johnson Controls, Jim Sevick')).toEqual({
      name: 'Johnson Controls, Jim Sevick',
      nameNorm: 'JOHNSON CONTROLS',
    });
    expect(cityPermitHolder('California Delta Mechanical , Matt Drivinghawk').nameNorm).toBe(
      'CALIFORNIA DELTA MECHANICAL',
    );
  });
  it('drops parts that carry no name', () => {
    expect(cityPermitHolder('Brookfield Homes, , Brookfield Homes')).toEqual({
      name: 'Brookfield Homes',
      nameNorm: 'BROOKFIELD HOMES',
    });
    expect(cityPermitHolder('WEST COAST APPLIANCE, ,,,,,,,,,,,,,,,,')).toEqual({
      name: 'WEST COAST APPLIANCE',
      nameNorm: 'WEST COAST APPLIANCE',
    });
  });
  it('leaves a name with three or more different parts as published', () => {
    const raw = 'West Coast Heating, Air Conditioning, & Solar';
    expect(cityPermitHolder(raw)).toEqual({ name: raw, nameNorm: normalizeName(raw) });
    const listed = 'ASI HEATING, AIR, & SOLAR, JESSE OBER';
    expect(cityPermitHolder(listed)).toEqual({ name: listed, nameNorm: normalizeName(listed) });
  });
  it('passes a plain name and an empty value through unchanged', () => {
    expect(cityPermitHolder('Baker Electric Solar')).toEqual({
      name: 'Baker Electric Solar',
      nameNorm: 'BAKER ELECTRIC SOLAR',
    });
    expect(cityPermitHolder('   ')).toEqual({ name: null, nameNorm: null });
    expect(cityPermitHolder(null)).toEqual({ name: null, nameNorm: null });
  });
});

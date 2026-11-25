import { z } from 'zod';

const num = z.coerce.number();
const numOrNull = z.coerce.number().nullable();
const text = z.string().nullable();
const optText = z.string().nullish();

export const tableCount = z.object({ table: z.string(), rows: num });

export const datasetInfoSchema = z.object({
  county: z.string(),
  asOf: z.string(),
  lastRunId: z.string().nullable(),
  counts: z.array(tableCount),
  sources: z.array(
    z.object({
      name: z.string(),
      url: text,
      rows: numOrNull,
      fetchedAt: optText,
      // Optional fields a later data run adds; read when present, never assumed.
      fetchedAtUtc: optText,
      sourceLastModified: optText,
      sourceUpdatedAt: optText,
      lastModified: optText,
      limits: text,
    }),
  ),
  manifestCid: z.string().nullable().optional(),
});
export type DatasetInfo = z.infer<typeof datasetInfoSchema>;

export const runSchema = z.object({
  run_id: num,
  started_at: text,
  finished_at: text,
  window_from: optText,
  window_to: optText,
  status: text,
  sources: optText,
  forced: z.boolean().nullish(),
  notes: optText,
});
export type PipelineRun = z.infer<typeof runSchema>;

export const runStatSchema = z.object({
  run_id: num,
  source_id: z.string(),
  entity: z.string(),
  fetched: numOrNull,
  rejected: numOrNull,
  duplicates: numOrNull.optional(),
  inserted: numOrNull,
  updated: numOrNull,
  unchanged: numOrNull,
  seconds: numOrNull.optional(),
  notes: optText,
});
export type RunStat = z.infer<typeof runStatSchema>;

export const pipelineRunsSchema = z.object({
  runs: z.array(runSchema),
  stats: z.array(runStatSchema),
});
export type PipelineRuns = z.infer<typeof pipelineRunsSchema>;

export const coverageSchema = z.object({
  county: z.string(),
  countySlug: z.string().optional(),
  fips: z.string().optional(),
  runId: num,
  asOf: z.string(),
  bbox: z.object({ minLat: num, maxLat: num, minLon: num, maxLon: num }).optional(),
  counts: z.array(tableCount),
  roofing: z.record(num).optional(),
  rejects: z
    .array(z.object({ source: z.string(), entity: z.string(), reason: z.string(), rows: num }))
    .default([]),
  limitations: z.array(z.string()).default([]),
});
export type Coverage = z.infer<typeof coverageSchema>;

export const leadRowSchema = z.object({
  apn: z.string(),
  address: text,
  unit: optText,
  city: text,
  zip: text,
  lat: num,
  lon: num,
  distanceMiles: num,
  roofYear: numOrNull,
  roofAgeYears: numOrNull,
  roofBasis: z.string(),
  roofConfidence: text,
  openRoofPermits: num,
  longestOpenDays: numOrNull,
  topOpenPermitId: text,
  topOpenContractor: text,
  topOpenLicenseNo: text,
  ownerOccupied: z.boolean().nullable(),
  lastTransferDate: text,
  useType: text,
});
export type LeadRow = z.infer<typeof leadRowSchema>;

export const leadSearchSchema = z.object({
  total: num,
  agedRoofCount: num,
  openPermitCount: num,
  asOf: z.string(),
  coverageNote: z.string().nullish(),
  coverage: z
    .array(z.object({ code: z.string(), name: z.string(), parcels: num, permitFeed: z.boolean() }))
    .optional(),
  rows: z.array(leadRowSchema),
});
export type LeadSearch = z.infer<typeof leadSearchSchema>;

const provenanceSchema = z.object({
  source: z.string(),
  sourceRecordId: text,
  sourceUrl: text,
  fetchedAt: text,
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const permitSchema = z.object({
  permitId: z.string(),
  permitType: text,
  roofingClass: text,
  isRoofing: z.boolean(),
  status: text,
  statusGroup: z.string().nullish(),
  isOpen: z.boolean(),
  appliedDate: text,
  issuedDate: text,
  closedDate: text,
  daysOpen: numOrNull,
  description: text,
  contractor: z
    .object({
      name: text,
      licenseNumber: text,
      licenseStatus: text,
      classifications: text,
      phone: text,
      bbbRating: text,
      bbbUrl: text,
      bbbNote: text,
    })
    .nullable(),
  provenance: provenanceSchema,
});
export type Permit = z.infer<typeof permitSchema>;

export const propertySchema = z.object({
  apn: z.string(),
  address: text,
  unit: optText,
  city: text,
  zip: text,
  lat: num,
  lon: num,
  yearBuilt: numOrNull,
  roofYear: numOrNull,
  roofAgeYears: numOrNull,
  roofBasis: z.string(),
  roofConfidence: text,
  useType: text,
  ownerOccupied: z.boolean().nullable(),
  ownerName: text,
  ownerMailing: text,
  lastTransferDate: text,
  yearsSinceTransfer: numOrNull,
  permits: z.array(permitSchema),
  provenance: provenanceSchema,
});
export type Property = z.infer<typeof propertySchema>;

export const queryResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.unknown())),
  rowCount: num,
  truncated: z.boolean(),
  sql: z.string().optional(),
});
export type QueryResult = z.infer<typeof queryResultSchema>;

export const manifestObjectSchema = z.object({
  name: z.string(),
  cid: z.string(),
  size: num,
  codec: z.string(),
  sha256: z.string().nullable(),
});
export type ManifestObject = z.infer<typeof manifestObjectSchema>;

export const pinSchema = z.object({
  provider: z.string(),
  cid: z.string().nullable(),
  ok: z.boolean(),
  detail: z.string(),
});
export type Pin = z.infer<typeof pinSchema>;

export const manifestSchema = z.object({
  schema: z.string().optional(),
  county: z.string().optional(),
  runId: num,
  createdAt: z.string(),
  rootCid: z.string(),
  previousRootCid: z.string().nullable().optional(),
  objects: z.array(manifestObjectSchema),
  car: z
    .object({ name: z.string(), size: num, sha256: z.string(), rootCid: z.string() })
    .nullable()
    .optional(),
  ipns: z.unknown().optional(),
  pins: z.array(pinSchema).default([]),
  gatewayPattern: z.string().optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const publicationSchema = z.object({
  runId: num,
  createdAt: z.string(),
  rootCid: z.string(),
  manifestCid: z.string().nullable().optional(),
  previousRootCid: z.string().nullable().optional(),
  objects: num.optional(),
  bytes: num.optional(),
  verifiedGateways: num.optional(),
});
export type Publication = z.infer<typeof publicationSchema>;

/** The history tool may answer with the index object or with the bare list of runs. */
export const publicationHistorySchema = z.union([
  z.array(publicationSchema),
  z.object({ runs: z.array(publicationSchema) }).transform((v) => v.runs),
]);

export const agentResponseSchema = z.object({
  answer: z.string(),
  assumptions: z.array(z.string()).default([]),
  evidence: z
    .array(
      z.object({
        tool: z.string(),
        sql: z.string().nullish(),
        rowCount: numOrNull.optional(),
        note: z.string().nullish(),
      }),
    )
    .default([]),
  rows: z.array(z.record(z.unknown())).default([]),
  points: z
    .array(z.object({ apn: z.string(), lat: num, lon: num, label: z.string().nullish() }))
    .default([]),
  model: z.string().nullish(),
  elapsedMs: numOrNull.optional(),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

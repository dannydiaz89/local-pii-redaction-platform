import { createHash } from 'node:crypto';

import {
  assertValidSpan,
  isNativeLocationV1,
  nativeLocationIdentity,
  parseSha256Digest,
  type DetectionEvidence,
  type EntityType,
  type NativeLocationV1,
  type Sha256Digest
} from '@local-pii/domain';

export interface ResolvedSpan {
  readonly id: string;
  readonly entityType: EntityType;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly nativeLocations?: readonly NativeLocationV1[];
}

export interface SpanConflict {
  readonly code: 'INCOMPATIBLE_OVERLAP';
  readonly evidenceIds: readonly string[];
  readonly start: number;
  readonly end: number;
}

export interface ResolutionSet {
  readonly extractionRevision: Sha256Digest;
  readonly algorithmVersion: '0.2.0';
  readonly digest: Sha256Digest;
  readonly spans: readonly ResolvedSpan[];
  readonly conflicts: readonly SpanConflict[];
  readonly suppressedEvidenceIds: readonly string[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, unknown>>)[key])}`
  ).join(',')}}`;
}

function normalizedLocations(
  locations: readonly NativeLocationV1[] | undefined
): readonly NativeLocationV1[] | undefined {
  if (locations === undefined) return undefined;
  if (!Array.isArray(locations) || locations.length === 0 || locations.length > 64) {
    throw new Error('Evidence native locations are invalid');
  }
  const identities = new Set<string>();
  const copied = locations.map((location) => {
    if (!isNativeLocationV1(location)) throw new Error('Evidence native locations are invalid');
    const identity = nativeLocationIdentity(location);
    if (identities.has(identity)) throw new Error('Evidence native locations are invalid');
    identities.add(identity);
    return Object.freeze({ ...location });
  });
  return Object.freeze(copied.sort((left, right) => {
    const leftIdentity = nativeLocationIdentity(left);
    const rightIdentity = nativeLocationIdentity(right);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  }));
}

function sameLocations(
  left: readonly NativeLocationV1[] | undefined,
  right: readonly NativeLocationV1[] | undefined
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.length === right.length
      && left.every((location, index) =>
        nativeLocationIdentity(location) === nativeLocationIdentity(right[index] as NativeLocationV1));
}

function frozenResolvedSpan(span: ResolvedSpan): Readonly<ResolvedSpan> {
  const base = {
    id: span.id,
    entityType: span.entityType,
    start: span.start,
    end: span.end,
    confidence: span.confidence,
    evidenceIds: Object.freeze([...span.evidenceIds])
  };
  const nativeLocations = normalizedLocations(span.nativeLocations);
  return nativeLocations === undefined
    ? Object.freeze(base)
    : Object.freeze({ ...base, nativeLocations });
}

function resolutionDigest(
  extractionRevision: Sha256Digest,
  evidence: readonly DetectionEvidence[],
  spans: readonly ResolvedSpan[],
  conflicts: readonly SpanConflict[],
  suppressedEvidenceIds: readonly string[]
): Sha256Digest {
  const evidenceSnapshot = [...evidence]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      entityType: item.entityType,
      span: {
        start: item.span.start,
        end: item.span.end,
        offsetUnit: item.span.offsetUnit,
        extractionRevision: item.span.extractionRevision
      },
      confidence: item.confidence,
      source: item.source,
      detector: {
        id: item.detector.id,
        version: item.detector.version,
        ...(item.detector.ruleId === undefined ? {} : { ruleId: item.detector.ruleId })
      },
      ...(item.nativeLocations === undefined
        ? {}
        : { nativeLocations: normalizedLocations(item.nativeLocations) })
    }));
  const canonical = canonicalJson({
    algorithmVersion: '0.2.0',
    extractionRevision,
    evidence: evidenceSnapshot,
    spans,
    conflicts,
    suppressedEvidenceIds
  });
  return parseSha256Digest(`sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`);
}

const precedence: Readonly<Partial<Record<EntityType, number>>> = {
  PASSWORD: 100,
  ACCESS_TOKEN: 100,
  API_KEY: 100,
  SSN: 90,
  CREDIT_CARD: 90,
  EMAIL: 70,
  IP_ADDRESS: 60,
  PHONE: 50
};

function priority(entityType: EntityType): number {
  return precedence[entityType] ?? 10;
}

function overlaps(left: ResolvedSpan, right: ResolvedSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function contains(outer: ResolvedSpan, inner: ResolvedSpan): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function groupEvidence(evidence: readonly DetectionEvidence[]): ResolvedSpan[] {
  const groups = new Map<string, DetectionEvidence[]>();
  for (const item of evidence) {
    const key = `${item.entityType}:${String(item.span.start)}:${String(item.span.end)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups.values()].map((unsortedGroup) => {
    const group = [...unsortedGroup].sort((left, right) => left.id.localeCompare(right.id));
    const first = group[0];
    if (first === undefined) throw new Error('Empty evidence group');
    const nativeLocations = normalizedLocations(first.nativeLocations);
    if (group.some((item) => !sameLocations(normalizedLocations(item.nativeLocations), nativeLocations))) {
      throw new Error('Supporting evidence native locations do not match');
    }
    return {
      id: `rsp_${first.id.replaceAll('-', '')}`,
      entityType: first.entityType,
      start: first.span.start,
      end: first.span.end,
      confidence: Math.max(...group.map((item) => item.confidence)),
      evidenceIds: group.map((item) => item.id).sort(),
      ...(nativeLocations === undefined ? {} : { nativeLocations })
    } satisfies ResolvedSpan;
  }).sort((left, right) =>
    priority(right.entityType) - priority(left.entityType)
      || left.start - right.start
      || right.end - left.end
      || left.entityType.localeCompare(right.entityType)
      || left.id.localeCompare(right.id)
  );
}

export function resolveEvidence(
  evidence: readonly DetectionEvidence[],
  extractionRevision: Sha256Digest,
  textLength: number
): ResolutionSet {
  for (const item of evidence) {
    if (item.span.extractionRevision !== extractionRevision) throw new Error('Evidence extraction revision mismatch');
    assertValidSpan(item.span, textLength);
  }

  const accepted: ResolvedSpan[] = [];
  const conflicts: SpanConflict[] = [];
  const suppressed = new Set<string>();

  for (const candidate of groupEvidence(evidence)) {
    const overlapping = accepted.filter((span) => overlaps(span, candidate));
    if (overlapping.length === 0) {
      accepted.push(candidate);
      continue;
    }

    const canSuppress = overlapping.every((span) =>
      priority(span.entityType) > priority(candidate.entityType) && contains(span, candidate)
    );
    if (canSuppress) {
      for (const id of candidate.evidenceIds) suppressed.add(id);
      continue;
    }

    const canReplace = overlapping.every((span) =>
      priority(candidate.entityType) > priority(span.entityType) && contains(candidate, span)
    );
    if (canReplace) {
      for (const span of overlapping) {
        accepted.splice(accepted.indexOf(span), 1);
        for (const id of span.evidenceIds) suppressed.add(id);
      }
      accepted.push(candidate);
      continue;
    }

    conflicts.push({
      code: 'INCOMPATIBLE_OVERLAP',
      evidenceIds: [...new Set([...candidate.evidenceIds, ...overlapping.flatMap((span) => span.evidenceIds)])].sort(),
      start: Math.min(candidate.start, ...overlapping.map((span) => span.start)),
      end: Math.max(candidate.end, ...overlapping.map((span) => span.end))
    });
  }

  accepted.sort((left, right) => left.start - right.start || right.end - left.end || left.entityType.localeCompare(right.entityType));
  conflicts.sort((left, right) => left.start - right.start || left.end - right.end);
  const suppressedEvidenceIds = [...suppressed].sort();
  const digest = resolutionDigest(extractionRevision, evidence, accepted, conflicts, suppressedEvidenceIds);
  return Object.freeze({
    extractionRevision,
    algorithmVersion: '0.2.0',
    digest,
    spans: Object.freeze(accepted.map(frozenResolvedSpan)),
    conflicts: Object.freeze(conflicts.map((conflict) => Object.freeze({
      ...conflict,
      evidenceIds: Object.freeze([...conflict.evidenceIds])
    }))),
    suppressedEvidenceIds: Object.freeze(suppressedEvidenceIds)
  });
}

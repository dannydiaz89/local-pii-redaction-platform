export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type ArtifactId = Brand<string, 'ArtifactId'>;
export type JobId = Brand<string, 'JobId'>;
export type DetectionId = Brand<string, 'DetectionId'>;
export type EventId = Brand<string, 'EventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
export type Sha256Digest = Brand<string, 'Sha256Digest'>;

const artifactIdPattern = /^art_[0-9A-HJKMNP-TV-Z]{26}$/u;
const jobIdPattern = /^job_[0-9A-HJKMNP-TV-Z]{26}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function parseBranded<Name extends string>(value: string, pattern: RegExp, label: Name): Brand<string, Name> {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`Invalid ${label}`);
  return value as Brand<string, Name>;
}

export const parseArtifactId = (value: string): ArtifactId => parseBranded(value, artifactIdPattern, 'ArtifactId');
export const parseJobId = (value: string): JobId => parseBranded(value, jobIdPattern, 'JobId');
export const parseDetectionId = (value: string): DetectionId => parseBranded(value, uuidPattern, 'DetectionId');
export const parseEventId = (value: string): EventId => parseBranded(value, uuidPattern, 'EventId');
export function parseCorrelationId(value: string): CorrelationId {
  const length = typeof value === 'string' ? Array.from(value).length : 0;
  if (typeof value !== 'string' || length < 8 || length > 128) {
    throw new TypeError('Invalid CorrelationId');
  }
  return value as CorrelationId;
}
export const parseSha256Digest = (value: string): Sha256Digest => parseBranded(value, digestPattern, 'Sha256Digest');

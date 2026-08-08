export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type ArtifactId = Brand<string, 'ArtifactId'>;
export type JobId = Brand<string, 'JobId'>;
export type Sha256Digest = Brand<string, 'Sha256Digest'>;

const artifactIdPattern = /^art_[0-9A-HJKMNP-TV-Z]{26}$/u;
const jobIdPattern = /^job_[0-9A-HJKMNP-TV-Z]{26}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function parseBranded<Name extends string>(value: string, pattern: RegExp, label: Name): Brand<string, Name> {
  if (!pattern.test(value)) throw new TypeError(`Invalid ${label}`);
  return value as Brand<string, Name>;
}

export const parseArtifactId = (value: string): ArtifactId => parseBranded(value, artifactIdPattern, 'ArtifactId');
export const parseJobId = (value: string): JobId => parseBranded(value, jobIdPattern, 'JobId');
export const parseSha256Digest = (value: string): Sha256Digest => parseBranded(value, digestPattern, 'Sha256Digest');

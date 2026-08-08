// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Declarative fail-closed transformation and verification policy with no executable content.
 */
export interface RedactionPolicy {
  schemaVersion: '1.0.0';
  id: string;
  version: string;
  riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  defaults: EntityRule;
  entities: {
    [k: string]: EntityRule;
  };
  verification: {
    profile: string;
    blockOnWarnings: boolean;
  };
  limits: {
    maximumInputBytes: number;
  };
}
/**
 * This interface was referenced by `RedactionPolicy`'s JSON-Schema
 * via the `definition` "entityRule".
 */
export interface EntityRule {
  action: 'REDACT' | 'TYPED_LABEL' | 'MASK' | 'PSEUDONYM' | 'HASHED_LABEL' | 'KEEP' | 'REQUIRE_REVIEW' | 'BLOCK';
  minimumConfidence: number;
  reviewBelow?: number;
  uncertainBehavior: 'REQUIRE_REVIEW' | 'BLOCK' | 'KEEP';
  residualBehavior?: 'BLOCK' | 'WARN';
  /**
   * @maxItems 32
   */
  requiredDetectors?: string[];
  requiredDetectorKinds?: ('REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL')[];
}

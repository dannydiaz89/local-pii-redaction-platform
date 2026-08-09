// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-safe machine output for listing and explaining bundled example policies.
 */
export type CLIPolicyInspectionReport = {
  [k: string]: unknown;
} & {
  schemaVersion: '1.0.0';
  operation: 'POLICY_LIST' | 'POLICY_EXPLAIN';
  /**
   * @minItems 1
   * @maxItems 32
   */
  policies?: [PolicySummary, ...PolicySummary[]];
  policy?: PolicySummary;
  capability?: {
    id: string;
    version: string;
    engineMode: 'RULES_ONLY' | 'LOCAL_HYBRID' | 'REMOTE';
  };
  satisfiable?: boolean;
  /**
   * @minItems 1
   * @maxItems 32
   */
  decisions?: [
    {
      code:
        | 'CAPABILITY_MANIFEST_VALID'
        | 'CONTRACT_VERSION_SUPPORTED'
        | 'ENGINE_MODE_SUPPORTED'
        | 'FORMAT_AVAILABLE'
        | 'OPERATION_SUPPORTED'
        | 'FORMAT_QUALIFICATION_SUFFICIENT'
        | 'ENTITY_DETECTOR_REQUIREMENTS_SATISFIED'
        | 'TRANSFORMATION_REQUIREMENTS_SATISFIED'
        | 'VERIFICATION_PROFILE_AVAILABLE'
        | 'INPUT_LIMIT_SUFFICIENT';
      available: boolean;
    },
    ...{
      code:
        | 'CAPABILITY_MANIFEST_VALID'
        | 'CONTRACT_VERSION_SUPPORTED'
        | 'ENGINE_MODE_SUPPORTED'
        | 'FORMAT_AVAILABLE'
        | 'OPERATION_SUPPORTED'
        | 'FORMAT_QUALIFICATION_SUFFICIENT'
        | 'ENTITY_DETECTOR_REQUIREMENTS_SATISFIED'
        | 'TRANSFORMATION_REQUIREMENTS_SATISFIED'
        | 'VERIFICATION_PROFILE_AVAILABLE'
        | 'INPUT_LIMIT_SUFFICIENT';
      available: boolean;
    }[]
  ];
};

/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "policySummary".
 */
export interface PolicySummary {
  id: string;
  version: string;
  digest: string;
  riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  example: true;
}

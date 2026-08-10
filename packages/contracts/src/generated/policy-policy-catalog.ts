// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Bounded privacy-safe catalog of pinned policies available to the local application.
 */
export interface PolicyCatalog {
  schemaVersion: '1.0.0';
  defaultPolicyId: string;
  /**
   * @minItems 1
   * @maxItems 32
   */
  policies: [
    {
      id: string;
      version: string;
      digest: string;
      riskTier: 'LOW' | 'MODERATE' | 'HIGH';
      example: boolean;
    },
    ...{
      id: string;
      version: string;
      digest: string;
      riskTier: 'LOW' | 'MODERATE' | 'HIGH';
      example: boolean;
    }[]
  ];
}

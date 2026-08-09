// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Initial versioned PII and secret entity taxonomy proposed by the reference catalog.
 */
export type EntityType =
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS'
  | 'LOCATION'
  | 'ORGANIZATION'
  | 'DATE_OF_BIRTH'
  | 'SSN'
  | 'NATIONAL_ID'
  | 'PASSPORT'
  | 'DRIVER_LICENSE'
  | 'CREDIT_CARD'
  | 'BANK_ACCOUNT'
  | 'ROUTING_NUMBER'
  | 'MEDICAL_RECORD'
  | 'HEALTH_PLAN_ID'
  | 'ACCOUNT_ID'
  | 'USERNAME'
  | 'IP_ADDRESS'
  | 'MAC_ADDRESS'
  | 'API_KEY'
  | 'ACCESS_TOKEN'
  | 'PASSWORD'
  | 'CUSTOM';

/**
 * Immutable ordered replacement instructions bound to exact input, resolution, capability, policy, detector, and writer provenance.
 */
export interface RedactionPlan {
  schemaVersion: '1.0.0';
  id: string;
  strategy: 'TYPED_LABEL';
  strategyVersion: string;
  inputDigest: string;
  extractionRevision: string;
  resolutionDigest: string;
  capabilityDigest: string;
  detectorBundleVersion: string;
  policy: {
    id: string;
    version: string;
    digest: string;
    riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  };
  writer: {
    id: string;
    version: string;
  };
  expectedActionCount: number;
  /**
   * @maxItems 100000
   */
  actions: {
    id: string;
    action: 'TYPED_LABEL';
    sourceSpanId: string;
    /**
     * @minItems 1
     */
    evidenceIds: [string, ...string[]];
    entityType: EntityType;
    start: number;
    end: number;
    replacement: string;
  }[];
  digest: string;
}

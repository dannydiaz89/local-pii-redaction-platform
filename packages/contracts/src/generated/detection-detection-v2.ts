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
 * A versioned value-free native location owned by a structured format adapter.
 */
export type NativeStructuredLocation =
  | {
      schemaVersion: '1.0.0';
      kind: 'JSON_POINTER';
      pointer: string;
    }
  | {
      schemaVersion: '1.0.0';
      kind: 'CSV_CELL';
      row: number;
      column: number;
    }
  | {
      schemaVersion: '1.0.0';
      kind: 'DOCX_PART';
      part: string;
      paragraph: number;
    };

/**
 * One value-free detector assertion anchored to an extraction revision and optional typed native locations.
 */
export interface DetectionEvidenceWithTypedNativeLocations {
  schemaVersion: '2.0.0';
  id: string;
  entityType: EntityType;
  span: {
    start: number;
    end: number;
    offsetUnit: 'UNICODE_CODE_POINT';
    extractionRevision: string;
  };
  confidence: number;
  source: 'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL';
  detector: {
    id: string;
    version: string;
    ruleId?: string;
  };
  /**
   * @minItems 1
   * @maxItems 64
   */
  nativeLocations?: [NativeStructuredLocation, ...NativeStructuredLocation[]];
  attributes?: {
    [k: string]: string | number | boolean;
  };
}

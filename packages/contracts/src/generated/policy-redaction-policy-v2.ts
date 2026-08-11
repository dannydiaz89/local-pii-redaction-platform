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
 * Declarative fail-closed transformation, verification, and exact structured-location policy with no executable content.
 */
export interface StructuredRedactionPolicy {
  schemaVersion: '2.0.0';
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
  structure?: {
    json?: {
      defaultMode: 'FREE_TEXT';
      /**
       * @maxItems 1000
       */
      rules: JsonRule[];
    };
    csv?: {
      delimiter: 'AUTO' | 'COMMA' | 'TAB' | 'SEMICOLON';
      header: 'NONE' | 'PRESENT';
      defaultMode: 'FREE_TEXT';
      /**
       * @maxItems 1000
       */
      columns: CsvColumnRule[];
    };
  };
}
/**
 * This interface was referenced by `StructuredRedactionPolicy`'s JSON-Schema
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
/**
 * This interface was referenced by `StructuredRedactionPolicy`'s JSON-Schema
 * via the `definition` "jsonRule".
 */
export interface JsonRule {
  id: string;
  pointer: string;
  mode: 'STRUCTURED';
  entityType: EntityType;
}
/**
 * This interface was referenced by `StructuredRedactionPolicy`'s JSON-Schema
 * via the `definition` "csvColumnRule".
 */
export interface CsvColumnRule {
  id: string;
  selector:
    | {
        index: number;
      }
    | {
        header: string;
      };
  mode: 'STRUCTURED';
  entityType: EntityType;
}

// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * This interface was referenced by `CapabilityManifest`'s JSON-Schema
 * via the `definition` "qualification".
 */
export type Qualification = 'EXPERIMENTAL' | 'DEVELOPMENT' | 'QUALIFIED';
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
 * This interface was referenced by `CapabilityManifest`'s JSON-Schema
 * via the `definition` "availability".
 */
export type Availability = 'AVAILABLE' | 'DISABLED' | 'UNAVAILABLE';

/**
 * Versioned deployment snapshot for format, detector, transformation, verification, and resource capabilities.
 */
export interface CapabilityManifest {
  schemaVersion: '1.0.0';
  id: string;
  version: string;
  engineMode: 'RULES_ONLY' | 'LOCAL_HYBRID' | 'REMOTE';
  /**
   * @minItems 1
   * @maxItems 16
   */
  supportedContractVersions:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  /**
   * @minItems 1
   * @maxItems 32
   */
  formats: [FormatCapability, ...FormatCapability[]];
  /**
   * @minItems 1
   * @maxItems 128
   */
  detectors: [DetectorCapability, ...DetectorCapability[]];
  /**
   * @minItems 1
   * @maxItems 32
   */
  transformations: [TransformationCapability, ...TransformationCapability[]];
  /**
   * @minItems 1
   * @maxItems 32
   */
  verificationProfiles: [VerificationCapability, ...VerificationCapability[]];
  limits: {
    maximumInputBytes: number;
    maximumCanonicalCodePoints: number;
    maximumDetections: number;
  };
}
/**
 * This interface was referenced by `CapabilityManifest`'s JSON-Schema
 * via the `definition` "formatCapability".
 */
export interface FormatCapability {
  id: string;
  adapter: string;
  version: string;
  /**
   * @minItems 1
   * @maxItems 16
   */
  mediaTypes:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  /**
   * @minItems 1
   * @maxItems 16
   */
  extensions:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  /**
   * @minItems 1
   */
  operations: [
    'PROBE' | 'INSPECT' | 'EXTRACT' | 'SCAN' | 'REDACT' | 'VERIFY',
    ...('PROBE' | 'INSPECT' | 'EXTRACT' | 'SCAN' | 'REDACT' | 'VERIFY')[]
  ];
  assurance: 'EXTRACT_ONLY' | 'STRUCTURAL_REPLACE' | 'NATIVE_REDACTION' | 'RASTERIZED_REDACTION';
  qualification: Qualification;
  /**
   * @minItems 1
   * @maxItems 128
   */
  features: [
    {
      id: string;
      status: 'SUPPORTED' | 'EXPERIMENTAL' | 'BLOCKED' | 'UNSUPPORTED';
    },
    ...{
      id: string;
      status: 'SUPPORTED' | 'EXPERIMENTAL' | 'BLOCKED' | 'UNSUPPORTED';
    }[]
  ];
  /**
   * @minItems 1
   * @maxItems 32
   */
  verificationProfiles: [string, ...string[]];
  limits: {
    maximumInputBytes: number;
  };
}
/**
 * This interface was referenced by `CapabilityManifest`'s JSON-Schema
 * via the `definition` "detectorCapability".
 */
export interface DetectorCapability {
  id: string;
  version: string;
  /**
   * @minItems 1
   */
  kinds: [
    'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL',
    ...('REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL')[]
  ];
  /**
   * @minItems 1
   * @maxItems 24
   */
  entityTypes: [EntityType, ...EntityType[]];
  /**
   * @minItems 1
   * @maxItems 64
   */
  languages: [string, ...string[]];
  availability: Availability;
  qualification: Qualification;
}
/**
 * This interface was referenced by `CapabilityManifest`'s JSON-Schema
 * via the `definition` "transformationCapability".
 */
export interface TransformationCapability {
  id: string;
  version: string;
  action: 'REDACT' | 'TYPED_LABEL' | 'MASK' | 'PSEUDONYM' | 'HASHED_LABEL';
  reversible: boolean;
  availability: Availability;
  qualification: Qualification;
}
/**
 * This interface was referenced by `CapabilityManifest`'s JSON-Schema
 * via the `definition` "verificationCapability".
 */
export interface VerificationCapability {
  id: string;
  version: string;
  /**
   * @minItems 1
   * @maxItems 32
   */
  formats: [string, ...string[]];
  /**
   * @minItems 1
   * @maxItems 100
   */
  checks: [string, ...string[]];
  availability: Availability;
  qualification: Qualification;
}

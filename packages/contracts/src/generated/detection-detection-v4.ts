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
 * An append-only, value-free native location. PDF text-item coordinates identify only bounded structural ordinals and never contain extracted glyph values.
 */
export type NativeStructuredLocationV3 =
  | NativeStructuredLocationV2
  | {
      schemaVersion: '3.0.0';
      kind: 'PDF_TEXT_ITEM';
      page: number;
      pageObject: number;
      contentObject: number;
      fontObject: number;
      textItem: number;
      glyphCount: number;
    };
/**
 * An append-only, value-free native location. DOCX XML carrier metadata never contains the carrier value.
 */
export type NativeStructuredLocationV2 =
  | NativeStructuredLocation
  | {
      schemaVersion: '2.0.0';
      kind: 'DOCX_RELATIONSHIP';
      sourcePart: string;
      relationshipId: string;
      field: 'TARGET';
    }
  | {
      schemaVersion: '2.0.0';
      kind: 'DOCX_XML_VALUE';
      part: string;
      element: string;
      elementOrdinal: number;
      carrier: 'TEXT';
    }
  | {
      schemaVersion: '2.0.0';
      kind: 'DOCX_XML_VALUE';
      part: string;
      element: string;
      elementOrdinal: number;
      carrier: 'ATTRIBUTE';
      attribute: string;
    };
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
 * One value-free detector assertion anchored to an extraction revision and optional append-only typed native locations.
 */
export interface DetectionEvidenceWithPDFTextItemLocations {
  schemaVersion: '4.0.0';
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
  nativeLocations?: [NativeStructuredLocationV3, ...NativeStructuredLocationV3[]];
  attributes?: {
    [k: string]: string | number | boolean;
  };
}

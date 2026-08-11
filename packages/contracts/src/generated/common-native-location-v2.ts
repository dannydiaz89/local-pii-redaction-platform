// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

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

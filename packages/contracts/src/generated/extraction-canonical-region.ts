// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * One canonical Unicode code-point region and its exact native structured location.
 */
export type CanonicalStructuredRegion = {
  [k: string]: unknown;
} & {
  schemaVersion: '1.0.0';
  start: number;
  end: number;
  offsetUnit: 'UNICODE_CODE_POINT';
  role: 'VALUE';
  location: NativeStructuredLocation;
  selector?: {
    csvHeader: string;
  };
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

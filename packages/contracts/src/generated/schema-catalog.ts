// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

export const schemaCatalog = [
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/artifacts/artifact/1.0.0",
    "title": "Artifact",
    "description": "Immutable input or derived artifact metadata without a storage locator.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "kind",
      "mediaType",
      "byteLength",
      "digest",
      "displayName",
      "publicationState",
      "createdAt"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "id": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/ArtifactId"
      },
      "kind": {
        "enum": [
          "INPUT",
          "SANITIZED_OUTPUT",
          "REPORT",
          "PREVIEW",
          "QUARANTINED"
        ]
      },
      "mediaType": {
        "type": "string",
        "minLength": 3,
        "maxLength": 127,
        "pattern": "^[a-z0-9.+-]+/[a-z0-9.+-]+$"
      },
      "byteLength": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1073741824
      },
      "digest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 255
      },
      "publicationState": {
        "enum": [
          "STAGED",
          "IMMUTABLE",
          "QUARANTINED",
          "PUBLISHABLE",
          "EXPIRED",
          "DELETING",
          "DELETED"
        ]
      },
      "createdAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      },
      "expiresAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "id": "art_01J4M8Z7QK2C5B6TFXDA9R4M3V",
        "kind": "INPUT",
        "mediaType": "text/plain",
        "byteLength": 42,
        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "displayName": "synthetic.txt",
        "publicationState": "IMMUTABLE",
        "createdAt": "2026-08-08T18:00:00Z"
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/audit/audit-summary/1.0.0",
    "title": "Audit summary",
    "description": "Privacy-minimized processing provenance and bounded aggregate counts.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "jobId",
      "operation",
      "outcome",
      "policy",
      "componentVersions",
      "counts",
      "createdAt",
      "completedAt"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "jobId": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/JobId"
      },
      "operation": {
        "enum": [
          "SCAN",
          "REDACT",
          "VERIFY",
          "INSPECT"
        ]
      },
      "outcome": {
        "enum": [
          "VERIFIED",
          "SUCCEEDED",
          "FAILED",
          "CANCELLED"
        ]
      },
      "policy": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          }
        }
      },
      "componentVersions": {
        "type": "object",
        "minProperties": 1,
        "maxProperties": 32,
        "additionalProperties": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        }
      },
      "counts": {
        "type": "object",
        "maxProperties": 64,
        "additionalProperties": {
          "type": "integer",
          "minimum": 0
        }
      },
      "createdAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      },
      "completedAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "jobId": "job_01J4M91NJK8WAPJ7J95K73CB2M",
        "operation": "SCAN",
        "outcome": "SUCCEEDED",
        "policy": {
          "id": "development-labels",
          "version": "0.1.0",
          "digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        },
        "componentVersions": {
          "contracts": "0.1.0",
          "detectorBundle": "0.1.0"
        },
        "counts": {
          "detections": 2
        },
        "createdAt": "2026-08-08T18:00:00Z",
        "completedAt": "2026-08-08T18:01:00Z"
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/capabilities/capability-manifest/1.0.0",
    "title": "Capability manifest",
    "description": "Versioned deployment snapshot for format, detector, transformation, verification, and resource capabilities.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "version",
      "engineMode",
      "supportedContractVersions",
      "formats",
      "detectors",
      "transformations",
      "verificationProfiles",
      "limits"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "id": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]{2,63}$"
      },
      "version": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
      },
      "engineMode": {
        "enum": [
          "RULES_ONLY",
          "LOCAL_HYBRID",
          "REMOTE"
        ]
      },
      "supportedContractVersions": {
        "type": "array",
        "minItems": 1,
        "maxItems": 16,
        "uniqueItems": true,
        "items": {
          "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
        }
      },
      "formats": {
        "type": "array",
        "minItems": 1,
        "maxItems": 32,
        "items": {
          "$ref": "#/$defs/formatCapability"
        }
      },
      "detectors": {
        "type": "array",
        "minItems": 1,
        "maxItems": 128,
        "items": {
          "$ref": "#/$defs/detectorCapability"
        }
      },
      "transformations": {
        "type": "array",
        "minItems": 1,
        "maxItems": 32,
        "items": {
          "$ref": "#/$defs/transformationCapability"
        }
      },
      "verificationProfiles": {
        "type": "array",
        "minItems": 1,
        "maxItems": 32,
        "items": {
          "$ref": "#/$defs/verificationCapability"
        }
      },
      "limits": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "maximumInputBytes",
          "maximumCanonicalCodePoints",
          "maximumDetections"
        ],
        "properties": {
          "maximumInputBytes": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1073741824
          },
          "maximumCanonicalCodePoints": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100000000
          },
          "maximumDetections": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1000000
          }
        }
      }
    },
    "$defs": {
      "qualification": {
        "enum": [
          "EXPERIMENTAL",
          "DEVELOPMENT",
          "QUALIFIED"
        ]
      },
      "availability": {
        "enum": [
          "AVAILABLE",
          "DISABLED",
          "UNAVAILABLE"
        ]
      },
      "formatCapability": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "adapter",
          "version",
          "mediaTypes",
          "extensions",
          "operations",
          "assurance",
          "qualification",
          "features",
          "verificationProfiles",
          "limits"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{1,31}$"
          },
          "adapter": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{1,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "mediaTypes": {
            "type": "array",
            "minItems": 1,
            "maxItems": 16,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "pattern": "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$"
            }
          },
          "extensions": {
            "type": "array",
            "minItems": 1,
            "maxItems": 16,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "pattern": "^\\.[a-z0-9][a-z0-9._-]{0,15}$"
            }
          },
          "operations": {
            "type": "array",
            "minItems": 1,
            "uniqueItems": true,
            "items": {
              "enum": [
                "PROBE",
                "INSPECT",
                "EXTRACT",
                "SCAN",
                "REDACT",
                "VERIFY"
              ]
            }
          },
          "assurance": {
            "enum": [
              "EXTRACT_ONLY",
              "STRUCTURAL_REPLACE",
              "NATIVE_REDACTION",
              "RASTERIZED_REDACTION"
            ]
          },
          "qualification": {
            "$ref": "#/$defs/qualification"
          },
          "features": {
            "type": "array",
            "minItems": 1,
            "maxItems": 128,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "id",
                "status"
              ],
              "properties": {
                "id": {
                  "type": "string",
                  "pattern": "^[a-z][a-z0-9-]{1,63}$"
                },
                "status": {
                  "enum": [
                    "SUPPORTED",
                    "EXPERIMENTAL",
                    "BLOCKED",
                    "UNSUPPORTED"
                  ]
                }
              }
            }
          },
          "verificationProfiles": {
            "type": "array",
            "minItems": 1,
            "maxItems": 32,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]{2,63}$"
            }
          },
          "limits": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "maximumInputBytes"
            ],
            "properties": {
              "maximumInputBytes": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1073741824
              }
            }
          }
        }
      },
      "detectorCapability": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "kinds",
          "entityTypes",
          "languages",
          "availability",
          "qualification"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,99}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "kinds": {
            "type": "array",
            "minItems": 1,
            "uniqueItems": true,
            "items": {
              "enum": [
                "REGEX",
                "CHECKSUM",
                "STRUCTURED",
                "DICTIONARY",
                "MODEL"
              ]
            }
          },
          "entityTypes": {
            "type": "array",
            "minItems": 1,
            "maxItems": 24,
            "uniqueItems": true,
            "items": {
              "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
            }
          },
          "languages": {
            "type": "array",
            "minItems": 1,
            "maxItems": 64,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "pattern": "^[a-z]{2,3}(?:-[A-Z]{2})?$"
            }
          },
          "availability": {
            "$ref": "#/$defs/availability"
          },
          "qualification": {
            "$ref": "#/$defs/qualification"
          }
        }
      },
      "transformationCapability": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "action",
          "reversible",
          "availability",
          "qualification"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "action": {
            "enum": [
              "REDACT",
              "TYPED_LABEL",
              "MASK",
              "PSEUDONYM",
              "HASHED_LABEL"
            ]
          },
          "reversible": {
            "type": "boolean"
          },
          "availability": {
            "$ref": "#/$defs/availability"
          },
          "qualification": {
            "$ref": "#/$defs/qualification"
          }
        }
      },
      "verificationCapability": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "formats",
          "checks",
          "availability",
          "qualification"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "formats": {
            "type": "array",
            "minItems": 1,
            "maxItems": 32,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]{1,31}$"
            }
          },
          "checks": {
            "type": "array",
            "minItems": 1,
            "maxItems": 100,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "pattern": "^[A-Z][A-Z0-9_]{2,63}$"
            }
          },
          "availability": {
            "$ref": "#/$defs/availability"
          },
          "qualification": {
            "$ref": "#/$defs/qualification"
          }
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "id": "local-rules-text",
        "version": "0.1.0",
        "engineMode": "RULES_ONLY",
        "supportedContractVersions": [
          "1.0.0"
        ],
        "formats": [
          {
            "id": "text",
            "adapter": "text-adapter",
            "version": "0.1.0",
            "mediaTypes": [
              "text/plain",
              "text/markdown"
            ],
            "extensions": [
              ".txt",
              ".md",
              ".markdown"
            ],
            "operations": [
              "PROBE",
              "INSPECT",
              "EXTRACT",
              "SCAN",
              "REDACT",
              "VERIFY"
            ],
            "assurance": "NATIVE_REDACTION",
            "qualification": "DEVELOPMENT",
            "features": [
              {
                "id": "utf-8",
                "status": "SUPPORTED"
              },
              {
                "id": "symbolic-links",
                "status": "BLOCKED"
              }
            ],
            "verificationProfiles": [
              "text-rescan-v1"
            ],
            "limits": {
              "maximumInputBytes": 104857600
            }
          }
        ],
        "detectors": [
          {
            "id": "email-pattern",
            "version": "0.1.0",
            "kinds": [
              "REGEX"
            ],
            "entityTypes": [
              "EMAIL"
            ],
            "languages": [
              "und"
            ],
            "availability": "AVAILABLE",
            "qualification": "DEVELOPMENT"
          }
        ],
        "transformations": [
          {
            "id": "typed-label",
            "version": "0.1.0",
            "action": "TYPED_LABEL",
            "reversible": false,
            "availability": "AVAILABLE",
            "qualification": "DEVELOPMENT"
          }
        ],
        "verificationProfiles": [
          {
            "id": "text-rescan-v1",
            "version": "0.1.0",
            "formats": [
              "text"
            ],
            "checks": [
              "UTF8_REOPEN",
              "DETERMINISTIC_RESCAN",
              "SPAN_RESOLUTION"
            ],
            "availability": "AVAILABLE",
            "qualification": "DEVELOPMENT"
          }
        ],
        "limits": {
          "maximumInputBytes": 104857600,
          "maximumCanonicalCodePoints": 10000000,
          "maximumDetections": 10000
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/cli/cli-report/1.0.0",
    "title": "CLI operation report",
    "description": "Privacy-minimized machine output for local scan, redact, verify, and inspect commands.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "operation",
      "outcome"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "operation": {
        "enum": [
          "SCAN",
          "REDACT",
          "VERIFY",
          "INSPECT"
        ]
      },
      "outcome": {
        "enum": [
          "SUCCEEDED",
          "NEEDS_REVIEW",
          "VERIFIED",
          "PASS",
          "FAIL"
        ]
      },
      "input": {
        "$ref": "#/$defs/artifactSummary"
      },
      "output": {
        "$ref": "#/$defs/artifactSummary"
      },
      "artifact": {
        "$ref": "#/$defs/artifactSummary"
      },
      "policy": {
        "$ref": "#/$defs/policySummary"
      },
      "detectorBundleVersion": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "counts": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "detections",
          "conflicts",
          "byEntity"
        ],
        "properties": {
          "detections": {
            "type": "integer",
            "minimum": 0
          },
          "conflicts": {
            "type": "integer",
            "minimum": 0
          },
          "byEntity": {
            "type": "object",
            "propertyNames": {
              "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
            },
            "additionalProperties": {
              "type": "integer",
              "minimum": 1
            }
          }
        }
      },
      "detections": {
        "type": "array",
        "maxItems": 10000,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "entityType",
            "start",
            "end",
            "confidence",
            "evidenceIds"
          ],
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^rsp_[a-f0-9]{32}$"
            },
            "entityType": {
              "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
            },
            "start": {
              "type": "integer",
              "minimum": 0
            },
            "end": {
              "type": "integer",
              "minimum": 1
            },
            "confidence": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "evidenceIds": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string",
                "format": "uuid"
              },
              "uniqueItems": true
            }
          }
        }
      },
      "conflicts": {
        "type": "array",
        "maxItems": 10000,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "code",
            "evidenceIds",
            "start",
            "end"
          ],
          "properties": {
            "code": {
              "const": "INCOMPATIBLE_OVERLAP"
            },
            "evidenceIds": {
              "type": "array",
              "minItems": 2,
              "items": {
                "type": "string",
                "format": "uuid"
              },
              "uniqueItems": true
            },
            "start": {
              "type": "integer",
              "minimum": 0
            },
            "end": {
              "type": "integer",
              "minimum": 1
            }
          }
        }
      },
      "plan": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "digest",
          "inputDigest",
          "extractionRevision",
          "resolutionDigest",
          "capabilityDigest",
          "policyDigest",
          "detectorBundleVersion",
          "writer",
          "strategy",
          "strategyVersion",
          "actionCount",
          "byEntity"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^plan_[0-9A-HJKMNP-TV-Z]{26}$"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "inputDigest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "extractionRevision": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "resolutionDigest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "capabilityDigest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "policyDigest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "detectorBundleVersion": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "writer": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "version"
            ],
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9-]{2,63}$"
              },
              "version": {
                "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
              }
            }
          },
          "strategy": {
            "const": "TYPED_LABEL"
          },
          "strategyVersion": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "actionCount": {
            "type": "integer",
            "minimum": 0
          },
          "byEntity": {
            "type": "object",
            "propertyNames": {
              "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
            },
            "additionalProperties": {
              "type": "integer",
              "minimum": 1
            }
          }
        }
      },
      "writerReceipt": {
        "$ref": "#/$defs/writerReceiptSummary"
      },
      "verification": {
        "$ref": "#/$defs/verification"
      },
      "capability": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "adapter",
          "version",
          "operations"
        ],
        "properties": {
          "adapter": {
            "const": "text"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "operations": {
            "type": "array",
            "items": {
              "enum": [
                "SCAN",
                "REDACT",
                "VERIFY",
                "INSPECT"
              ]
            },
            "uniqueItems": true
          }
        }
      }
    },
    "$defs": {
      "policySummary": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest",
          "riskTier",
          "example"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "riskTier": {
            "enum": [
              "LOW",
              "MODERATE",
              "HIGH"
            ]
          },
          "example": {
            "const": true
          }
        }
      },
      "artifactSummary": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "byteLength",
          "digest"
        ],
        "properties": {
          "displayName": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255
          },
          "mediaType": {
            "enum": [
              "text/plain",
              "text/markdown"
            ]
          },
          "byteLength": {
            "type": "integer",
            "minimum": 0
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "extractionRevision": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "unicodeCodePoints": {
            "type": "integer",
            "minimum": 0
          },
          "hasUtf8Bom": {
            "type": "boolean"
          }
        }
      },
      "writerReceiptSummary": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "receiptDigest",
          "planDigest",
          "outputDigest",
          "writer",
          "expectedActionCount",
          "appliedActionCount"
        ],
        "properties": {
          "receiptDigest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "planDigest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "outputDigest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "writer": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "version"
            ],
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9-]{2,63}$"
              },
              "version": {
                "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
              }
            }
          },
          "expectedActionCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100000
          },
          "appliedActionCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100000
          }
        }
      },
      "verification": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schemaVersion",
          "profile",
          "outcome",
          "detectorBundleVersion",
          "checks",
          "findings"
        ],
        "properties": {
          "schemaVersion": {
            "const": "1.0.0"
          },
          "profile": {
            "const": "text-rescan-v1"
          },
          "outcome": {
            "enum": [
              "PASS",
              "FAIL"
            ]
          },
          "detectorBundleVersion": {
            "type": "string",
            "minLength": 1
          },
          "checks": {
            "type": "array",
            "items": {
              "enum": [
                "UTF8_REOPEN",
                "DETERMINISTIC_RESCAN",
                "SPAN_RESOLUTION"
              ]
            },
            "minItems": 3,
            "uniqueItems": true
          },
          "findings": {
            "type": "array",
            "maxItems": 10000,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "code",
                "severity",
                "blocking"
              ],
              "properties": {
                "code": {
                  "enum": [
                    "RESIDUAL_DETECTION",
                    "SPAN_CONFLICT"
                  ]
                },
                "severity": {
                  "const": "ERROR"
                },
                "blocking": {
                  "const": true
                },
                "entityType": {
                  "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
                },
                "start": {
                  "type": "integer",
                  "minimum": 0
                },
                "end": {
                  "type": "integer",
                  "minimum": 1
                }
              }
            }
          }
        }
      }
    },
    "allOf": [
      {
        "if": {
          "properties": {
            "operation": {
              "const": "SCAN"
            }
          }
        },
        "then": {
          "properties": {
            "input": true,
            "policy": false,
            "writerReceipt": false,
            "detectorBundleVersion": true,
            "counts": true,
            "detections": true,
            "conflicts": true
          },
          "required": [
            "input",
            "detectorBundleVersion",
            "counts",
            "detections",
            "conflicts"
          ]
        }
      },
      {
        "if": {
          "properties": {
            "operation": {
              "const": "REDACT"
            }
          }
        },
        "then": {
          "properties": {
            "input": true,
            "output": true,
            "policy": true,
            "plan": true,
            "writerReceipt": true,
            "verification": true
          },
          "required": [
            "input",
            "output",
            "policy",
            "plan",
            "writerReceipt",
            "verification"
          ]
        }
      },
      {
        "if": {
          "properties": {
            "operation": {
              "const": "VERIFY"
            }
          }
        },
        "then": {
          "properties": {
            "artifact": true,
            "policy": false,
            "writerReceipt": false,
            "verification": true
          },
          "required": [
            "artifact",
            "verification"
          ]
        }
      },
      {
        "if": {
          "properties": {
            "operation": {
              "const": "INSPECT"
            }
          }
        },
        "then": {
          "properties": {
            "artifact": true,
            "policy": false,
            "writerReceipt": false,
            "capability": true
          },
          "required": [
            "artifact",
            "capability"
          ]
        }
      }
    ],
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "operation": "SCAN",
        "outcome": "SUCCEEDED",
        "input": {
          "displayName": "synthetic.txt",
          "mediaType": "text/plain",
          "byteLength": 18,
          "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "detectorBundleVersion": "0.1.0",
        "counts": {
          "detections": 0,
          "conflicts": 0,
          "byEntity": {}
        },
        "detections": [],
        "conflicts": []
      },
      {
        "schemaVersion": "1.0.0",
        "operation": "REDACT",
        "outcome": "VERIFIED",
        "input": {
          "byteLength": 18,
          "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "output": {
          "byteLength": 9,
          "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        "policy": {
          "id": "development-labels",
          "version": "0.1.0",
          "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "riskTier": "LOW",
          "example": true
        },
        "plan": {
          "id": "plan_01J4M8Z7QK2C5B6TFXDA9R4M3V",
          "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "inputDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "extractionRevision": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "resolutionDigest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          "capabilityDigest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "policyDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "detectorBundleVersion": "0.1.0",
          "writer": {
            "id": "text-adapter",
            "version": "0.1.0"
          },
          "strategy": "TYPED_LABEL",
          "strategyVersion": "0.1.0",
          "actionCount": 0,
          "byEntity": {}
        },
        "writerReceipt": {
          "receiptDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "planDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "outputDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "writer": {
            "id": "text-adapter",
            "version": "0.1.0"
          },
          "expectedActionCount": 0,
          "appliedActionCount": 0
        },
        "verification": {
          "schemaVersion": "1.0.0",
          "profile": "text-rescan-v1",
          "outcome": "PASS",
          "detectorBundleVersion": "0.1.0",
          "checks": [
            "UTF8_REOPEN",
            "DETERMINISTIC_RESCAN",
            "SPAN_RESOLUTION"
          ],
          "findings": []
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/cli/policy-report/1.0.0",
    "title": "CLI policy inspection report",
    "description": "Privacy-safe machine output for listing and explaining bundled example policies.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "operation"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "operation": {
        "enum": [
          "POLICY_LIST",
          "POLICY_EXPLAIN"
        ]
      },
      "policies": {
        "type": "array",
        "minItems": 1,
        "maxItems": 32,
        "items": {
          "$ref": "#/$defs/policySummary"
        }
      },
      "policy": {
        "$ref": "#/$defs/policySummary"
      },
      "capability": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "engineMode"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "engineMode": {
            "enum": [
              "RULES_ONLY",
              "LOCAL_HYBRID",
              "REMOTE"
            ]
          }
        }
      },
      "satisfiable": {
        "type": "boolean"
      },
      "decisions": {
        "type": "array",
        "minItems": 1,
        "maxItems": 32,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "code",
            "available"
          ],
          "properties": {
            "code": {
              "enum": [
                "CAPABILITY_MANIFEST_VALID",
                "CONTRACT_VERSION_SUPPORTED",
                "ENGINE_MODE_SUPPORTED",
                "FORMAT_AVAILABLE",
                "OPERATION_SUPPORTED",
                "FORMAT_QUALIFICATION_SUFFICIENT",
                "ENTITY_DETECTOR_REQUIREMENTS_SATISFIED",
                "TRANSFORMATION_REQUIREMENTS_SATISFIED",
                "VERIFICATION_PROFILE_AVAILABLE",
                "INPUT_LIMIT_SUFFICIENT"
              ]
            },
            "available": {
              "type": "boolean"
            }
          }
        }
      }
    },
    "$defs": {
      "policySummary": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest",
          "riskTier",
          "example"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "riskTier": {
            "enum": [
              "LOW",
              "MODERATE",
              "HIGH"
            ]
          },
          "example": {
            "const": true
          }
        }
      }
    },
    "allOf": [
      {
        "if": {
          "properties": {
            "operation": {
              "const": "POLICY_LIST"
            }
          }
        },
        "then": {
          "properties": {
            "policies": true,
            "policy": false,
            "capability": false,
            "satisfiable": false,
            "decisions": false
          },
          "required": [
            "policies"
          ]
        }
      },
      {
        "if": {
          "properties": {
            "operation": {
              "const": "POLICY_EXPLAIN"
            }
          }
        },
        "then": {
          "properties": {
            "policies": false,
            "policy": true,
            "capability": true,
            "satisfiable": true,
            "decisions": true
          },
          "required": [
            "policy",
            "capability",
            "satisfiable",
            "decisions"
          ]
        }
      }
    ],
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "operation": "POLICY_LIST",
        "policies": [
          {
            "id": "development-labels",
            "version": "0.1.0",
            "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "riskTier": "LOW",
            "example": true
          }
        ]
      },
      {
        "schemaVersion": "1.0.0",
        "operation": "POLICY_EXPLAIN",
        "policy": {
          "id": "high-risk-disclosure",
          "version": "3.1.0",
          "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "riskTier": "HIGH",
          "example": true
        },
        "capability": {
          "id": "local-rules-text",
          "version": "0.1.0",
          "engineMode": "RULES_ONLY"
        },
        "satisfiable": false,
        "decisions": [
          {
            "code": "CAPABILITY_MANIFEST_VALID",
            "available": true
          },
          {
            "code": "FORMAT_QUALIFICATION_SUFFICIENT",
            "available": false
          },
          {
            "code": "ENTITY_DETECTOR_REQUIREMENTS_SATISFIED",
            "available": false
          },
          {
            "code": "TRANSFORMATION_REQUIREMENTS_SATISFIED",
            "available": false
          },
          {
            "code": "VERIFICATION_PROFILE_AVAILABLE",
            "available": false
          },
          {
            "code": "INPUT_LIMIT_SUFFICIENT",
            "available": true
          }
        ]
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/cli/redact-report/2.0.0",
    "title": "CLI redaction report v2",
    "description": "Privacy-minimized redaction result bound to a canonical verification attestation v2.",
    "schemaVersion": "2.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "operation",
      "outcome",
      "input",
      "output",
      "policy",
      "plan",
      "writerReceipt",
      "verification"
    ],
    "properties": {
      "schemaVersion": {
        "const": "2.0.0"
      },
      "operation": {
        "const": "REDACT"
      },
      "outcome": {
        "const": "VERIFIED"
      },
      "input": {
        "$ref": "https://local-pii.dev/schemas/cli/cli-report/1.0.0#/$defs/artifactSummary"
      },
      "output": {
        "$ref": "https://local-pii.dev/schemas/cli/cli-report/1.0.0#/$defs/artifactSummary"
      },
      "policy": {
        "$ref": "https://local-pii.dev/schemas/cli/cli-report/1.0.0#/$defs/policySummary"
      },
      "plan": {
        "$ref": "https://local-pii.dev/schemas/cli/cli-report/1.0.0#/properties/plan"
      },
      "writerReceipt": {
        "$ref": "https://local-pii.dev/schemas/cli/cli-report/1.0.0#/$defs/writerReceiptSummary"
      },
      "verification": {
        "$ref": "https://local-pii.dev/schemas/verification/verification-report/2.0.0"
      }
    },
    "examples": [
      {
        "schemaVersion": "2.0.0",
        "operation": "REDACT",
        "outcome": "VERIFIED",
        "input": {
          "byteLength": 18,
          "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "output": {
          "byteLength": 9,
          "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        "policy": {
          "id": "development-labels",
          "version": "0.1.0",
          "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "riskTier": "LOW",
          "example": true
        },
        "plan": {
          "id": "plan_01J4M8Z7QK2C5B6TFXDA9R4M3V",
          "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "inputDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "extractionRevision": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
          "resolutionDigest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          "capabilityDigest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "policyDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "detectorBundleVersion": "0.1.0",
          "writer": {
            "id": "text-adapter",
            "version": "0.1.0"
          },
          "strategy": "TYPED_LABEL",
          "strategyVersion": "0.1.0",
          "actionCount": 0,
          "byEntity": {}
        },
        "writerReceipt": {
          "receiptDigest": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
          "planDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "outputDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "writer": {
            "id": "text-adapter",
            "version": "0.1.0"
          },
          "expectedActionCount": 0,
          "appliedActionCount": 0
        },
        "verification": {
          "schemaVersion": "2.0.0",
          "input": {
            "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "byteLength": 18
          },
          "output": {
            "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "byteLength": 9,
            "mediaType": "text/plain",
            "extractionRevision": "sha256:7777777777777777777777777777777777777777777777777777777777777777"
          },
          "plan": {
            "id": "plan_01J4M8Z7QK2C5B6TFXDA9R4M3V",
            "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
          },
          "policy": {
            "id": "development-labels",
            "version": "0.1.0",
            "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "riskTier": "LOW"
          },
          "capabilityDigest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "writerReceiptDigest": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
          "profile": {
            "id": "text-rescan-v1",
            "version": "0.1.0",
            "digest": "sha256:1313131313131313131313131313131313131313131313131313131313131313"
          },
          "verifier": {
            "id": "text-verifier",
            "version": "0.1.0",
            "digest": "sha256:1414141414141414141414141414141414141414141414141414141414141414"
          },
          "detectorBundle": {
            "id": "deterministic-text",
            "version": "0.1.0",
            "digest": "sha256:1515151515151515151515151515151515151515151515151515151515151515"
          },
          "writer": {
            "id": "text-adapter",
            "version": "0.1.0",
            "digest": "sha256:1616161616161616161616161616161616161616161616161616161616161616"
          },
          "application": {
            "id": "local-pii-cli",
            "version": "0.1.0",
            "digest": "sha256:1717171717171717171717171717171717171717171717171717171717171717"
          },
          "outcome": "PASS",
          "checks": [
            "UTF8_REOPEN",
            "DETERMINISTIC_RESCAN",
            "SPAN_RESOLUTION",
            "ACTION_RECONCILIATION"
          ],
          "reconciliation": {
            "expectedActionCount": 0,
            "appliedActionCount": 0,
            "missingActionCount": 0,
            "unexpectedActionCount": 0,
            "duplicateActionCount": 0
          },
          "findings": [],
          "startedAt": "2026-08-09T07:00:00Z",
          "completedAt": "2026-08-09T07:00:01Z",
          "reportDigest": "sha256:6666666666666666666666666666666666666666666666666666666666666666"
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/cli/stage-recovery-report/1.0.0",
    "title": "CLI stage recovery report",
    "description": "Privacy-safe bounded counts from an explicit text staging inventory or cleanup.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "operation",
      "mode",
      "minimumAgeMs",
      "scannedEntryCount",
      "matchingStageFileCount",
      "staleStageFileCount",
      "freshStageFileCount",
      "protectedEntryCount",
      "skippedUnsafeEntryCount",
      "capped",
      "deletedStageFileCount",
      "deletionFailureCount"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "operation": {
        "const": "STAGE_RECOVERY"
      },
      "mode": {
        "enum": [
          "DRY_RUN",
          "APPLY"
        ]
      },
      "minimumAgeMs": {
        "type": "integer",
        "minimum": 1,
        "maximum": 2678400000
      },
      "scannedEntryCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000
      },
      "matchingStageFileCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000
      },
      "staleStageFileCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000
      },
      "freshStageFileCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000
      },
      "protectedEntryCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000
      },
      "skippedUnsafeEntryCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000
      },
      "capped": {
        "type": "boolean"
      },
      "deletedStageFileCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000
      },
      "deletionFailureCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "operation": "STAGE_RECOVERY",
        "mode": "DRY_RUN",
        "minimumAgeMs": 86400000,
        "scannedEntryCount": 4,
        "matchingStageFileCount": 1,
        "staleStageFileCount": 1,
        "freshStageFileCount": 0,
        "protectedEntryCount": 0,
        "skippedUnsafeEntryCount": 0,
        "capped": false,
        "deletedStageFileCount": 0,
        "deletionFailureCount": 0
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/common/entity-type/1.0.0",
    "title": "Entity type",
    "description": "Initial versioned PII and secret entity taxonomy proposed by the reference catalog.",
    "schemaVersion": "1.0.0",
    "type": "string",
    "enum": [
      "PERSON",
      "EMAIL",
      "PHONE",
      "ADDRESS",
      "LOCATION",
      "ORGANIZATION",
      "DATE_OF_BIRTH",
      "SSN",
      "NATIONAL_ID",
      "PASSPORT",
      "DRIVER_LICENSE",
      "CREDIT_CARD",
      "BANK_ACCOUNT",
      "ROUTING_NUMBER",
      "MEDICAL_RECORD",
      "HEALTH_PLAN_ID",
      "ACCOUNT_ID",
      "USERNAME",
      "IP_ADDRESS",
      "MAC_ADDRESS",
      "API_KEY",
      "ACCESS_TOKEN",
      "PASSWORD",
      "CUSTOM"
    ],
    "examples": [
      "EMAIL"
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/common/errors/2.0.0",
    "title": "Typed error envelope v2",
    "description": "Privacy-safe stable error envelope with explicit artifact-integrity failure classification.",
    "schemaVersion": "2.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "error"
    ],
    "properties": {
      "schemaVersion": {
        "const": "2.0.0"
      },
      "error": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "code",
          "message",
          "retryable",
          "correlationId"
        ],
        "properties": {
          "code": {
            "enum": [
              "CONTRACT_UNSUPPORTED",
              "SCHEMA_INVALID",
              "IDEMPOTENCY_CONFLICT",
              "INPUT_TOO_LARGE",
              "FORMAT_UNSUPPORTED",
              "FORMAT_ENCRYPTED",
              "FORMAT_CORRUPT",
              "POLICY_UNSATISFIABLE",
              "POLICY_REVIEW_REQUIRED",
              "POLICY_BLOCKED",
              "REQUIRED_DETECTOR_UNAVAILABLE",
              "MODEL_UNAVAILABLE",
              "DETECTOR_TIMEOUT",
              "DETECTION_LIMIT_EXCEEDED",
              "MODEL_OUTPUT_INVALID",
              "SOURCE_MAP_INVALID",
              "REDACTION_PLAN_CONFLICT",
              "REDACTION_COUNT_MISMATCH",
              "VERIFICATION_RESIDUAL",
              "VERIFICATION_INCOMPLETE",
              "FIDELITY_OUT_OF_RANGE",
              "ARTIFACT_DIGEST_MISMATCH",
              "STORAGE_UNAVAILABLE",
              "JOB_CONFLICT",
              "OUTPUT_COLLISION",
              "RATE_LIMITED",
              "SUPPLY_CHAIN_INVALID",
              "AUTHORIZATION_DENIED",
              "INTERNAL_ERROR"
            ]
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "retryable": {
            "type": "boolean"
          },
          "correlationId": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/CorrelationId"
          },
          "details": {
            "type": "object",
            "description": "Allow-listed safe scalar context; never paths, excerpts, or parser exceptions.",
            "maxProperties": 16,
            "propertyNames": {
              "enum": [
                "format",
                "stage",
                "attempt",
                "recovered",
                "reason",
                "detectorId",
                "deadlineExceeded",
                "modelId",
                "conflictCount",
                "findingCount",
                "contractVersionAvailable",
                "engineModeAvailable",
                "formatAvailable",
                "operationAvailable",
                "qualificationSufficient",
                "missingDetectorCount",
                "missingDetectorKindCount",
                "missingTransformationCount",
                "verificationProfileAvailable",
                "inputLimitSufficient",
                "maximumInputBytes",
                "actualInputBytes"
              ]
            },
            "additionalProperties": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 128
                },
                {
                  "type": "number"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                }
              ]
            }
          }
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "2.0.0",
        "error": {
          "code": "ARTIFACT_DIGEST_MISMATCH",
          "message": "The staged artifact changed before verification.",
          "retryable": false,
          "correlationId": "cor_artifact_integrity"
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/common/errors/3.0.0",
    "title": "Typed error envelope v3",
    "description": "Privacy-safe stable error envelope with explicit artifact-integrity and cooperative-cancellation classifications.",
    "schemaVersion": "3.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "error"
    ],
    "properties": {
      "schemaVersion": {
        "const": "3.0.0"
      },
      "error": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "code",
          "message",
          "retryable",
          "correlationId"
        ],
        "properties": {
          "code": {
            "enum": [
              "CONTRACT_UNSUPPORTED",
              "SCHEMA_INVALID",
              "IDEMPOTENCY_CONFLICT",
              "INPUT_TOO_LARGE",
              "FORMAT_UNSUPPORTED",
              "FORMAT_ENCRYPTED",
              "FORMAT_CORRUPT",
              "POLICY_UNSATISFIABLE",
              "POLICY_REVIEW_REQUIRED",
              "POLICY_BLOCKED",
              "REQUIRED_DETECTOR_UNAVAILABLE",
              "MODEL_UNAVAILABLE",
              "DETECTOR_TIMEOUT",
              "DETECTION_LIMIT_EXCEEDED",
              "MODEL_OUTPUT_INVALID",
              "SOURCE_MAP_INVALID",
              "REDACTION_PLAN_CONFLICT",
              "REDACTION_COUNT_MISMATCH",
              "VERIFICATION_RESIDUAL",
              "VERIFICATION_INCOMPLETE",
              "FIDELITY_OUT_OF_RANGE",
              "ARTIFACT_DIGEST_MISMATCH",
              "STORAGE_UNAVAILABLE",
              "JOB_CONFLICT",
              "OUTPUT_COLLISION",
              "RATE_LIMITED",
              "SUPPLY_CHAIN_INVALID",
              "AUTHORIZATION_DENIED",
              "OPERATION_CANCELLED",
              "INTERNAL_ERROR"
            ]
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "retryable": {
            "type": "boolean"
          },
          "correlationId": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/CorrelationId"
          },
          "details": {
            "type": "object",
            "description": "Allow-listed safe scalar context; never paths, excerpts, or parser exceptions.",
            "maxProperties": 16,
            "propertyNames": {
              "enum": [
                "format",
                "stage",
                "attempt",
                "recovered",
                "reason",
                "detectorId",
                "deadlineExceeded",
                "modelId",
                "conflictCount",
                "findingCount",
                "contractVersionAvailable",
                "engineModeAvailable",
                "formatAvailable",
                "operationAvailable",
                "qualificationSufficient",
                "missingDetectorCount",
                "missingDetectorKindCount",
                "missingTransformationCount",
                "verificationProfileAvailable",
                "inputLimitSufficient",
                "maximumInputBytes",
                "actualInputBytes"
              ]
            },
            "additionalProperties": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 128
                },
                {
                  "type": "number"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                }
              ]
            }
          }
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "3.0.0",
        "error": {
          "code": "OPERATION_CANCELLED",
          "message": "The operation was cancelled.",
          "retryable": false,
          "correlationId": "cor_operation_cancelled"
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/common/errors/1.0.0",
    "title": "Typed error envelope",
    "description": "Privacy-safe stable error returned at process and protocol boundaries.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "error"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "error": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "code",
          "message",
          "retryable",
          "correlationId"
        ],
        "properties": {
          "code": {
            "enum": [
              "CONTRACT_UNSUPPORTED",
              "SCHEMA_INVALID",
              "IDEMPOTENCY_CONFLICT",
              "INPUT_TOO_LARGE",
              "FORMAT_UNSUPPORTED",
              "FORMAT_ENCRYPTED",
              "FORMAT_CORRUPT",
              "POLICY_UNSATISFIABLE",
              "POLICY_REVIEW_REQUIRED",
              "POLICY_BLOCKED",
              "REQUIRED_DETECTOR_UNAVAILABLE",
              "MODEL_UNAVAILABLE",
              "DETECTOR_TIMEOUT",
              "DETECTION_LIMIT_EXCEEDED",
              "MODEL_OUTPUT_INVALID",
              "SOURCE_MAP_INVALID",
              "REDACTION_PLAN_CONFLICT",
              "REDACTION_COUNT_MISMATCH",
              "VERIFICATION_RESIDUAL",
              "VERIFICATION_INCOMPLETE",
              "FIDELITY_OUT_OF_RANGE",
              "STORAGE_UNAVAILABLE",
              "JOB_CONFLICT",
              "OUTPUT_COLLISION",
              "RATE_LIMITED",
              "SUPPLY_CHAIN_INVALID",
              "AUTHORIZATION_DENIED",
              "INTERNAL_ERROR"
            ]
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "retryable": {
            "type": "boolean"
          },
          "correlationId": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/CorrelationId"
          },
          "details": {
            "type": "object",
            "description": "Allow-listed safe scalar context; never paths, excerpts, or parser exceptions.",
            "maxProperties": 16,
            "propertyNames": {
              "enum": [
                "format",
                "stage",
                "attempt",
                "recovered",
                "reason",
                "detectorId",
                "deadlineExceeded",
                "modelId",
                "conflictCount",
                "findingCount",
                "contractVersionAvailable",
                "engineModeAvailable",
                "formatAvailable",
                "operationAvailable",
                "qualificationSufficient",
                "missingDetectorCount",
                "missingDetectorKindCount",
                "missingTransformationCount",
                "verificationProfileAvailable",
                "inputLimitSufficient",
                "maximumInputBytes",
                "actualInputBytes"
              ]
            },
            "additionalProperties": {
              "oneOf": [
                {
                  "type": "string",
                  "maxLength": 128
                },
                {
                  "type": "number"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                }
              ]
            }
          }
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "error": {
          "code": "FORMAT_ENCRYPTED",
          "message": "The input is encrypted and cannot be processed by this profile.",
          "retryable": false,
          "correlationId": "cor_01J4M8Z7QK2C5B6TFXDA9R4M3V"
        }
      },
      {
        "schemaVersion": "1.0.0",
        "error": {
          "code": "POLICY_REVIEW_REQUIRED",
          "message": "The selected policy requires review before output can be published.",
          "retryable": false,
          "correlationId": "cor_policy_review"
        }
      },
      {
        "schemaVersion": "1.0.0",
        "error": {
          "code": "POLICY_BLOCKED",
          "message": "The selected policy blocked output publication.",
          "retryable": false,
          "correlationId": "cor_policy_blocked"
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/common/identifiers/1.0.0",
    "title": "Identifier catalog",
    "description": "Canonical opaque identifiers, semantic versions, and SHA-256 digests.",
    "schemaVersion": "1.0.0",
    "$defs": {
      "ArtifactId": {
        "type": "string",
        "pattern": "^art_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "JobId": {
        "type": "string",
        "pattern": "^job_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "DetectionId": {
        "type": "string",
        "format": "uuid",
        "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
      },
      "EventId": {
        "type": "string",
        "format": "uuid",
        "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
      },
      "CorrelationId": {
        "type": "string",
        "minLength": 8,
        "maxLength": 128
      },
      "Digest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      },
      "Semver": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$"
      },
      "DateTime": {
        "type": "string",
        "format": "date-time",
        "pattern": "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$"
      }
    },
    "type": "object",
    "additionalProperties": false,
    "examples": [
      {}
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/detection/detect-request/1.0.0",
    "title": "Inference detect request",
    "description": "Bounded contextual-inference request containing opaque chunks and no artifact metadata.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "requestId",
      "chunks",
      "entityTypes",
      "minimumConfidence",
      "options"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "requestId": {
        "type": "string",
        "format": "uuid"
      },
      "chunks": {
        "type": "array",
        "minItems": 1,
        "maxItems": 64,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "text",
            "absoluteStart"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            },
            "text": {
              "type": "string",
              "minLength": 1,
              "maxLength": 20000
            },
            "absoluteStart": {
              "type": "integer",
              "minimum": 0
            },
            "language": {
              "type": "string",
              "pattern": "^[a-z]{2,3}(?:-[A-Z]{2})?$"
            }
          }
        }
      },
      "entityTypes": {
        "type": "array",
        "minItems": 1,
        "uniqueItems": true,
        "items": {
          "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
        }
      },
      "minimumConfidence": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      },
      "options": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "maxDetectionsPerChunk"
        ],
        "properties": {
          "maxDetectionsPerChunk": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1000
          }
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "requestId": "d9b8a330-8d9a-4f6f-8f11-5b2f10e53967",
        "chunks": [
          {
            "id": "chunk-0001",
            "text": "Synthetic Person",
            "absoluteStart": 0,
            "language": "en"
          }
        ],
        "entityTypes": [
          "PERSON"
        ],
        "minimumConfidence": 0.55,
        "options": {
          "maxDetectionsPerChunk": 200
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/detection/detect-response/1.0.0",
    "title": "Inference detect response",
    "description": "Contextual candidate spans relative to request chunks plus immutable model provenance.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "requestId",
      "detections",
      "model",
      "warnings"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "requestId": {
        "type": "string",
        "format": "uuid"
      },
      "detections": {
        "type": "array",
        "maxItems": 64000,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "chunkId",
            "entityType",
            "start",
            "end",
            "confidence",
            "detector"
          ],
          "properties": {
            "chunkId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            },
            "entityType": {
              "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
            },
            "start": {
              "type": "integer",
              "minimum": 0
            },
            "end": {
              "type": "integer",
              "minimum": 1
            },
            "confidence": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            "detector": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "id",
                "version"
              ],
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1
                },
                "version": {
                  "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
                }
              }
            }
          }
        }
      },
      "model": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest",
          "runtime"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "runtime": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "warnings": {
        "type": "array",
        "maxItems": 100,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "requestId": "d9b8a330-8d9a-4f6f-8f11-5b2f10e53967",
        "detections": [
          {
            "chunkId": "chunk-0001",
            "entityType": "PERSON",
            "start": 0,
            "end": 16,
            "confidence": 0.97,
            "detector": {
              "id": "pii-small",
              "version": "0.1.0"
            }
          }
        ],
        "model": {
          "id": "pii-small",
          "version": "0.1.0",
          "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "runtime": "onnxruntime-cpu"
        },
        "warnings": []
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/detection/detection/1.0.0",
    "title": "Detection evidence",
    "description": "One value-free detector assertion anchored to an extraction revision.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "entityType",
      "span",
      "confidence",
      "source",
      "detector"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "id": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DetectionId"
      },
      "entityType": {
        "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
      },
      "span": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "start",
          "end",
          "offsetUnit",
          "extractionRevision"
        ],
        "properties": {
          "start": {
            "type": "integer",
            "minimum": 0
          },
          "end": {
            "type": "integer",
            "minimum": 1
          },
          "offsetUnit": {
            "const": "UNICODE_CODE_POINT"
          },
          "extractionRevision": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          }
        }
      },
      "confidence": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      },
      "source": {
        "enum": [
          "REGEX",
          "CHECKSUM",
          "STRUCTURED",
          "DICTIONARY",
          "MODEL",
          "MANUAL"
        ]
      },
      "detector": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "ruleId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        }
      },
      "nativeLocations": {
        "type": "array",
        "maxItems": 64,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "kind",
            "reference"
          ],
          "properties": {
            "kind": {
              "enum": [
                "TEXT",
                "JSON_POINTER",
                "CSV_CELL",
                "DOCX_PART",
                "PDF_BOX"
              ]
            },
            "reference": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            }
          }
        }
      },
      "attributes": {
        "type": "object",
        "maxProperties": 32,
        "additionalProperties": {
          "type": [
            "string",
            "number",
            "boolean"
          ]
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "id": "d9b8a330-8d9a-4f6f-8f11-5b2f10e53967",
        "entityType": "EMAIL",
        "span": {
          "start": 8,
          "end": 25,
          "offsetUnit": "UNICODE_CODE_POINT",
          "extractionRevision": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        "confidence": 0.99,
        "source": "REGEX",
        "detector": {
          "id": "email-pattern",
          "version": "0.1.0",
          "ruleId": "email-v1"
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/extraction/extracted-document/1.0.0",
    "title": "Extracted document",
    "description": "References to canonical text and source-map blobs for one immutable extraction revision.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "artifactId",
      "adapter",
      "canonicalTextRef",
      "sourceMapRef",
      "textLength",
      "revisionDigest",
      "warnings"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "artifactId": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/ArtifactId"
      },
      "adapter": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          }
        }
      },
      "canonicalTextRef": {
        "type": "string",
        "minLength": 1,
        "maxLength": 255
      },
      "sourceMapRef": {
        "type": "string",
        "minLength": 1,
        "maxLength": 255
      },
      "textLength": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000000
      },
      "revisionDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "warnings": {
        "type": "array",
        "maxItems": 100,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "artifactId": "art_01J4M8Z7QK2C5B6TFXDA9R4M3V",
        "adapter": {
          "id": "text",
          "version": "0.1.0"
        },
        "canonicalTextRef": "blob:text:1",
        "sourceMapRef": "blob:map:1",
        "textLength": 42,
        "revisionDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "warnings": []
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/jobs/job-event/1.0.0",
    "title": "Job event",
    "description": "At-least-once safe job event carrying no document values or excerpts.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "jobId",
      "cursor",
      "revision",
      "type",
      "occurredAt"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "id": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/EventId"
      },
      "jobId": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/JobId"
      },
      "cursor": {
        "type": "integer",
        "minimum": 1
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "type": {
        "enum": [
          "JOB_CREATED",
          "STATE_CHANGED",
          "REVIEW_REQUIRED",
          "JOB_COMPLETED",
          "JOB_FAILED",
          "CANCELLATION_REQUESTED"
        ]
      },
      "occurredAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      },
      "counts": {
        "type": "object",
        "maxProperties": 16,
        "additionalProperties": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "id": "603df129-c778-4b13-8b2a-0fe745593c8f",
        "jobId": "job_01J4M91NJK8WAPJ7J95K73CB2M",
        "cursor": 1,
        "revision": 1,
        "type": "JOB_CREATED",
        "occurredAt": "2026-08-08T18:00:00Z"
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/jobs/job/1.0.0",
    "title": "Job",
    "description": "Durable job aggregate summary with optimistic revision and minimized metadata.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "operation",
      "state",
      "revision",
      "policy",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "id": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/JobId"
      },
      "operation": {
        "enum": [
          "SCAN",
          "REDACT",
          "VERIFY",
          "INSPECT"
        ]
      },
      "state": {
        "enum": [
          "QUEUED",
          "VALIDATING",
          "EXTRACTING",
          "DETECTING",
          "RESOLVING",
          "NEEDS_REVIEW",
          "REDACTING",
          "VERIFYING",
          "CANCELLING",
          "VERIFIED",
          "SUCCEEDED",
          "FAILED",
          "CANCELLED",
          "EXPIRED"
        ]
      },
      "revision": {
        "type": "integer",
        "minimum": 1
      },
      "policy": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          }
        }
      },
      "createdAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      },
      "updatedAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      },
      "expiresAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      },
      "summary": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "detections": {
            "type": "integer",
            "minimum": 0
          },
          "conflicts": {
            "type": "integer",
            "minimum": 0
          },
          "findings": {
            "type": "integer",
            "minimum": 0
          }
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "id": "job_01J4M91NJK8WAPJ7J95K73CB2M",
        "operation": "SCAN",
        "state": "QUEUED",
        "revision": 1,
        "policy": {
          "id": "development-labels",
          "version": "0.1.0",
          "digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        },
        "createdAt": "2026-08-08T18:00:00Z",
        "updatedAt": "2026-08-08T18:00:00Z"
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/models/model-manifest/1.0.0",
    "title": "Model manifest",
    "description": "Verified local model, tokenizer, protocol, provenance, and capability declaration.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "version",
      "modelDigest",
      "tokenizerDigest",
      "runtime",
      "protocolVersions",
      "entityTypes",
      "languages",
      "license",
      "provenance"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "id": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]{2,63}$"
      },
      "version": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
      },
      "modelDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "tokenizerDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "runtime": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "protocolVersions": {
        "type": "array",
        "minItems": 1,
        "uniqueItems": true,
        "items": {
          "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
        }
      },
      "entityTypes": {
        "type": "array",
        "minItems": 1,
        "uniqueItems": true,
        "items": {
          "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
        }
      },
      "languages": {
        "type": "array",
        "minItems": 1,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "pattern": "^[a-z]{2,3}(?:-[A-Z]{2})?$"
        }
      },
      "license": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "spdxId",
          "notice"
        ],
        "properties": {
          "spdxId": {
            "type": "string",
            "minLength": 1
          },
          "notice": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          }
        }
      },
      "provenance": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "source",
          "retrievedAt"
        ],
        "properties": {
          "source": {
            "type": "string",
            "format": "uri",
            "maxLength": 500
          },
          "retrievedAt": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
          }
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "id": "synthetic-test-model",
        "version": "0.1.0",
        "modelDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "tokenizerDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "runtime": "test-double",
        "protocolVersions": [
          "1.0.0"
        ],
        "entityTypes": [
          "PERSON"
        ],
        "languages": [
          "en"
        ],
        "license": {
          "spdxId": "Apache-2.0",
          "notice": "Synthetic test-only model manifest."
        },
        "provenance": {
          "source": "https://local-pii.dev/synthetic-model",
          "retrievedAt": "2026-08-08T18:00:00Z"
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/policy/redaction-policy/1.0.0",
    "title": "Redaction policy",
    "description": "Declarative fail-closed transformation and verification policy with no executable content.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "version",
      "riskTier",
      "defaults",
      "entities",
      "verification",
      "limits"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "id": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]{2,63}$"
      },
      "version": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
      },
      "riskTier": {
        "enum": [
          "LOW",
          "MODERATE",
          "HIGH"
        ]
      },
      "defaults": {
        "$ref": "#/$defs/entityRule"
      },
      "entities": {
        "type": "object",
        "minProperties": 1,
        "maxProperties": 24,
        "propertyNames": {
          "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
        },
        "additionalProperties": {
          "$ref": "#/$defs/entityRule"
        }
      },
      "verification": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "profile",
          "blockOnWarnings"
        ],
        "properties": {
          "profile": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "blockOnWarnings": {
            "type": "boolean"
          }
        }
      },
      "limits": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "maximumInputBytes"
        ],
        "properties": {
          "maximumInputBytes": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1073741824
          }
        }
      }
    },
    "$defs": {
      "entityRule": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "action",
          "minimumConfidence",
          "uncertainBehavior"
        ],
        "properties": {
          "action": {
            "enum": [
              "REDACT",
              "TYPED_LABEL",
              "MASK",
              "PSEUDONYM",
              "HASHED_LABEL",
              "KEEP",
              "REQUIRE_REVIEW",
              "BLOCK"
            ]
          },
          "minimumConfidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "reviewBelow": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "uncertainBehavior": {
            "enum": [
              "REQUIRE_REVIEW",
              "BLOCK",
              "KEEP"
            ]
          },
          "residualBehavior": {
            "enum": [
              "BLOCK",
              "WARN"
            ]
          },
          "requiredDetectors": {
            "type": "array",
            "uniqueItems": true,
            "maxItems": 32,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            }
          },
          "requiredDetectorKinds": {
            "type": "array",
            "uniqueItems": true,
            "items": {
              "enum": [
                "REGEX",
                "CHECKSUM",
                "STRUCTURED",
                "DICTIONARY",
                "MODEL"
              ]
            }
          }
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "id": "development-labels",
        "version": "0.1.0",
        "riskTier": "LOW",
        "defaults": {
          "action": "TYPED_LABEL",
          "minimumConfidence": 0.8,
          "uncertainBehavior": "REQUIRE_REVIEW"
        },
        "entities": {
          "EMAIL": {
            "action": "TYPED_LABEL",
            "minimumConfidence": 0.95,
            "uncertainBehavior": "REQUIRE_REVIEW",
            "requiredDetectors": [
              "email-pattern"
            ]
          }
        },
        "verification": {
          "profile": "text-rescan-v1",
          "blockOnWarnings": true
        },
        "limits": {
          "maximumInputBytes": 104857600
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/redaction/redaction-plan/1.0.0",
    "title": "Redaction plan",
    "description": "Immutable ordered replacement instructions bound to exact input, resolution, capability, policy, detector, and writer provenance.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "strategy",
      "strategyVersion",
      "inputDigest",
      "extractionRevision",
      "resolutionDigest",
      "capabilityDigest",
      "detectorBundleVersion",
      "policy",
      "writer",
      "expectedActionCount",
      "actions",
      "digest"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "id": {
        "type": "string",
        "pattern": "^plan_[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "strategy": {
        "const": "TYPED_LABEL"
      },
      "strategyVersion": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
      },
      "inputDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "extractionRevision": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "resolutionDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "capabilityDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "detectorBundleVersion": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "policy": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest",
          "riskTier"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "riskTier": {
            "enum": [
              "LOW",
              "MODERATE",
              "HIGH"
            ]
          }
        }
      },
      "writer": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          }
        }
      },
      "expectedActionCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
      },
      "actions": {
        "type": "array",
        "maxItems": 100000,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "action",
            "sourceSpanId",
            "evidenceIds",
            "entityType",
            "start",
            "end",
            "replacement"
          ],
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^act_[0-9A-HJKMNP-TV-Z]{26}$"
            },
            "action": {
              "const": "TYPED_LABEL"
            },
            "sourceSpanId": {
              "type": "string",
              "pattern": "^rsp_[a-f0-9]{32}$"
            },
            "evidenceIds": {
              "type": "array",
              "minItems": 1,
              "uniqueItems": true,
              "items": {
                "type": "string",
                "format": "uuid"
              }
            },
            "entityType": {
              "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
            },
            "start": {
              "type": "integer",
              "minimum": 0
            },
            "end": {
              "type": "integer",
              "minimum": 1
            },
            "replacement": {
              "type": "string",
              "maxLength": 500
            }
          }
        }
      },
      "digest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "id": "plan_01J4M8Z7QK2C5B6TFXDA9R4M3V",
        "strategy": "TYPED_LABEL",
        "strategyVersion": "0.1.0",
        "inputDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "extractionRevision": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "resolutionDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "capabilityDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "detectorBundleVersion": "0.1.0",
        "policy": {
          "id": "development-labels",
          "version": "0.1.0",
          "digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          "riskTier": "LOW"
        },
        "writer": {
          "id": "text-adapter",
          "version": "0.1.0"
        },
        "expectedActionCount": 1,
        "actions": [
          {
            "id": "act_01J4M8Z7QK2C5B6TFXDA9R4M3V",
            "action": "TYPED_LABEL",
            "sourceSpanId": "rsp_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
            "evidenceIds": [
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            ],
            "entityType": "EMAIL",
            "start": 8,
            "end": 25,
            "replacement": "[EMAIL_1]"
          }
        ],
        "digest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/redaction/writer-receipt/1.0.0",
    "title": "Writer receipt",
    "description": "Privacy-safe record of a writer's bounded application of one immutable redaction plan to a staged artifact. Applied action IDs retain canonical redaction-plan order; paths and clear values are excluded.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "planDigest",
      "writer",
      "stagedDigest",
      "stagedByteLength",
      "expectedActionCount",
      "appliedActionCount",
      "appliedActionIds",
      "receiptDigest"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "planDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "writer": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          }
        }
      },
      "stagedDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "stagedByteLength": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1073741824
      },
      "expectedActionCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
      },
      "appliedActionCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
      },
      "appliedActionIds": {
        "type": "array",
        "maxItems": 100000,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "pattern": "^act_[0-9A-HJKMNP-TV-Z]{26}$"
        },
        "description": "Exact action IDs in canonical immutable redaction-plan order; a writer may traverse native targets in a different safe mutation order."
      },
      "receiptDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "planDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "writer": {
          "id": "text-adapter",
          "version": "0.1.0"
        },
        "stagedDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "stagedByteLength": 38,
        "expectedActionCount": 2,
        "appliedActionCount": 2,
        "appliedActionIds": [
          "act_01J4M8Z7QK2C5B6TFXDA9R4M3V",
          "act_01J4M8Z7QK2C5B6TFXDA9R4M3W"
        ],
        "receiptDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/verification/verification-report/2.0.0",
    "title": "Verification attestation v2",
    "description": "Privacy-safe independent verification attestation bound to the exact input, staged output, immutable plan, policy, writer receipt, and verifier provenance. Paths, clear values, and action identifiers are intentionally excluded.",
    "schemaVersion": "2.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "input",
      "output",
      "plan",
      "policy",
      "capabilityDigest",
      "writerReceiptDigest",
      "profile",
      "verifier",
      "detectorBundle",
      "writer",
      "application",
      "outcome",
      "checks",
      "reconciliation",
      "findings",
      "startedAt",
      "completedAt",
      "reportDigest"
    ],
    "properties": {
      "schemaVersion": {
        "const": "2.0.0"
      },
      "input": {
        "type": "object",
        "description": "Exact source bytes bound to the immutable plan.",
        "additionalProperties": false,
        "required": [
          "digest",
          "byteLength"
        ],
        "properties": {
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "byteLength": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1073741824
          }
        }
      },
      "output": {
        "type": "object",
        "description": "Exact derived bytes independently reopened and verified before publication.",
        "additionalProperties": false,
        "required": [
          "digest",
          "byteLength",
          "mediaType",
          "extractionRevision"
        ],
        "properties": {
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "byteLength": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1073741824
          },
          "mediaType": {
            "type": "string",
            "minLength": 3,
            "maxLength": 127,
            "pattern": "^[a-z0-9.+-]+/[a-z0-9.+-]+$"
          },
          "extractionRevision": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          }
        }
      },
      "plan": {
        "type": "object",
        "description": "Identity and digest of the immutable plan applied to the input.",
        "additionalProperties": false,
        "required": [
          "id",
          "digest"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^plan_[0-9A-HJKMNP-TV-Z]{26}$"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          }
        }
      },
      "policy": {
        "type": "object",
        "description": "Exact policy provenance used to compile the immutable plan.",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest",
          "riskTier"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          },
          "riskTier": {
            "enum": [
              "LOW",
              "MODERATE",
              "HIGH"
            ]
          }
        }
      },
      "capabilityDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "writerReceiptDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "profile": {
        "type": "object",
        "description": "Versioned verification-profile identity.",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          }
        }
      },
      "verifier": {
        "type": "object",
        "description": "Versioned verifier implementation identity.",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          }
        }
      },
      "detectorBundle": {
        "$ref": "#/$defs/component"
      },
      "writer": {
        "$ref": "#/$defs/component"
      },
      "application": {
        "$ref": "#/$defs/component"
      },
      "outcome": {
        "enum": [
          "PASS",
          "FAIL",
          "INCOMPLETE"
        ]
      },
      "checks": {
        "description": "Closed set of required checks completed by the profile. Action reconciliation is mandatory for every v2 attestation.",
        "type": "array",
        "minItems": 1,
        "maxItems": 7,
        "uniqueItems": true,
        "contains": {
          "const": "ACTION_RECONCILIATION"
        },
        "items": {
          "enum": [
            "UTF8_REOPEN",
            "DETERMINISTIC_RESCAN",
            "SPAN_RESOLUTION",
            "ACTION_RECONCILIATION",
            "NATIVE_SURFACE",
            "STRUCTURE",
            "FIDELITY"
          ]
        }
      },
      "reconciliation": {
        "description": "Bounded aggregate comparison of the immutable plan and writer receipt; no action identifiers are retained.",
        "type": "object",
        "additionalProperties": false,
        "required": [
          "expectedActionCount",
          "appliedActionCount",
          "missingActionCount",
          "unexpectedActionCount",
          "duplicateActionCount"
        ],
        "properties": {
          "expectedActionCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100000
          },
          "appliedActionCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100000
          },
          "missingActionCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100000
          },
          "unexpectedActionCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100000
          },
          "duplicateActionCount": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100000
          }
        }
      },
      "findings": {
        "description": "Privacy-safe bounded findings without values, paths, locations, or action identifiers.",
        "type": "array",
        "maxItems": 1000,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "code",
            "severity",
            "blocking",
            "check"
          ],
          "properties": {
            "code": {
              "enum": [
                "RESIDUAL_ENTITY",
                "ACTION_NOT_APPLIED",
                "UNEXPECTED_ACTION",
                "DUPLICATE_ACTION",
                "HIDDEN_TEXT_PRESENT",
                "METADATA_RESIDUAL",
                "EMBEDDED_CONTENT_UNCHECKED",
                "OVERLAY_WITH_UNDERLYING_TEXT",
                "STRUCTURE_INVALID",
                "FIDELITY_OUT_OF_RANGE",
                "REOPEN_FAILED",
                "OUTPUT_DIGEST_MISMATCH",
                "VERIFIER_INCOMPLETE"
              ]
            },
            "severity": {
              "enum": [
                "ERROR",
                "CRITICAL"
              ]
            },
            "blocking": {
              "const": true
            },
            "check": {
              "enum": [
                "UTF8_REOPEN",
                "DETERMINISTIC_RESCAN",
                "SPAN_RESOLUTION",
                "ACTION_RECONCILIATION",
                "NATIVE_SURFACE",
                "STRUCTURE",
                "FIDELITY"
              ]
            },
            "entityType": {
              "$ref": "https://local-pii.dev/schemas/common/entity-type/1.0.0"
            },
            "count": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100000
            }
          }
        }
      },
      "startedAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      },
      "completedAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      },
      "reportDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      }
    },
    "$defs": {
      "component": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,63}$"
          },
          "version": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Semver"
          },
          "digest": {
            "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
          }
        }
      }
    },
    "examples": [
      {
        "schemaVersion": "2.0.0",
        "input": {
          "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "byteLength": 42
        },
        "output": {
          "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "byteLength": 38,
          "mediaType": "text/plain",
          "extractionRevision": "sha256:9999999999999999999999999999999999999999999999999999999999999999"
        },
        "plan": {
          "id": "plan_01J4M8Z7QK2C5B6TFXDA9R4M3V",
          "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        },
        "policy": {
          "id": "development-labels",
          "version": "0.1.0",
          "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "riskTier": "LOW"
        },
        "capabilityDigest": "sha256:1212121212121212121212121212121212121212121212121212121212121212",
        "writerReceiptDigest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "profile": {
          "id": "text-rescan-v1",
          "version": "0.1.0",
          "digest": "sha256:1313131313131313131313131313131313131313131313131313131313131313"
        },
        "verifier": {
          "id": "text-verifier",
          "version": "0.1.0",
          "digest": "sha256:1414141414141414141414141414141414141414141414141414141414141414"
        },
        "detectorBundle": {
          "id": "deterministic-text",
          "version": "0.1.0",
          "digest": "sha256:1515151515151515151515151515151515151515151515151515151515151515"
        },
        "writer": {
          "id": "text-adapter",
          "version": "0.1.0",
          "digest": "sha256:1616161616161616161616161616161616161616161616161616161616161616"
        },
        "application": {
          "id": "local-pii-cli",
          "version": "0.1.0",
          "digest": "sha256:1717171717171717171717171717171717171717171717171717171717171717"
        },
        "outcome": "PASS",
        "checks": [
          "UTF8_REOPEN",
          "DETERMINISTIC_RESCAN",
          "SPAN_RESOLUTION",
          "ACTION_RECONCILIATION"
        ],
        "reconciliation": {
          "expectedActionCount": 2,
          "appliedActionCount": 2,
          "missingActionCount": 0,
          "unexpectedActionCount": 0,
          "duplicateActionCount": 0
        },
        "findings": [],
        "startedAt": "2026-08-08T18:00:30Z",
        "completedAt": "2026-08-08T18:01:00Z",
        "reportDigest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://local-pii.dev/schemas/verification/verification-report/1.0.0",
    "title": "Verification report",
    "description": "Independent verification outcome bound to the exact output digest.",
    "schemaVersion": "1.0.0",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "artifactId",
      "artifactDigest",
      "profile",
      "outcome",
      "checks",
      "findings",
      "completedAt",
      "reportDigest"
    ],
    "properties": {
      "schemaVersion": {
        "const": "1.0.0"
      },
      "artifactId": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/ArtifactId"
      },
      "artifactDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      },
      "profile": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "outcome": {
        "enum": [
          "PASS",
          "FAIL",
          "INCOMPLETE"
        ]
      },
      "checks": {
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "uniqueItems": true
      },
      "findings": {
        "type": "array",
        "maxItems": 10000,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "code",
            "severity",
            "blocking"
          ],
          "properties": {
            "code": {
              "type": "string",
              "pattern": "^[A-Z][A-Z0-9_]{2,63}$"
            },
            "severity": {
              "enum": [
                "INFO",
                "WARNING",
                "ERROR",
                "CRITICAL"
              ]
            },
            "blocking": {
              "type": "boolean"
            },
            "locationRef": {
              "type": "string",
              "maxLength": 500
            }
          }
        }
      },
      "completedAt": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/DateTime"
      },
      "reportDigest": {
        "$ref": "https://local-pii.dev/schemas/common/identifiers/1.0.0#/$defs/Digest"
      }
    },
    "examples": [
      {
        "schemaVersion": "1.0.0",
        "artifactId": "art_01J4M8Z7QK2C5B6TFXDA9R4M3V",
        "artifactDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "profile": "text-rescan-v1",
        "outcome": "PASS",
        "checks": [
          "REOPEN",
          "RESCAN",
          "ACTION_RECONCILIATION"
        ],
        "findings": [],
        "completedAt": "2026-08-08T18:01:00Z",
        "reportDigest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      }
    ]
  }
] as const;

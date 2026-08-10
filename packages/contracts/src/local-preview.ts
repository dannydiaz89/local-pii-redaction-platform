/**
 * Conservative whole-buffer ceiling for the development browser preview.
 * Both the loopback API and browser client consume this shared value.
 */
export const localPreviewMaximumInputBytes = 8 * 1024 * 1024;

/** Maximum verified derived bytes retained for one session-only browser redaction. */
export const localRedactionMaximumOutputBytes = 16 * 1024 * 1024;

/** Maximum value-free detection rows returned by one ephemeral browser review response. */
export const localPreviewMaximumDetectionDetails = 100;

/** Maximum value-free conflict rows returned by one ephemeral browser review response. */
export const localPreviewMaximumConflictDetails = 100;

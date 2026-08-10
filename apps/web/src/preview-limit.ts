/** Browser copy of the canonical contract limit, protected by a cross-boundary drift test. */
export const webPreviewMaximumInputBytes = 8 * 1024 * 1024;

/** Browser copy of the canonical value-free detail limit, protected by a drift test. */
export const webPreviewMaximumDetectionDetails = 100;

/** Browser copy of the canonical value-free conflict limit, protected by a drift test. */
export const webPreviewMaximumConflictDetails = 100;

/** Browser copy of the session-only verified output ceiling, protected by a drift test. */
export const webRedactionMaximumOutputBytes = 16 * 1024 * 1024;

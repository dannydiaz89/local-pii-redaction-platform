/** SDK copy of the canonical contract limit, protected by a cross-boundary drift test. */
export const localClientMaximumInputBytes = 8 * 1024 * 1024;

/** Browser copy of the canonical value-free detail limit, protected by a drift test. */
export const localClientMaximumDetectionDetails = 100;

/** Browser copy of the canonical value-free conflict limit, protected by a drift test. */
export const localClientMaximumConflictDetails = 100;

/** Browser copy of the session-only verified output ceiling, protected by a drift test. */
export const localClientMaximumOutputBytes = 16 * 1024 * 1024;

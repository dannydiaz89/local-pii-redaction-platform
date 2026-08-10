/**
 * Conservative whole-buffer ceiling for the development browser preview.
 * Both the loopback API and browser client consume this shared value.
 */
export const localPreviewMaximumInputBytes = 8 * 1024 * 1024;

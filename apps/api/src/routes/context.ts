import type { ApiDependencies } from '../api-types.js';

export interface ApiRouteContext {
  readonly dependencies: ApiDependencies;
  readonly handlerTimeoutMs: number;
  readonly jobIdempotencyScope: string;
  readonly lifecycleSignal: AbortSignal;
}

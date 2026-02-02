import { createStandaloneLogger, type StandaloneLogger } from './shared/logging/index.js';

export function createLazyLogger(
  component: string,
  requestId?: string
): () => StandaloneLogger {
  let logger: StandaloneLogger | null = null;
  return () => {
    if (!logger) {
      logger = createStandaloneLogger({
        component,
        requestId: requestId ?? `${component.toLowerCase()}-init`,
      });
    }
    return logger;
  };
}

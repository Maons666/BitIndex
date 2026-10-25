import { join } from 'node:path';
import { updateComparisons } from './tracking.mjs';

// Actual prices only: no training, macro fetch, new forecast or input archive.
export function createTrackingJob(projectRoot, { trackingRoot = join(projectRoot, 'predictions') } = {}) {
  const root = trackingRoot;
  return { run: (snapshot, trigger = 'manual') => updateComparisons(root, snapshot, { trigger }) };
}

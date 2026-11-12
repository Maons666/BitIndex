import { join } from 'node:path';
import { updateComparisons } from './tracking.mjs';
import { updateEventComparisons } from './event-store.mjs';

// Actual prices only: no training, macro fetch, new forecast or input archive.
export function createTrackingJob(projectRoot, { trackingRoot = join(projectRoot, 'predictions') } = {}) {
  const root = trackingRoot;
  return { run: async (snapshot, trigger = 'manual') => {
    const result = await updateComparisons(root, snapshot, { trigger });
    await updateEventComparisons(root);
    return result;
  } };
}

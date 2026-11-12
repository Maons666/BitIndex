import { join } from 'node:path';
import { eventRoot, updateEventComparisons } from './event-store.mjs';
await updateEventComparisons(process.env.BITINDEX_TRACKING_DIR || join(eventRoot, '..', 'predictions'));
console.log('Event comparisons updated from immutable actual records; no new forecast generated.');

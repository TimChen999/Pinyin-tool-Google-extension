/**
 * Firestore-specific types for the cloud sync module.
 *
 * VocabDoc extends the local VocabEntry with fields used exclusively
 * by the sync layer: `updatedAt` for ordering pull queries and
 * `deleted` for soft-delete propagation across devices.
 *
 * See: CLOUD_SYNC_SPEC.md Section 4 "Data Model"
 */

import type { VocabEntry } from "./types";

export interface VocabDoc extends VocabEntry {
  updatedAt: number;
  deleted: boolean;
}

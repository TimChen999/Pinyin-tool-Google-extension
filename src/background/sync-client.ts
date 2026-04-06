/**
 * Cloud sync client -- mirrors vocab writes to Firebase Firestore.
 *
 * Uses chrome.identity for silent Google authentication and Firestore
 * as a durable remote backup. The local chrome.storage.local store
 * remains the primary read/write layer; Firestore is never read by UI.
 *
 * See: CLOUD_SYNC_SPEC.md for full design.
 */

import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithCredential,
  GoogleAuthProvider,
  type Auth,
  type User,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  where,
  orderBy,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import { firebaseConfig } from "../shared/firebase-config";
import type { VocabEntry } from "../shared/types";
import type { VocabDoc } from "../shared/sync-types";

const STORAGE_KEY = "vocabStore";
const SYNC_TS_KEY = "syncLastPull";
const DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type VocabRecord = Record<string, VocabEntry>;

let db: Firestore | null = null;
let auth: Auth | null = null;
let currentUser: User | null = null;

const SYNC_ALLOWED_UIDS = new Set<string>([
  // Add your Firebase UID here after first sign-in.
  // Find it in Firebase Console -> Authentication -> Users.
  // "YOUR_FIREBASE_UID",
]);

// ─── Initialization ────────────────────────────────────────────────

/**
 * Authenticates with Firebase using the Chrome profile's Google account
 * and runs an initial pull sync. Called once on service worker startup.
 */
export async function initSync(): Promise<void> {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  const token = await getChromeAuthToken(false);
  if (!token) {
    console.warn("[Sync] No auth token available, sync disabled");
    return;
  }

  const credential = GoogleAuthProvider.credential(null, token);
  const result = await signInWithCredential(auth, credential);
  currentUser = result.user;

  if (SYNC_ALLOWED_UIDS.size > 0 && !SYNC_ALLOWED_UIDS.has(currentUser.uid)) {
    console.log("[Sync] UID not in allowlist, sync disabled for this account");
    currentUser = null;
    return;
  }

  console.log("[Sync] Authenticated as", currentUser.uid);
  await pullSync();
}

/**
 * Wraps chrome.identity.getAuthToken with a fallback from silent
 * to interactive mode.
 */
async function getChromeAuthToken(
  interactive: boolean,
): Promise<string | null> {
  try {
    const result = await chrome.identity.getAuthToken({ interactive });
    const token = typeof result === "string" ? result : result?.token;
    if (token) return token;

    if (!interactive) {
      return getChromeAuthToken(true);
    }
    return null;
  } catch {
    if (!interactive) {
      return getChromeAuthToken(true);
    }
    return null;
  }
}

// ─── Push Operations ───────────────────────────────────────────────

/**
 * Writes vocab entries to Firestore. Fire-and-forget -- failures are
 * logged but never propagated to the caller.
 */
export async function pushEntries(entries: VocabEntry[]): Promise<void> {
  if (!db || !currentUser || entries.length === 0) return;

  const uid = currentUser.uid;
  const now = Date.now();

  for (const entry of entries) {
    const ref = doc(db, "users", uid, "vocab", entry.chars);
    await setDoc(
      ref,
      { ...entry, updatedAt: now, deleted: false },
      { merge: true },
    );
  }
}

/**
 * Soft-deletes a word in Firestore by setting deleted=true.
 * Other devices pick up the deletion on their next pull.
 */
export async function pushDelete(chars: string): Promise<void> {
  if (!db || !currentUser) return;

  const ref = doc(db, "users", currentUser.uid, "vocab", chars);
  await setDoc(
    ref,
    { deleted: true, updatedAt: Date.now() },
    { merge: true },
  );
}

/**
 * Batch-deletes all vocab documents for the current user in Firestore.
 */
export async function pushClear(): Promise<void> {
  if (!db || !currentUser) return;

  const uid = currentUser.uid;
  const colRef = collection(db, "users", uid, "vocab");
  const snapshot = await getDocs(colRef);

  if (snapshot.empty) return;

  const batch = writeBatch(db);
  snapshot.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

// ─── Pull Operations ───────────────────────────────────────────────

/**
 * Fetches remote entries newer than the last sync timestamp, merges
 * them into local storage, and pushes any local entries that were
 * written while offline.
 */
export async function pullSync(): Promise<void> {
  if (!db || !currentUser) return;

  const uid = currentUser.uid;
  const lastSync = await getLastSyncTimestamp();

  const remoteDocs = await pullSince(uid, lastSync);

  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = result[STORAGE_KEY] ?? {};

  for (const remoteDoc of remoteDocs) {
    if (remoteDoc.deleted) {
      delete store[remoteDoc.chars];
      continue;
    }
    const local = store[remoteDoc.chars];
    if (local) {
      store[remoteDoc.chars] = mergeEntries(local, remoteDoc);
    } else {
      store[remoteDoc.chars] = toVocabEntry(remoteDoc);
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: store });

  // Reverse push: push local entries that changed while offline
  const entriesToPush = Object.values(store).filter(
    (e) => e.lastSeen > lastSync,
  );
  if (entriesToPush.length > 0) {
    await pushEntries(entriesToPush).catch(logSyncError);
  }

  await setLastSyncTimestamp(Date.now());

  await cleanupDeletedDocs(uid).catch(logSyncError);
}

/**
 * Queries Firestore for vocab docs updated after the given timestamp.
 */
async function pullSince(
  uid: string,
  since: number,
): Promise<VocabDoc[]> {
  const colRef = collection(db!, "users", uid, "vocab");
  const q = query(
    colRef,
    where("updatedAt", ">", since),
    orderBy("updatedAt"),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => d.data() as VocabDoc);
}

// ─── Conflict Resolution ───────────────────────────────────────────

/**
 * Merges a local entry with a remote entry, resolving conflicts
 * per the strategy in CLOUD_SYNC_SPEC.md Section 5.
 */
export function mergeEntries(
  local: VocabEntry,
  remote: VocabDoc,
): VocabEntry {
  const remoteIsNewer = remote.lastSeen > local.lastSeen;
  return {
    chars: local.chars,
    pinyin: remoteIsNewer ? remote.pinyin : local.pinyin,
    definition: remoteIsNewer ? remote.definition : local.definition,
    count: Math.max(local.count, remote.count),
    firstSeen: Math.min(local.firstSeen, remote.firstSeen),
    lastSeen: Math.max(local.lastSeen, remote.lastSeen),
    wrongStreak: remoteIsNewer
      ? remote.wrongStreak
      : local.wrongStreak,
    totalReviews: Math.max(
      local.totalReviews ?? 0,
      remote.totalReviews ?? 0,
    ),
    totalCorrect: Math.max(
      local.totalCorrect ?? 0,
      remote.totalCorrect ?? 0,
    ),
  };
}

// ─── Cleanup ───────────────────────────────────────────────────────

/**
 * Physically deletes Firestore docs that have been soft-deleted for
 * longer than DELETE_RETENTION_MS (30 days).
 */
async function cleanupDeletedDocs(uid: string): Promise<void> {
  const cutoff = Date.now() - DELETE_RETENTION_MS;
  const colRef = collection(db!, "users", uid, "vocab");
  const q = query(
    colRef,
    where("deleted", "==", true),
    where("updatedAt", "<", cutoff),
  );
  const snapshot = await getDocs(q);

  if (snapshot.empty) return;

  const batch = writeBatch(db!);
  snapshot.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

// ─── Helpers ───────────────────────────────────────────────────────

function toVocabEntry(vocabDoc: VocabDoc): VocabEntry {
  return {
    chars: vocabDoc.chars,
    pinyin: vocabDoc.pinyin,
    definition: vocabDoc.definition,
    count: vocabDoc.count,
    firstSeen: vocabDoc.firstSeen,
    lastSeen: vocabDoc.lastSeen,
    wrongStreak: vocabDoc.wrongStreak ?? 0,
    totalReviews: vocabDoc.totalReviews ?? 0,
    totalCorrect: vocabDoc.totalCorrect ?? 0,
  };
}

export async function getLastSyncTimestamp(): Promise<number> {
  const result = await chrome.storage.local.get(SYNC_TS_KEY);
  return result[SYNC_TS_KEY] ?? 0;
}

export async function setLastSyncTimestamp(ts: number): Promise<void> {
  await chrome.storage.local.set({ [SYNC_TS_KEY]: ts });
}

export function logSyncError(err: unknown): void {
  console.warn("[Sync] Error (non-fatal):", err);
}

/**
 * Returns whether sync is currently initialized (authenticated).
 * Used by vocab-store to guard sync calls.
 */
export function isSyncReady(): boolean {
  return db !== null && currentUser !== null;
}

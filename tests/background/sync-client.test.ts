import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// ─── Firebase Mocks ────────────────────────────────────────────────

const mockSetDoc = vi.fn().mockResolvedValue(undefined);
const mockGetDocs = vi.fn().mockResolvedValue({ docs: [], empty: true });
const mockBatchDelete = vi.fn();
const mockBatchCommit = vi.fn().mockResolvedValue(undefined);
const mockWriteBatch = vi.fn(() => ({
  delete: mockBatchDelete,
  commit: mockBatchCommit,
}));

const mockDocRef = { id: "test-doc" };
const mockDoc = vi.fn(() => mockDocRef);
const mockCollectionRef = { id: "test-collection" };
const mockCollection = vi.fn(() => mockCollectionRef);
const mockQuery = vi.fn((..._args: unknown[]) => ({}));
const mockWhere = vi.fn((..._args: unknown[]) => ({}));
const mockOrderBy = vi.fn((..._args: unknown[]) => ({}));

vi.mock("firebase/firestore", () => ({
  getFirestore: vi.fn(() => ({ type: "firestore" })),
  collection: (...args: unknown[]) => mockCollection(...args),
  doc: (...args: unknown[]) => mockDoc(...args),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  where: (...args: unknown[]) => mockWhere(...args),
  orderBy: (...args: unknown[]) => mockOrderBy(...args),
  writeBatch: (...args: unknown[]) => mockWriteBatch(...args),
}));

const mockSignInWithCredential = vi.fn().mockResolvedValue({
  user: { uid: "test-uid-123" },
});

vi.mock("firebase/auth", () => ({
  getAuth: vi.fn(() => ({ type: "auth" })),
  signInWithCredential: (...args: unknown[]) =>
    mockSignInWithCredential(...args),
  GoogleAuthProvider: {
    credential: vi.fn((_idToken: unknown, accessToken: unknown) => ({
      accessToken,
    })),
  },
}));

vi.mock("firebase/app", () => ({
  initializeApp: vi.fn(() => ({ type: "app" })),
}));

vi.mock("../../src/shared/firebase-config", () => ({
  firebaseConfig: {
    apiKey: "test-key",
    authDomain: "test.firebaseapp.com",
    projectId: "test-project",
    storageBucket: "test.appspot.com",
    messagingSenderId: "123",
    appId: "test-app-id",
  },
}));

// ─── Import after mocks ────────────────────────────────────────────

import {
  initSync,
  pushEntries,
  pushDelete,
  pushClear,
  pullSync,
  mergeEntries,
  getLastSyncTimestamp,
  setLastSyncTimestamp,
  logSyncError,
  isSyncReady,
} from "../../src/background/sync-client";
import type { VocabEntry } from "../../src/shared/types";
import type { VocabDoc } from "../../src/shared/sync-types";

// ─── Storage Mock ──────────────────────────────────────────────────

let store: Map<string, unknown>;

function setupStorageMocks() {
  store = new Map();

  chrome.storage.local.get.mockImplementation(
    (keys: string | string[] | Record<string, unknown> | null) => {
      if (keys === null) {
        const all: Record<string, unknown> = {};
        store.forEach((v, k) => (all[k] = v));
        return Promise.resolve(all);
      }
      const keyList =
        typeof keys === "string"
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys as object);
      const result: Record<string, unknown> = {};
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      return Promise.resolve(result);
    },
  );

  chrome.storage.local.set.mockImplementation(
    (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
      return Promise.resolve();
    },
  );

  chrome.storage.local.remove.mockImplementation(
    (keys: string | string[]) => {
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const k of keyList) store.delete(k);
      return Promise.resolve();
    },
  );
}

function setupIdentityMock(token: string | null = "mock-oauth-token") {
  const mockGetAuthToken = chrome.identity.getAuthToken as unknown as Mock;
  if (token) {
    mockGetAuthToken.mockResolvedValue({ token });
  } else {
    mockGetAuthToken.mockRejectedValue(new Error("No token"));
  }
}

// ─── Test Data ─────────────────────────────────────────────────────

const sampleEntry: VocabEntry = {
  chars: "银行",
  pinyin: "yín háng",
  definition: "bank",
  count: 3,
  firstSeen: 1000,
  lastSeen: 5000,
  wrongStreak: 0,
  totalReviews: 2,
  totalCorrect: 1,
};

const sampleEntry2: VocabEntry = {
  chars: "工作",
  pinyin: "gōng zuò",
  definition: "to work; job",
  count: 1,
  firstSeen: 2000,
  lastSeen: 3000,
  wrongStreak: 1,
  totalReviews: 1,
  totalCorrect: 0,
};

function makeVocabDoc(
  entry: VocabEntry,
  updatedAt: number,
  deleted = false,
): VocabDoc {
  return { ...entry, updatedAt, deleted };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("sync-client", () => {
  beforeEach(() => {
    setupStorageMocks();
    setupIdentityMock();
    vi.clearAllMocks();
    setupStorageMocks();
    setupIdentityMock();

    mockGetDocs.mockResolvedValue({ docs: [], empty: true });
    mockSetDoc.mockResolvedValue(undefined);
    mockBatchCommit.mockResolvedValue(undefined);
  });

  // ─── Auth Flow ─────────────────────────────────────────────────

  describe("initSync", () => {
    it("authenticates with chrome.identity token and signs into Firebase", async () => {
      await initSync();

      expect(chrome.identity.getAuthToken).toHaveBeenCalledWith({
        interactive: false,
      });
      expect(mockSignInWithCredential).toHaveBeenCalled();
      expect(isSyncReady()).toBe(true);
    });

    it("falls back to interactive auth when silent auth fails", async () => {
      const mockGetAuthToken =
        chrome.identity.getAuthToken as unknown as Mock;
      mockGetAuthToken
        .mockRejectedValueOnce(new Error("No token"))
        .mockResolvedValueOnce({ token: "interactive-token" });

      await initSync();

      expect(mockGetAuthToken).toHaveBeenCalledWith({
        interactive: false,
      });
      expect(mockGetAuthToken).toHaveBeenCalledWith({
        interactive: true,
      });
      expect(mockSignInWithCredential).toHaveBeenCalled();
    });

    it("skips sync when no auth token available", async () => {
      const mockGetAuthToken =
        chrome.identity.getAuthToken as unknown as Mock;
      mockGetAuthToken.mockRejectedValue(new Error("No token"));

      await initSync();

      expect(mockSignInWithCredential).not.toHaveBeenCalled();
    });

    it("runs pullSync after successful auth", async () => {
      mockGetDocs.mockResolvedValue({ docs: [], empty: true });

      await initSync();

      expect(mockCollection).toHaveBeenCalled();
    });
  });

  // ─── Push Operations ───────────────────────────────────────────

  describe("pushEntries", () => {
    beforeEach(async () => {
      await initSync();
      vi.clearAllMocks();
      setupStorageMocks();
    });

    it("writes each entry as a Firestore doc with updatedAt and deleted fields", async () => {
      await pushEntries([sampleEntry]);

      expect(mockDoc).toHaveBeenCalledWith(
        expect.anything(),
        "users",
        "test-uid-123",
        "vocab",
        "银行",
      );
      expect(mockSetDoc).toHaveBeenCalledWith(
        mockDocRef,
        expect.objectContaining({
          chars: "银行",
          pinyin: "yín háng",
          definition: "bank",
          deleted: false,
          updatedAt: expect.any(Number),
        }),
        { merge: true },
      );
    });

    it("writes multiple entries", async () => {
      await pushEntries([sampleEntry, sampleEntry2]);

      expect(mockSetDoc).toHaveBeenCalledTimes(2);
    });

    it("skips when entries array is empty", async () => {
      await pushEntries([]);

      expect(mockSetDoc).not.toHaveBeenCalled();
    });

    it("sets deleted to false on pushed entries", async () => {
      await pushEntries([sampleEntry]);

      const setDocCall = mockSetDoc.mock.calls[0];
      expect(setDocCall[1].deleted).toBe(false);
    });

    it("uses merge: true to avoid overwriting unrelated fields", async () => {
      await pushEntries([sampleEntry]);

      const setDocCall = mockSetDoc.mock.calls[0];
      expect(setDocCall[2]).toEqual({ merge: true });
    });
  });

  describe("pushDelete", () => {
    beforeEach(async () => {
      await initSync();
      vi.clearAllMocks();
      setupStorageMocks();
    });

    it("sets deleted=true and refreshes updatedAt", async () => {
      await pushDelete("银行");

      expect(mockSetDoc).toHaveBeenCalledWith(
        mockDocRef,
        expect.objectContaining({
          deleted: true,
          updatedAt: expect.any(Number),
        }),
        { merge: true },
      );
    });

    it("references the correct doc path", async () => {
      await pushDelete("工作");

      expect(mockDoc).toHaveBeenCalledWith(
        expect.anything(),
        "users",
        "test-uid-123",
        "vocab",
        "工作",
      );
    });
  });

  describe("pushClear", () => {
    beforeEach(async () => {
      await initSync();
      vi.clearAllMocks();
      setupStorageMocks();
    });

    it("batch-deletes all user vocab docs", async () => {
      const docRef1 = { id: "doc1" };
      const docRef2 = { id: "doc2" };
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ ref: docRef1 }, { ref: docRef2 }],
        empty: false,
      });

      await pushClear();

      expect(mockBatchDelete).toHaveBeenCalledWith(docRef1);
      expect(mockBatchDelete).toHaveBeenCalledWith(docRef2);
      expect(mockBatchCommit).toHaveBeenCalled();
    });

    it("skips batch commit when no docs exist", async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });

      await pushClear();

      expect(mockBatchCommit).not.toHaveBeenCalled();
    });
  });

  // ─── Pull Operations ───────────────────────────────────────────

  describe("pullSync", () => {
    beforeEach(async () => {
      await initSync();
      vi.clearAllMocks();
      setupStorageMocks();
    });

    it("merges remote entries into the local store", async () => {
      const remoteDoc = makeVocabDoc(sampleEntry, 9000);
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => remoteDoc }],
        empty: false,
      });
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });

      await pullSync();

      const stored = store.get("vocabStore") as Record<string, VocabEntry>;
      expect(stored["银行"]).toBeDefined();
      expect(stored["银行"].chars).toBe("银行");
    });

    it("deletes locally when remote has deleted=true", async () => {
      store.set("vocabStore", {
        银行: { ...sampleEntry },
      });

      const deletedDoc = makeVocabDoc(sampleEntry, 9000, true);
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => deletedDoc }],
        empty: false,
      });
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });

      await pullSync();

      const stored = store.get("vocabStore") as Record<string, VocabEntry>;
      expect(stored["银行"]).toBeUndefined();
    });

    it("creates new local entries from remote-only entries", async () => {
      const remoteDoc = makeVocabDoc(sampleEntry2, 9000);
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => remoteDoc }],
        empty: false,
      });
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });

      await pullSync();

      const stored = store.get("vocabStore") as Record<string, VocabEntry>;
      expect(stored["工作"]).toBeDefined();
      expect(stored["工作"].pinyin).toBe("gōng zuò");
    });

    it("updates sync timestamp after pull", async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });

      const before = Date.now();
      await pullSync();

      const ts = await getLastSyncTimestamp();
      expect(ts).toBeGreaterThanOrEqual(before);
    });

    it("pushes local entries written while offline (reverse push)", async () => {
      await setLastSyncTimestamp(1000);

      store.set("vocabStore", {
        银行: { ...sampleEntry, lastSeen: 5000 },
      });

      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });

      await pullSync();

      expect(mockSetDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ chars: "银行", deleted: false }),
        { merge: true },
      );
    });

    it("runs cleanup of old deleted docs", async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });
      mockGetDocs.mockResolvedValueOnce({ docs: [], empty: true });

      await pullSync();

      expect(mockWhere).toHaveBeenCalledWith("deleted", "==", true);
    });
  });

  // ─── Conflict Resolution ───────────────────────────────────────

  describe("mergeEntries", () => {
    const localEntry: VocabEntry = {
      chars: "银行",
      pinyin: "yín háng",
      definition: "bank",
      count: 3,
      firstSeen: 1000,
      lastSeen: 5000,
      wrongStreak: 1,
      totalReviews: 5,
      totalCorrect: 3,
    };

    it("takes pinyin and definition from remote when remote is newer", () => {
      const remote = makeVocabDoc(
        { ...localEntry, pinyin: "yín xíng", definition: "bank (formal)", lastSeen: 8000 },
        9000,
      );

      const merged = mergeEntries(localEntry, remote);

      expect(merged.pinyin).toBe("yín xíng");
      expect(merged.definition).toBe("bank (formal)");
    });

    it("keeps local pinyin and definition when local is newer", () => {
      const remote = makeVocabDoc(
        { ...localEntry, pinyin: "old-pinyin", definition: "old-def", lastSeen: 2000 },
        3000,
      );

      const merged = mergeEntries(localEntry, remote);

      expect(merged.pinyin).toBe("yín háng");
      expect(merged.definition).toBe("bank");
    });

    it("uses Math.max for count", () => {
      const remote = makeVocabDoc(
        { ...localEntry, count: 10 },
        9000,
      );

      const merged = mergeEntries(localEntry, remote);
      expect(merged.count).toBe(10);

      const remote2 = makeVocabDoc(
        { ...localEntry, count: 1 },
        9000,
      );
      const merged2 = mergeEntries(localEntry, remote2);
      expect(merged2.count).toBe(3);
    });

    it("uses Math.min for firstSeen", () => {
      const remote = makeVocabDoc(
        { ...localEntry, firstSeen: 500 },
        9000,
      );

      const merged = mergeEntries(localEntry, remote);
      expect(merged.firstSeen).toBe(500);

      const remote2 = makeVocabDoc(
        { ...localEntry, firstSeen: 2000 },
        9000,
      );
      const merged2 = mergeEntries(localEntry, remote2);
      expect(merged2.firstSeen).toBe(1000);
    });

    it("uses Math.max for lastSeen", () => {
      const remote = makeVocabDoc(
        { ...localEntry, lastSeen: 8000 },
        9000,
      );

      const merged = mergeEntries(localEntry, remote);
      expect(merged.lastSeen).toBe(8000);

      const remote2 = makeVocabDoc(
        { ...localEntry, lastSeen: 2000 },
        3000,
      );
      const merged2 = mergeEntries(localEntry, remote2);
      expect(merged2.lastSeen).toBe(5000);
    });

    it("takes wrongStreak from whichever side has later lastSeen", () => {
      const remote = makeVocabDoc(
        { ...localEntry, wrongStreak: 5, lastSeen: 8000 },
        9000,
      );

      const merged = mergeEntries(localEntry, remote);
      expect(merged.wrongStreak).toBe(5);

      const remote2 = makeVocabDoc(
        { ...localEntry, wrongStreak: 5, lastSeen: 2000 },
        3000,
      );
      const merged2 = mergeEntries(localEntry, remote2);
      expect(merged2.wrongStreak).toBe(1);
    });

    it("uses Math.max for totalReviews", () => {
      const remote = makeVocabDoc(
        { ...localEntry, totalReviews: 10 },
        9000,
      );

      const merged = mergeEntries(localEntry, remote);
      expect(merged.totalReviews).toBe(10);
    });

    it("uses Math.max for totalCorrect", () => {
      const remote = makeVocabDoc(
        { ...localEntry, totalCorrect: 8 },
        9000,
      );

      const merged = mergeEntries(localEntry, remote);
      expect(merged.totalCorrect).toBe(8);
    });

    it("preserves chars (key) unchanged", () => {
      const remote = makeVocabDoc(localEntry, 9000);

      const merged = mergeEntries(localEntry, remote);
      expect(merged.chars).toBe("银行");
    });

    it("handles missing flashcard fields on remote (defaults to 0)", () => {
      const remote = makeVocabDoc(
        {
          chars: "银行",
          pinyin: "yín háng",
          definition: "bank",
          count: 1,
          firstSeen: 500,
          lastSeen: 2000,
        } as VocabEntry,
        3000,
      );

      const merged = mergeEntries(localEntry, remote);
      expect(merged.totalReviews).toBe(5);
      expect(merged.totalCorrect).toBe(3);
    });
  });

  // ─── Timestamp Persistence ─────────────────────────────────────

  describe("sync timestamp", () => {
    it("returns 0 when never synced", async () => {
      const ts = await getLastSyncTimestamp();
      expect(ts).toBe(0);
    });

    it("persists and retrieves the sync timestamp", async () => {
      await setLastSyncTimestamp(42000);

      const ts = await getLastSyncTimestamp();
      expect(ts).toBe(42000);
    });

    it("overwrites previous timestamp", async () => {
      await setLastSyncTimestamp(1000);
      await setLastSyncTimestamp(2000);

      const ts = await getLastSyncTimestamp();
      expect(ts).toBe(2000);
    });
  });

  // ─── Offline Resilience ────────────────────────────────────────

  describe("offline resilience", () => {
    beforeEach(async () => {
      await initSync();
      vi.clearAllMocks();
      setupStorageMocks();
    });

    it("logSyncError logs without throwing", () => {
      expect(() => logSyncError(new Error("network down"))).not.toThrow();
    });

    it("pushEntries failure does not throw", async () => {
      mockSetDoc.mockRejectedValueOnce(new Error("network error"));

      await expect(
        pushEntries([sampleEntry]).catch(logSyncError),
      ).resolves.not.toThrow();
    });

    it("pushDelete failure does not throw when caught", async () => {
      mockSetDoc.mockRejectedValueOnce(new Error("network error"));

      await expect(
        pushDelete("银行").catch(logSyncError),
      ).resolves.not.toThrow();
    });

    it("pushClear failure does not throw when caught", async () => {
      mockGetDocs.mockRejectedValueOnce(new Error("network error"));

      await expect(
        pushClear().catch(logSyncError),
      ).resolves.not.toThrow();
    });
  });

  // ─── Guard Checks ─────────────────────────────────────────────

  describe("guard checks (sync not initialized)", () => {
    it("pushEntries is a no-op when not initialized", async () => {
      vi.resetModules();
      vi.clearAllMocks();

      const freshModule = await import("../../src/background/sync-client");
      await freshModule.pushEntries([sampleEntry]);
      expect(mockSetDoc).not.toHaveBeenCalled();
    });
  });
});

# Firebase Setup Guide — Cloud Sync

This guide walks through the one-time setup required to enable cloud sync for the Pinyin Tool extension. Once complete, all users' vocabulary is automatically backed up to Firestore under their own Google UID, with no visible UI or user action required.

See also: [CLOUD_SYNC_SPEC.md](../Implementation_docs/CLOUD_SYNC_SPEC.md)

---

## Overview

The setup produces **8 values** that need to be filled into 2 source files before building:

| # | Value | File |
|---|-------|------|
| 1 | `apiKey` | `src/shared/firebase-config.ts` |
| 2 | `authDomain` | `src/shared/firebase-config.ts` |
| 3 | `projectId` | `src/shared/firebase-config.ts` |
| 4 | `storageBucket` | `src/shared/firebase-config.ts` |
| 5 | `messagingSenderId` | `src/shared/firebase-config.ts` |
| 6 | `appId` | `src/shared/firebase-config.ts` |
| 7 | OAuth client ID | `manifest.json` (`oauth2.client_id`) |
| 8 | Your Firebase UID | `src/background/sync-client.ts` (`SYNC_ALLOWED_UIDS`) |

Values 1–7 can be obtained before any build. Value 8 requires a working build with values 1–7 already in place.

---

## Step 1: Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Click **Add project**
3. Name it (e.g. `pinyin-tool`)
4. Google Analytics can be disabled — it is not used
5. Click **Create project**

---

## Step 2: Enable Authentication

1. In your Firebase project, go to **Security -> Authentication**
2. Click **Get started**
3. Under the **Sign-in method** tab, click **Google**
4. Toggle it to **Enabled**
5. Set a support email (your own email address)
6. Click **Save**

---

## Step 3: Create a Firestore Database

1. In the left sidebar, expand **Databases & Storage** and click **Firestore**
2. Click **Create database**
3. Choose a location closest to you geographically
4. Select **Production mode**
5. Click **Create**

---

## Step 4: Deploy Security Rules

1. In Firestore, click the **Rules** tab
2. Replace the entire contents with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/vocab/{word} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

3. Click **Publish**

These rules ensure each user can only read and write their own data. The full rules file is also at `firestore.rules` in the project root.

---

## Step 5: Register a Web App (values 1–6)

1. In Firebase Console, click **Settings** in the left sidebar -> **Project Settings**
2. Scroll down to the **Your apps** section
3. Click the **Web** icon (`</>`)
4. Give the app a nickname (e.g. `pinyin-extension`)
5. Leave **Firebase Hosting** unchecked
6. Click **Register app**
7. A code block appears with a `firebaseConfig` object. Copy these 6 values:
   - `apiKey`
   - `authDomain`
   - `projectId`
   - `storageBucket`
   - `messagingSenderId`
   - `appId`

Fill them into `src/shared/firebase-config.ts`.

---

## Step 6: Create an OAuth 2.0 Client ID (value 7)

This is needed for `chrome.identity.getAuthToken()` to work.

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Confirm the project selector at the top shows the **same project** as your Firebase project
3. Go to **APIs & Services -> Credentials**
4. Click **Create Credentials -> OAuth client ID**
5. For **Application type**, select **Chrome Extension**
6. For **Item ID**, enter your extension's Chrome ID:
   - Run `npm run build` to produce the `dist/` folder
   - In Chrome, go to `chrome://extensions`, enable **Developer mode**
   - Click **Load unpacked** and select the `dist/` folder
   - The extension ID appears under the extension name (a 32-character string like `abcdefghijklmnopqrstuvwxyz123456`)
   - Paste that ID into the Item ID field
7. Click **Create**
8. Copy the **client ID** (format: `123456789-xxxx.apps.googleusercontent.com`)

Fill it into `manifest.json` as the `oauth2.client_id` value.

---

## Step 7: Get Your Firebase UID (value 8)

Your UID only appears after you sign in through the extension for the first time.

1. With values 1–7 filled in, run `npm run build`
2. In Chrome, reload the unpacked extension (click the refresh icon on `chrome://extensions`)
3. Use the extension on any webpage — the service worker will authenticate silently on startup
4. Go to **Firebase Console -> Security -> Authentication -> Users** tab
5. Your Google account will appear with a **User UID** column
6. Copy that UID (format: `a1B2c3D4e5F6g7H8i9J0k1L2`)

Add it to `src/background/sync-client.ts` inside the `SYNC_ALLOWED_UIDS` set:

```typescript
const SYNC_ALLOWED_UIDS = new Set<string>([
  "YOUR_UID_HERE",
]);
```

Then run `npm run build` again.

---

## Recommended Order

Because value 8 depends on a working build with values 1–7:

1. Complete steps 1–6, fill in values 1–7, rebuild
2. Load the extension and trigger any page interaction
3. Retrieve value 8 from Firebase Console -> Security -> Authentication -> Users tab
4. Add your UID to the allowlist, rebuild one final time

---

## Opening Sync to All Users

When you are ready to enable sync for everyone, empty the `SYNC_ALLOWED_UIDS` set in `src/background/sync-client.ts`:

```typescript
const SYNC_ALLOWED_UIDS = new Set<string>([
  // empty = everyone allowed
]);
```

The gate check `SYNC_ALLOWED_UIDS.size > 0` only applies when the set is non-empty, so clearing it opens sync to all authenticated users automatically.

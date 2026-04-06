/**
 * Firebase project configuration.
 *
 * These values identify the Firebase project but do not grant access.
 * Access is controlled by Firestore security rules and the authenticated
 * user's UID. Replace the placeholder values with your Firebase project's
 * actual configuration from the Firebase Console.
 *
 * See: CLOUD_SYNC_SPEC.md Section 6 "Firebase Config"
 */

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

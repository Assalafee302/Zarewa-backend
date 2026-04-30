import admin from 'firebase-admin';

let initialized = false;

/**
 * Firebase Admin SDK (optional). Set FIREBASE_PROJECT_ID and either
 * GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON) or default
 * credentials (e.g. GCP metadata / gcloud auth application-default login).
 *
 * @returns {import('firebase-admin').app.App | null}
 */
export function getFirebaseAdminApp() {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  if (!projectId) return null;
  if (initialized && admin.apps.length > 0) {
    return admin.app();
  }
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ projectId });
    }
    initialized = true;
    return admin.app();
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<import('firebase-admin').auth.DecodedIdToken | null>}
 */
export async function verifyFirebaseIdToken(idToken) {
  const app = getFirebaseAdminApp();
  if (!app || !idToken) return null;
  try {
    return await admin.auth(app).verifyIdToken(String(idToken), true);
  } catch {
    return null;
  }
}

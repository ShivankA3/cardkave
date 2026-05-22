// Firebase web config — fill these in with values from your Firebase project.
// See SETUP_FIREBASE.md for a full walkthrough.
//
// Quick path:
//   1. https://console.firebase.google.com → create or open a project
//   2. Project settings (gear icon) → "Your apps" → add a Web app (</> icon)
//   3. Copy the firebaseConfig values Firebase shows you into the object below
//
// While apiKey is "REPLACE_ME", the app skips Firebase init and runs in
// local-only mode — nothing is sent to the cloud, no behavior changes.
const FIREBASE_CONFIG = {
  apiKey:            "REPLACE_ME",
  authDomain:        "REPLACE_ME.firebaseapp.com",
  projectId:         "REPLACE_ME",
  storageBucket:     "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId:             "REPLACE_ME",
};

(function initFirebase() {
  if (typeof firebase === "undefined") {
    console.warn("[firebase] SDK not loaded — cloud sync disabled.");
    window.firebaseReady = false;
    return;
  }
  if (!FIREBASE_CONFIG.apiKey || FIREBASE_CONFIG.apiKey === "REPLACE_ME") {
    console.warn(
      "[firebase] firebase-config.js still has placeholder values — " +
      "running in local-only mode. See SETUP_FIREBASE.md to enable cloud sync."
    );
    window.firebaseReady = false;
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    window.fbAuth = firebase.auth();
    window.fbDb = firebase.firestore();
    // Persist sign-in across reloads so the user stays signed in until they sign out.
    window.fbAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(e => {
      console.warn("[firebase] could not set auth persistence:", e);
    });
    window.firebaseReady = true;
    console.log("[firebase] initialized — cloud sync enabled.");
  } catch (e) {
    console.error("[firebase] init failed:", e);
    window.firebaseReady = false;
  }
})();

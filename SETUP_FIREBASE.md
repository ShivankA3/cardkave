# Wiring CardKave to Firebase

This guide turns on cloud sync for CardKave so user accounts, collections, wishlists, decks, posts, groups, events, and trades all live in Firestore — and stay in sync across devices.

You only have to do this once. Total time: ~10 minutes.

> **Important:** until you finish step 4, the app keeps running in local-only mode (everything in localStorage). You can ship this branch any time — it won't break anything for users.

---

## 1 · Create a Firebase project

1. Go to <https://console.firebase.google.com/>
2. Click **Add project** (or pick an existing one).
3. Name it (e.g. `cardkave`). Disable Google Analytics unless you want it.
4. Wait ~30 seconds for the project to be created, then **Continue**.

## 2 · Add a Web app to the project

1. On the project home, click the **`</>`** icon (Add app → Web).
2. Nickname it `cardkave-web`.
3. **Don't** check "Set up Firebase Hosting" — you're already on GitHub Pages.
4. Click **Register app**.
5. Firebase shows you a `firebaseConfig` object. Copy the values — you'll paste them in step 4.

If you ever need it again: Project settings (gear icon) → **Your apps** → SDK setup and configuration.

## 3 · Enable Authentication

1. Left sidebar → **Build → Authentication → Get started**.
2. **Sign-in method** tab.
3. Enable **Email/Password** (just the top toggle — leave passwordless off for now).
4. Enable **Google**:
   - Pick a "project support email" (your Google account is fine).
   - Save.
5. **Settings** tab → **Authorized domains** → add the domains the app will run on:
   - `cardkave.com`
   - `www.cardkave.com`
   - `localhost` (already there by default — needed for local dev)

## 4 · Paste your Firebase config

Open `firebase-config.js` in this repo. Replace the `REPLACE_ME` strings with the values from step 2:

```js
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSy…",
  authDomain:        "cardkave.firebaseapp.com",
  projectId:         "cardkave",
  storageBucket:     "cardkave.appspot.com",
  messagingSenderId: "1234567890",
  appId:             "1:1234567890:web:abc123…",
};
```

> **About the API key:** Firebase web `apiKey` is **not** secret — it's safe to commit to a public repo. It identifies your project to Firebase, but security comes from Authentication + Firestore rules (next step), not from hiding the key.

Reload the app. The console should print:

```
[firebase] initialized — cloud sync enabled.
```

If you see `running in local-only mode` instead, the placeholders weren't replaced.

## 5 · Create the Firestore database

1. Left sidebar → **Build → Firestore Database → Create database**.
2. **Start in production mode** (we'll publish proper rules in the next step).
3. Pick a region close to your users (e.g. `us-east1`, `europe-west1`). **You can't change this later.**
4. **Enable**.

## 6 · Publish the security rules

The file `firestore.rules` in this repo has the rules CardKave needs.

**Easy path (paste in console):**

1. Firestore Database → **Rules** tab.
2. Delete what's there.
3. Paste the contents of `firestore.rules`.
4. **Publish**.

**Or, with the Firebase CLI:**

```bash
npm install -g firebase-tools
firebase login
firebase init firestore        # pick the project, accept defaults
firebase deploy --only firestore:rules
```

> **About these rules:** per-user data (`users/{uid}/...`) is locked to the owner. Shared collections (posts, groups, events, trades, decks, templates) allow any signed-in user to read AND write any document — this matches the current app's behavior where likes/joins/attendance/trade replies all mutate other users' docs. See the comments in `firestore.rules` for how to tighten this later.

## 7 · Try it

1. Reload the app.
2. Sign up with an email + password — should land you on Browse.
3. Add a card to your collection.
4. Open Firestore Database in the console → you should see:
   - `users/<your uid>` (your profile)
   - `users/<your uid>/data/collection` (with a `cards` array)
5. Sign out, sign back in — collection persists.
6. Open the app on a different device or incognito window, sign in with the same account — your collection appears.

For Google sign-in: click the **Continue with Google** button. The Firebase popup handles everything — no extra config beyond step 3.

---

## What's stored where

```
users/{uid}                                 ← profile (name, email, location, isPaid, provider)
users/{uid}/data/collection                 ← { cards: [...] }
users/{uid}/data/wishlist                   ← { cards: [...] }

posts/{postId}                              ← feed posts (shared across all users)
groups/{groupId}                            ← groups
events/{eventId}                            ← events
trades/{tradeId}                            ← trade proposals + chat messages
decks/{deckId}                              ← decks
verifiedEventTemplates/{templateId}         ← admin-curated event templates
```

## Migration: what happens to existing localStorage data

The first time a user signs in after the upgrade, `cloud-sync.js` does a **one-time merge**:

- For per-user data (collection, wishlist, profile): if their cloud doc doesn't exist yet, it's seeded from their localStorage.
- For shared data (posts, groups, etc.): if the cloud collection is completely empty AND their localStorage has data, their local data is pushed up.

After that, cloud is the source of truth — localStorage just caches it for fast reads.

## Apple Sign-In

Apple sign-in **isn't wired up to Firebase** in this version. The button shows a friendly error when cloud sync is on. To add it later: Firebase Console → Authentication → Apple, plus an Apple Developer account ($99/year) for the Services ID.

## Costs

Firebase has a generous free tier (Spark plan):

- **Firestore:** 50K reads / 20K writes / 20K deletes per day, 1 GB storage
- **Authentication:** unlimited Email/Password, 50K monthly active users for federated providers

For a hobby Pokémon TCG app, you'll likely never leave the free tier. Firebase will email you long before you do.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Console: `[firebase] running in local-only mode` | `firebase-config.js` still has `REPLACE_ME` somewhere |
| `auth/operation-not-allowed` on signup | Email/Password not enabled in Authentication → Sign-in method |
| `auth/popup-blocked` on Google sign-in | Browser blocked the popup. Allow popups for the site |
| `auth/unauthorized-domain` on Google sign-in | The current origin isn't in Authentication → Settings → Authorized domains |
| `permission-denied` writing to Firestore | The rules in `firestore.rules` weren't published. See step 6 |
| User signs in but nothing syncs | Open DevTools → Network → look for `firestore.googleapis.com` calls failing. Usually a rules issue |

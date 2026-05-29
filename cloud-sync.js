// CardKave cloud sync — bridges localStorage to Firestore.
//
// Design:
//   - localStorage is the synchronous source of truth for the UI.
//   - When the user is signed in, every store.save() in app.js calls
//     cloudSync.push(KEY, value) which mirrors the write to Firestore.
//   - Realtime listeners on shared collections (posts, groups, events,
//     trades, decks, templates) push remote changes back into localStorage
//     and dispatch "cloudsync:change" so the UI re-renders.
//   - On first sign-in, if the cloud is empty for a key but localStorage
//     has data, we push the local data up (one-time merge). Otherwise the
//     cloud overwrites localStorage.
//
// If Firebase is not configured (firebase-config.js still has placeholder
// values), we expose a no-op stub so app.js works in local-only mode.

(function () {
  // ─── Stub for local-only mode ────────────────────────────────────────
  if (!window.firebaseReady) {
    window.cloudSync = {
      enabled: false,
      ready: Promise.resolve(),
      currentUser: null,
      currentUid: null,
      push() {},
      signInWithEmail()   { return Promise.reject(new Error("Cloud sync is not configured. See SETUP_FIREBASE.md.")); },
      signUpWithEmail()   { return Promise.reject(new Error("Cloud sync is not configured. See SETUP_FIREBASE.md.")); },
      signInWithGoogle()  { return Promise.reject(new Error("Cloud sync is not configured. See SETUP_FIREBASE.md.")); },
      updateProfile()     { return Promise.resolve(null); },
      signOut()           { return Promise.resolve(); },
    };
    return;
  }

  const auth = window.fbAuth;
  const db = window.fbDb;

  // ─── Schema: which localStorage keys map to which Firestore paths ────
  // Per-user: one Firestore doc per key, owned by the signed-in user.
  //   shape: "object" → write the whole object as the doc
  //   shape: "array"  → wrap as { [field]: array } in the doc
  const PER_USER = {
    "user-profile":     { doc: "__profile__", shape: "object" }, // special: user doc itself
    "collection-cards": { doc: "collection",  shape: "array", field: "cards" },
    "wishlist-cards":   { doc: "wishlist",    shape: "array", field: "cards" },
  };

  // Shared: one Firestore doc per array item, top-level collection.
  //   primitive: true means the item is a string (not an object).
  const SHARED = {
    "feed-posts":               { col: "posts" },
    "feed-groups":              { col: "groups" },
    "feed-events":              { col: "events" },
    "trades":                   { col: "trades" },
    "decks":                    { col: "decks" },
    "verified-event-templates": { col: "verifiedEventTemplates", primitive: true },
  };

  // Public trade profiles — each user owns the doc keyed by their uid.
  // Anyone signed in can read every profile (so we can compute matches),
  // but only the owner can write their own. Read-only here; writes go
  // through pushMyTradeProfile() after collection/wishlist/profile edits.
  const TRADE_PROFILE_COL = "tradeProfiles";
  const TRADE_PROFILE_KEY = "trade-profiles";

  // ─── State ───────────────────────────────────────────────────────────
  let currentUid = null;
  // Snapshot of last-known-cloud state for shared collections, so saves
  // can compute deltas (writes/deletes) instead of replacing the whole set.
  const sharedSnapshots = {}; // key → Map<docId, JSON-string>
  // Track in-flight writes per shared collection so the listener can
  // distinguish "echo of my own write" from "another client wrote this."
  const inFlightWrites = {};  // key → Set<docId>
  const subs = []; // unsubscribe fns from realtime listeners

  function clearSubs() {
    while (subs.length) { try { subs.pop()(); } catch {} }
    Object.keys(sharedSnapshots).forEach(k => delete sharedSnapshots[k]);
    Object.keys(inFlightWrites).forEach(k => delete inFlightWrites[k]);
  }

  function emit(detail) {
    window.dispatchEvent(new CustomEvent("cloudsync:change", { detail }));
  }

  // Resolved on the first auth state change so app.js can wait for
  // persisted-session resolution before its initial render.
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  // ─── Public API ──────────────────────────────────────────────────────
  window.cloudSync = {
    enabled: true,
    ready,
    currentUser: null,
    currentUid: null,
    push,
    signInWithEmail,
    signUpWithEmail,
    signInWithGoogle,
    updateProfile,
    signOut: () => auth.signOut(),
  };

  // ─── Auth state ──────────────────────────────────────────────────────
  let firstAuthStateResolved = false;
  auth.onAuthStateChanged(async user => {
    clearSubs();
    if (!user) {
      currentUid = null;
      window.cloudSync.currentUser = null;
      window.cloudSync.currentUid = null;
      // Clear any per-user keys from localStorage so signing in as a
      // different user on the same device doesn't leak stale data.
      Object.keys(PER_USER).forEach(k => localStorage.removeItem(k));
      // Trade profiles is shared/public, but it includes other users'
      // data scoped to the prior session — clear it so a new sign-in
      // re-hydrates cleanly.
      localStorage.removeItem(TRADE_PROFILE_KEY);
      if (tradeProfileTimer) { clearTimeout(tradeProfileTimer); tradeProfileTimer = null; }
      if (!firstAuthStateResolved) { firstAuthStateResolved = true; resolveReady(); }
      emit({ reason: "signout" });
      return;
    }
    currentUid = user.uid;
    window.cloudSync.currentUser = user;
    window.cloudSync.currentUid = user.uid;
    try {
      await hydratePerUser(user);
      subscribeShared();
      subscribeTradeProfiles();
      // Refresh our public trade profile from whatever local state we just hydrated.
      pushMyTradeProfile();
      if (!firstAuthStateResolved) { firstAuthStateResolved = true; resolveReady(); }
      emit({ reason: "signin" });
    } catch (e) {
      console.error("[cloudSync] hydrate failed:", e);
      if (!firstAuthStateResolved) { firstAuthStateResolved = true; resolveReady(); }
      emit({ reason: "signin-error", error: e });
    }
  });

  // ─── Per-user hydration ──────────────────────────────────────────────
  async function hydratePerUser(user) {
    for (const [key, schema] of Object.entries(PER_USER)) {
      const ref = userRef(user.uid, schema.doc);
      const snap = await ref.get();
      const localRaw = localStorage.getItem(key);
      const local = localRaw == null ? null : safeParse(localRaw);
      if (snap.exists) {
        const data = snap.data();
        const cloudValue = schema.shape === "array" ? (data[schema.field] || []) : data;
        // For arrays (collection/wishlist), if local has unique items not in cloud
        // (offline edits), merge them. Otherwise prefer cloud.
        if (schema.shape === "array" && Array.isArray(local) && local.length) {
          const merged = mergeArrayById(cloudValue, local);
          localStorage.setItem(key, JSON.stringify(merged));
          if (merged.length !== cloudValue.length) {
            ref.set({ [schema.field]: merged }, { merge: true }).catch(noop);
          }
        } else {
          localStorage.setItem(key, JSON.stringify(cloudValue));
        }
      } else if (local != null) {
        // First-time sign-in for this user: push local up.
        const data = schema.shape === "array" ? { [schema.field]: local } : local;
        await ref.set(data, { merge: true });
      }
    }
  }

  function mergeArrayById(cloud, local) {
    const out = Array.isArray(cloud) ? cloud.slice() : [];
    const byId = new Map(out.filter(x => x && x.id).map(x => [x.id, x]));
    for (const item of local) {
      if (item && item.id && !byId.has(item.id)) {
        out.push(item);
        byId.set(item.id, item);
      }
    }
    return out;
  }

  // ─── Shared subscriptions (realtime) ─────────────────────────────────
  function subscribeShared() {
    for (const [key, schema] of Object.entries(SHARED)) {
      const colRef = db.collection(schema.col);
      let firstSnapshot = true;
      const unsub = colRef.onSnapshot(snap => {
        const items = [];
        const newSnapshot = new Map();
        snap.forEach(d => {
          const data = d.data();
          if (schema.primitive) {
            items.push(data.value);
            newSnapshot.set(d.id, JSON.stringify({ value: data.value }));
          } else {
            const item = { ...data, id: d.id };
            items.push(item);
            newSnapshot.set(d.id, JSON.stringify(item));
          }
        });

        // First snapshot + cloud is empty + we have local data → push local up.
        if (firstSnapshot && snap.empty) {
          const local = safeParse(localStorage.getItem(key)) || [];
          if (Array.isArray(local) && local.length) {
            sharedSnapshots[key] = new Map();
            firstSnapshot = false;
            pushSharedDiff(key, local, schema);
            return; // wait for the next snapshot to apply changes.
          }
        }
        firstSnapshot = false;
        sharedSnapshots[key] = newSnapshot;
        localStorage.setItem(key, JSON.stringify(items));
        emit({ reason: "shared-update", key });
      }, err => console.warn(`[cloudSync] ${schema.col} listener error:`, err));
      subs.push(unsub);
    }
  }

  // ─── Write-through: called from store.save() in app.js ───────────────
  function push(key, value) {
    if (!currentUid) return;
    if (PER_USER[key]) {
      pushPerUser(key, value);
      // Anything that changes our public-facing trade data must re-publish
      // the trade profile so other clients see fresh matches.
      if (key === "collection-cards" || key === "wishlist-cards" || key === "user-profile") {
        pushMyTradeProfile();
      }
      return;
    }
    if (SHARED[key])   return pushSharedDiff(key, value, SHARED[key]);
  }

  function pushPerUser(key, value) {
    const schema = PER_USER[key];
    const ref = userRef(currentUid, schema.doc);
    const data = schema.shape === "array" ? { [schema.field]: value || [] } : (value || {});
    ref.set(data, { merge: true }).catch(err => {
      console.warn(`[cloudSync] push ${key} failed:`, err);
    });
  }

  function pushSharedDiff(key, items, schema) {
    if (!Array.isArray(items)) return;
    const colRef = db.collection(schema.col);
    const prev = sharedSnapshots[key] || new Map();
    const next = new Map();
    const writes = [];
    const deletes = [];

    for (const item of items) {
      const docId = schema.primitive ? slugify(item) : (item && item.id ? String(item.id) : null);
      if (!docId) continue;
      const docData = schema.primitive
        ? { value: item }
        : stampOwnership({ ...item, id: docId });
      const serialized = JSON.stringify(schema.primitive ? { value: item } : docData);
      next.set(docId, serialized);
      if (prev.get(docId) !== serialized) writes.push({ docId, docData });
    }
    for (const docId of prev.keys()) {
      if (!next.has(docId)) deletes.push(docId);
    }

    if (!writes.length && !deletes.length) return;
    sharedSnapshots[key] = next;

    // Firestore batch limit is 500 ops. Split if needed.
    const ops = [...writes.map(w => ["set", w]), ...deletes.map(id => ["del", id])];
    for (let i = 0; i < ops.length; i += 450) {
      const batch = db.batch();
      for (const [kind, payload] of ops.slice(i, i + 450)) {
        if (kind === "set") batch.set(colRef.doc(payload.docId), payload.docData);
        else                batch.delete(colRef.doc(payload));
      }
      batch.commit().catch(err => {
        console.warn(`[cloudSync] push ${key} batch failed:`, err);
      });
    }
  }

  function stampOwnership(item) {
    // For shared items, stamp the creating user's UID so security rules
    // can authorize edits. Don't overwrite if already present (older items).
    if (currentUid && !item.authorUid) item.authorUid = currentUid;
    return item;
  }

  // ─── Auth helpers (used by app.js renderLogin/renderSignup) ──────────
  async function signInWithEmail(email, password) {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    return cred.user;
  }

  async function signUpWithEmail({ name, email, password, location }) {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    if (name) {
      try { await cred.user.updateProfile({ displayName: name }); } catch (e) { console.warn(e); }
    }
    // Seed the user-profile doc with location/displayName/etc.
    const profile = {
      name:     name || cred.user.displayName || (email || "").split("@")[0],
      email:    email || cred.user.email || "",
      location: location || "",
      isPaid:   false,
      provider: "email",
      createdAt: Date.now(),
    };
    await db.collection("users").doc(cred.user.uid).set(profile, { merge: true });
    localStorage.setItem("user-profile", JSON.stringify(profile));
    return cred.user;
  }

  async function signInWithGoogle({ location } = {}) {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.addScope("email");
    provider.addScope("profile");
    const cred = await auth.signInWithPopup(provider);
    // For brand-new Google accounts, seed the profile doc.
    const docRef = db.collection("users").doc(cred.user.uid);
    const snap = await docRef.get();
    if (!snap.exists) {
      const profile = {
        name:     cred.user.displayName || (cred.user.email || "").split("@")[0],
        email:    cred.user.email || "",
        location: location || "",
        isPaid:   false,
        provider: "google",
        createdAt: Date.now(),
      };
      await docRef.set(profile, { merge: true });
      localStorage.setItem("user-profile", JSON.stringify(profile));
    }
    return cred.user;
  }

  async function updateProfile(patch) {
    if (!currentUid) return null;
    const ref = db.collection("users").doc(currentUid);
    await ref.set(patch, { merge: true });
    if (patch.name && auth.currentUser) {
      try { await auth.currentUser.updateProfile({ displayName: patch.name }); } catch {}
    }
    // Mirror the merged profile back to localStorage.
    const snap = await ref.get();
    if (snap.exists) localStorage.setItem("user-profile", JSON.stringify(snap.data()));
    return snap.exists ? snap.data() : null;
  }

  // ─── Public trade profiles ───────────────────────────────────────────
  // Subscribe to every user's trade profile so the Trades page can compute
  // matches locally. The current user's own profile is included; app.js
  // filters it out by uid before matching.
  function subscribeTradeProfiles() {
    const ref = db.collection(TRADE_PROFILE_COL);
    const unsub = ref.onSnapshot(snap => {
      const items = [];
      snap.forEach(d => items.push({ ...d.data(), uid: d.id }));
      localStorage.setItem(TRADE_PROFILE_KEY, JSON.stringify(items));
      emit({ reason: "shared-update", key: TRADE_PROFILE_KEY });
    }, err => console.warn("[cloudSync] tradeProfiles listener error:", err));
    subs.push(unsub);
  }

  function buildMyTradeProfile() {
    const profile = safeParse(localStorage.getItem("user-profile")) || {};
    const coll = safeParse(localStorage.getItem("collection-cards")) || [];
    const wish = safeParse(localStorage.getItem("wishlist-cards")) || [];
    return {
      name: String(profile.name || "").trim(),
      location: String(profile.location || "").trim(),
      avatarColor: profile.avatarColor || "",
      initials: profile.initials || "",
      collection: Array.isArray(coll) ? coll : [],
      wishlist:   Array.isArray(wish) ? wish : [],
      updatedAt: Date.now(),
    };
  }

  // Debounce so a burst of qty +/- clicks only writes once.
  let tradeProfileTimer = null;
  function pushMyTradeProfile() {
    if (!currentUid) return;
    if (tradeProfileTimer) clearTimeout(tradeProfileTimer);
    tradeProfileTimer = setTimeout(() => {
      tradeProfileTimer = null;
      if (!currentUid) return;
      const profile = buildMyTradeProfile();
      if (!profile.name) return; // wait until profile is set up
      db.collection(TRADE_PROFILE_COL).doc(currentUid)
        .set(profile)
        .catch(err => console.warn("[cloudSync] pushMyTradeProfile failed:", err));
    }, 600);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────
  function userRef(uid, docName) {
    if (docName === "__profile__") return db.collection("users").doc(uid);
    return db.collection("users").doc(uid).collection("data").doc(docName);
  }
  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200) || "_";
  }
  function noop() {}
})();

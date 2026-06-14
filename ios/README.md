# CardKave for iOS

A native iOS wrapper around the CardKave web app. It's a thin SwiftUI app that
hosts the existing web app in a `WKWebView`, so you build and run it straight
from Xcode on the Simulator or a real device.

## Run it

```sh
open ios/CardKave.xcodeproj
```

Then in Xcode:

1. Pick a destination (e.g. **iPhone 17** Simulator) in the toolbar.
2. Press **⌘R** (Run).

That's it for the Simulator — no signing or accounts required.

### Run on your iPhone

1. Plug in your iPhone and select it as the destination.
2. Select the **CardKave** target → **Signing & Capabilities** → set **Team** to
   your Apple ID (Xcode → Settings → Accounts to add one; a free account works).
3. Press **⌘R**. Approve the developer profile on the phone under
   *Settings → General → VPN & Device Management* the first time.

## How it works

- The web app (`index.html`, `app.js`, `styles.css`, `cloud-sync.js`,
  `firebase-config.js`, `data/`) lives at the repo root, exactly as it ships to
  the web. **Nothing is duplicated.**
- A build phase, **"Copy CardKave Web Assets"**, copies those files into the app
  bundle's `www/` folder on every build — so the iOS app always runs your latest
  web code. Just edit the web files and press Run again.
- `LocalServer.swift` runs a tiny embedded HTTP server (built on
  Network.framework, no dependencies) that serves `www/` on `http://localhost`.
  The web app loads from there. **This matters:** the app uses Firebase Auth,
  which only finishes initializing on an *authorized domain*. `localhost` is one
  by default; a `file://` or custom-scheme origin is not, so Firebase's auth
  state never resolves and the app hangs on a blank screen during boot. Loading
  over `localhost` makes it behave exactly like the website while still bundling
  your local code.
- `WebView.swift` injects a tiny script that reports the in-app light/dark theme
  back to native, so the status bar and safe-area background match.

Card images, the Pokémon TCG API, Firebase (Firestore + email/password auth),
jsPDF, and EmailJS all load from their normal HTTPS CDNs at runtime, so the app
needs a network connection for those, just like the website.

## Google Sign-In (native)

`signInWithPopup` doesn't work inside a WKWebView, so Google sign-in runs
natively via `ASWebAuthenticationSession` ([GoogleSignIn.swift](CardKave/GoogleSignIn.swift)):
it does the OAuth + PKCE flow in Apple's secure system browser, gets a Google ID
token, and hands it to the web app's Firebase through `signInWithCredential`
(`cloud-sync.js`). No third-party SDK.

**One-time setup — add an iOS OAuth client ID:**

1. Firebase console → project **cardkave-20781** → **Project settings** →
   **General** → **Your apps** → **Add app** → **iOS**. Use bundle ID
   **`com.cardkave.app`**. (You can skip downloading the config plist and the
   SDK steps — we only need the client ID it creates.)
2. Copy the new **iOS client ID** (looks like
   `1050098822847-xxxx.apps.googleusercontent.com`).
3. Paste it into `clientID` at the top of
   [GoogleSignIn.swift](CardKave/GoogleSignIn.swift) and rebuild.

That's it — no Info.plist URL scheme needed (`ASWebAuthenticationSession`
handles the callback). While `clientID` is empty, the app falls back to the
(non-working) web popup, so nothing breaks before you set it.

Email/password sign-in works with no setup.

## Known limitation

- **PDF / file export** (jsPDF "download") won't save to Files, because
  WKWebView doesn't handle blob downloads without a native bridge
  (a `WKDownloadDelegate`). Ask if you want it wired up.

## Updating the bundled card data

`data/` is copied at build time, so just rebuild after running `dump.mjs` (or
whatever regenerates it) at the repo root.

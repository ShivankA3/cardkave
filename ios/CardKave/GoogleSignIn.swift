import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

/// Native Google Sign-In for the iOS wrapper.
///
/// The web app signs in with Firebase `signInWithPopup`, which WKWebView blocks
/// (and Google rejects OAuth inside embedded web views). Instead we run the
/// OAuth 2.0 Authorization-Code + PKCE flow in `ASWebAuthenticationSession` —
/// Apple's secure system browser, which Google permits — obtain a Google ID
/// token, and hand it to the web app's Firebase via `signInWithCredential`
/// (see WebView's bridge and cloud-sync.js). No third-party SDK required.
final class GoogleSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {

    // ─────────────────────────────────────────────────────────────────────────
    // PASTE YOUR iOS OAUTH CLIENT ID HERE.
    //
    // Get it from the Firebase console for project "cardkave-20781":
    //   Project Settings → General → "Add app" → iOS  (bundle ID: com.cardkave.app)
    // or Google Cloud console → APIs & Services → Credentials →
    //   Create credentials → OAuth client ID → iOS  (bundle ID: com.cardkave.app)
    //
    // It looks like: 1050098822847-xxxxxxxxxxxx.apps.googleusercontent.com
    // While this is empty, the app falls back to the (non-working) web popup.
    static let clientID = "1050098822847-fda9294jtap1croj8hnb800fmfi2de60.apps.googleusercontent.com"
    // ─────────────────────────────────────────────────────────────────────────

    static var isConfigured: Bool { !clientID.isEmpty }

    enum SignInError: LocalizedError {
        case notConfigured, cancelled, badResponse(String)
        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Google Sign-In is not configured (missing iOS client ID)."
            case .cancelled:     return "Sign-in was cancelled."
            case .badResponse(let m): return "Google Sign-In failed: \(m)"
            }
        }
    }

    private var session: ASWebAuthenticationSession?
    private weak var anchor: UIWindow?

    /// Runs the full flow and returns a Google ID token + access token.
    func signIn(presentationAnchor: UIWindow?,
                completion: @escaping (Result<(idToken: String, accessToken: String), Error>) -> Void) {
        guard Self.isConfigured else { completion(.failure(SignInError.notConfigured)); return }
        anchor = presentationAnchor

        let reversed = Self.reversedClientID(Self.clientID)
        let redirectURI = "\(reversed):/oauth2redirect"
        let verifier = Self.randomURLSafe(64)
        let challenge = Self.codeChallenge(for: verifier)
        let state = Self.randomURLSafe(32)

        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: Self.clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "prompt", value: "select_account"),
        ]
        guard let authURL = components.url else {
            completion(.failure(SignInError.badResponse("could not build auth URL"))); return
        }

        let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: reversed) { [weak self] callbackURL, error in
            guard let self = self else { return }
            if let error = error {
                let nsError = error as NSError
                if nsError.domain == ASWebAuthenticationSessionError.errorDomain,
                   nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                    completion(.failure(SignInError.cancelled))
                } else {
                    completion(.failure(error))
                }
                return
            }
            guard let callbackURL = callbackURL,
                  let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems,
                  items.first(where: { $0.name == "state" })?.value == state,
                  let code = items.first(where: { $0.name == "code" })?.value else {
                let returned = callbackURL.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems }
                let oauthError = returned?.first(where: { $0.name == "error" })?.value
                completion(.failure(SignInError.badResponse(oauthError ?? "no authorization code")))
                return
            }
            self.exchange(code: code, verifier: verifier, redirectURI: redirectURI, completion: completion)
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        session.start()
    }

    /// Exchanges the authorization code for tokens at Google's token endpoint.
    private func exchange(code: String, verifier: String, redirectURI: String,
                          completion: @escaping (Result<(idToken: String, accessToken: String), Error>) -> Void) {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let form = [
            "client_id": Self.clientID,
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirectURI,
        ].map { "\($0.key)=\(Self.formEncode($0.value))" }.joined(separator: "&")
        request.httpBody = Data(form.utf8)

        URLSession.shared.dataTask(with: request) { data, _, error in
            let finish: (Result<(idToken: String, accessToken: String), Error>) -> Void = { result in
                DispatchQueue.main.async { completion(result) }
            }
            if let error = error { finish(.failure(error)); return }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                finish(.failure(SignInError.badResponse("invalid token response"))); return
            }
            if let idToken = json["id_token"] as? String {
                finish(.success((idToken, json["access_token"] as? String ?? "")))
            } else {
                let message = (json["error_description"] as? String)
                    ?? (json["error"] as? String) ?? "no id_token in response"
                finish(.failure(SignInError.badResponse(message)))
            }
        }.resume()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor ?? ASPresentationAnchor()
    }

    // MARK: - Helpers

    /// "<id>.apps.googleusercontent.com" → "com.googleusercontent.apps.<id>"
    static func reversedClientID(_ clientID: String) -> String {
        let base = clientID.replacingOccurrences(of: ".apps.googleusercontent.com", with: "")
        return "com.googleusercontent.apps.\(base)"
    }

    static func randomURLSafe(_ byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        _ = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        return Data(bytes).base64URLEncodedString()
    }

    static func codeChallenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
    }

    static func formEncode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

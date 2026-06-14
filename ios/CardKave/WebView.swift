import SwiftUI
import UIKit
import WebKit

/// State shared between the web view and SwiftUI. Currently just the active
/// theme, which the web app reports through the `themeChange` message handler.
final class WebViewModel: ObservableObject {
    enum Theme { case dark, light }
    @Published var theme: Theme = .dark
}

/// A SwiftUI wrapper around a WKWebView that loads the bundled CardKave web app
/// over a local `http://localhost` server (see LocalServer for why).
struct WebView: UIViewRepresentable {
    @ObservedObject var model: WebViewModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "themeChange")
        controller.add(context.coordinator, name: "googleSignIn")
        controller.addUserScript(WKUserScript(source: Self.themeBridgeJS,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(source: Self.googleBridgeJS(configured: GoogleSignIn.isConfigured),
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        configuration.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        // The SwiftUI container already insets for the safe area, so don't let
        // the scroll view add a second adjustment on top.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // Allow Safari Web Inspector to attach to this test build.
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        context.coordinator.webView = webView

        // Serve the bundled web app over http://localhost so Firebase Auth — which
        // only initializes on an authorized domain (localhost is authorized by
        // default) — works exactly as it does on the website. Loading from a
        // custom scheme or file:// leaves Firebase's auth state unresolved and
        // the app never finishes booting.
        let wwwRoot = Bundle.main.bundleURL.appendingPathComponent("www", isDirectory: true)
        let server = LocalServer(root: wwwRoot)
        context.coordinator.server = server
        server.start { port in
            guard let url = URL(string: "http://localhost:\(port)/index.html") else { return }
            webView.load(URLRequest(url: url))
        }
        context.coordinator.observeAppLifecycle()
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "themeChange")
        controller.removeScriptMessageHandler(forName: "googleSignIn")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        let model: WebViewModel
        weak var webView: WKWebView?
        var server: LocalServer?
        private var googleSignIn: GoogleSignIn?
        private var foregroundObserver: NSObjectProtocol?
        private var hasLoadedOnce = false

        init(model: WebViewModel) { self.model = model }

        deinit {
            if let observer = foregroundObserver {
                NotificationCenter.default.removeObserver(observer)
            }
        }

        /// Recover the page when the app returns to the foreground. While the app
        /// is backgrounded, iOS tears down the loopback server and may jettison
        /// the web content process — which otherwise leaves the page unstyled
        /// (the CSS re-fetch hits a dead server) or blank on resume.
        func observeAppLifecycle() {
            foregroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in self?.handleForeground() }
        }

        private func handleForeground() {
            guard hasLoadedOnce, let server = server, let webView = webView else { return }
            server.ensureRunning { [weak self] port, didRestart in
                guard let self = self else { return }
                if didRestart {
                    // Server was rebuilt on a new port — reload onto it.
                    self.reload(webView, port: port)
                    return
                }
                // Server survived: only reload if the page lost its styles
                // (stylesheet re-fetch failed on resume).
                webView.evaluateJavaScript("document.styleSheets.length") { result, _ in
                    if let count = (result as? NSNumber)?.intValue, count == 0 {
                        self.reload(webView, port: port)
                    }
                }
            }
        }

        private func reload(_ webView: WKWebView, port: UInt16) {
            let fragment = webView.url?.fragment.map { "#\($0)" } ?? ""
            guard let url = URL(string: "http://localhost:\(port)/index.html\(fragment)") else { return }
            webView.load(URLRequest(url: url))
        }

        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            switch message.name {
            case "themeChange":
                let isLight = (message.body as? String) == "light"
                DispatchQueue.main.async { self.model.theme = isLight ? .light : .dark }
            case "googleSignIn":
                guard let body = message.body as? [String: Any], let id = body["id"] as? String else { return }
                startGoogleSignIn(requestID: id)
            default:
                break
            }
        }

        /// Runs the native Google flow and resolves the JS promise (set up by the
        /// bridge script) with the resulting tokens — or an error.
        private func startGoogleSignIn(requestID id: String) {
            let google = GoogleSignIn()
            googleSignIn = google  // retain for the duration of the flow
            google.signIn(presentationAnchor: webView?.window) { [weak self] result in
                guard let self = self, let webView = self.webView else { return }
                let payload: String
                switch result {
                case .success(let tokens):
                    payload = "{\"idToken\":\(Self.jsString(tokens.idToken)),"
                        + "\"accessToken\":\(Self.jsString(tokens.accessToken))}"
                case .failure(let error):
                    payload = "{\"error\":\(Self.jsString(error.localizedDescription))}"
                }
                let js = "window.__cardkaveResolveGoogleSignIn(\(Self.jsString(id)), \(payload));"
                webView.evaluateJavaScript(js, completionHandler: nil)
                self.googleSignIn = nil
            }
        }

        /// JSON-encodes a Swift string into a JS string literal (safely escaped).
        static func jsString(_ value: String) -> String {
            guard let data = try? JSONSerialization.data(withJSONObject: [value]),
                  let array = String(data: data, encoding: .utf8) else { return "\"\"" }
            return String(array.dropFirst().dropLast())  // strip the surrounding [ ]
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            hasLoadedOnce = true
        }

        // If iOS jettisons the web content process while backgrounded, the view
        // returns blank — make sure the server is up and reload.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            server?.ensureRunning { [weak self] port, _ in
                self?.reload(webView, port: port)
            }
        }

        // Outbound links opened in a new window (target="_blank") have no frame
        // to land in, so hand them to Safari instead of dead-ending.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url, navigationAction.targetFrame == nil {
                UIApplication.shared.open(url)
            }
            return nil
        }
    }

    /// Injected at document start. Reports the current `data-theme` on <html> to
    /// native and keeps reporting whenever the web app toggles light/dark.
    static let themeBridgeJS = """
    (function () {
      function theme() {
        try {
          return document.documentElement.getAttribute('data-theme') === 'light'
            ? 'light' : 'dark';
        } catch (e) { return 'dark'; }
      }
      function send() {
        try { window.webkit.messageHandlers.themeChange.postMessage(theme()); }
        catch (e) {}
      }
      send();
      try {
        new MutationObserver(send).observe(document.documentElement, {
          attributes: true, attributeFilter: ['data-theme']
        });
      } catch (e) {}
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', send);
      }
      window.addEventListener('load', function () { setTimeout(send, 60); });
    })();
    """

    /// Bridge for native Google Sign-In. Exposes `__cardkaveNativeGoogleSignIn()`
    /// (returns a Promise of {idToken, accessToken}) and the resolver the native
    /// side calls back into. `__cardkaveHasNativeGoogle` tells the web app whether
    /// to use this path instead of the (WKWebView-blocked) Firebase popup.
    static func googleBridgeJS(configured: Bool) -> String {
        """
        (function () {
          var hasHandler = !!(window.webkit && window.webkit.messageHandlers
                              && window.webkit.messageHandlers.googleSignIn);
          window.__cardkaveHasNativeGoogle = \(configured ? "true" : "false") && hasHandler;
          if (!hasHandler) return;
          var pending = {}, seq = 0;
          window.__cardkaveNativeGoogleSignIn = function () {
            return new Promise(function (resolve, reject) {
              var id = String(++seq);
              pending[id] = { resolve: resolve, reject: reject };
              try { window.webkit.messageHandlers.googleSignIn.postMessage({ id: id }); }
              catch (e) { delete pending[id]; reject(e); }
            });
          };
          window.__cardkaveResolveGoogleSignIn = function (id, payload) {
            var p = pending[id];
            if (!p) return;
            delete pending[id];
            if (payload && payload.error) reject(p, payload.error);
            else p.resolve(payload || {});
          };
          function reject(p, message) { p.reject(new Error(message)); }
        })();
        """
    }
}

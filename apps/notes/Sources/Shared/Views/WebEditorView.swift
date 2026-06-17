import Foundation
import SwiftUI
@preconcurrency import WebKit

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
struct WebEditorView {
    let document: NoteDocument
    let savedQueryViews: [SavedQueryView]
    let onChange: (_ documentID: UUID, _ title: String, _ contentJSON: String, _ plainText: String) -> Void
    let onEntityUpsert: (_ name: String, _ supertagNames: [String], _ properties: [String: String]?) throws -> EntityReference
    let onQueryRun: (_ query: String) throws -> QueryResult
    let onSavedQueryViewCreate: (
        _ name: String,
        _ query: String,
        _ view: String,
        _ groupBy: String?,
        _ visibleColumns: [String],
        _ sortColumn: String?,
        _ sortDescending: Bool,
        _ rowLimit: Int?
    ) throws -> SavedQueryView
    let onOpenDocument: (_ documentID: UUID) -> Void
    let onOpenEntity: (_ entityID: UUID) -> Void
    let onReady: () -> Void
    let onError: (_ message: String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            savedQueryViews: savedQueryViews,
            onChange: onChange,
            onEntityUpsert: onEntityUpsert,
            onQueryRun: onQueryRun,
            onSavedQueryViewCreate: onSavedQueryViewCreate,
            onOpenDocument: onOpenDocument,
            onOpenEntity: onOpenEntity,
            onReady: onReady,
            onError: onError
        )
    }

    private func makeWebView(coordinator: Coordinator) -> WKWebView {
        let userContentController = WKUserContentController()
        userContentController.add(coordinator, name: "notesBridge")
        userContentController.addUserScript(Self.diagnosticsScript)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = userContentController
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(
            EditorResourceSchemeHandler(),
            forURLScheme: EditorResourceSchemeHandler.scheme
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        coordinator.webView = webView
        coordinator.loadEditorHTML()
        return webView
    }

    private func updateWebView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.onChange = onChange
        coordinator.onEntityUpsert = onEntityUpsert
        coordinator.onQueryRun = onQueryRun
        coordinator.onSavedQueryViewCreate = onSavedQueryViewCreate
        coordinator.onOpenDocument = onOpenDocument
        coordinator.onOpenEntity = onOpenEntity
        coordinator.onReady = onReady
        coordinator.onError = onError
        coordinator.syncSavedQueryViews(savedQueryViews)
        coordinator.scheduleLoad(document)
    }

    private static let diagnosticsScript = WKUserScript(
        source: """
        (() => {
          const post = (payload) => {
            try {
              window.webkit?.messageHandlers?.notesBridge?.postMessage(payload);
            } catch (_) {}
          };

          window.addEventListener('error', (event) => {
            post({
              type: 'clientError',
              message: event.message || 'Unknown editor error',
              source: event.filename || '',
              line: event.lineno || 0,
              column: event.colno || 0
            });
          });

          window.addEventListener('unhandledrejection', (event) => {
            post({
              type: 'clientError',
              message: String(event.reason?.message || event.reason || 'Unhandled editor promise rejection'),
              source: 'promise',
              line: 0,
              column: 0
            });
          });
        })();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )
}

#if os(iOS)
extension WebEditorView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        makeWebView(coordinator: context.coordinator)
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        updateWebView(uiView, coordinator: context.coordinator)
    }
}
#elseif os(macOS)
extension WebEditorView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView {
        makeWebView(coordinator: context.coordinator)
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        updateWebView(nsView, coordinator: context.coordinator)
    }
}
#endif

@MainActor
extension WebEditorView {
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var onChange: (_ documentID: UUID, _ title: String, _ contentJSON: String, _ plainText: String) -> Void
        var onEntityUpsert: (_ name: String, _ supertagNames: [String], _ properties: [String: String]?) throws -> EntityReference
        var onQueryRun: (_ query: String) throws -> QueryResult
        var onSavedQueryViewCreate: (
            _ name: String,
            _ query: String,
            _ view: String,
            _ groupBy: String?,
            _ visibleColumns: [String],
            _ sortColumn: String?,
            _ sortDescending: Bool,
            _ rowLimit: Int?
        ) throws -> SavedQueryView
        var onOpenDocument: (_ documentID: UUID) -> Void
        var onOpenEntity: (_ entityID: UUID) -> Void
        var onReady: () -> Void
        var onError: (_ message: String) -> Void
        weak var webView: WKWebView?

        private var isEditorReady = false
        private var pendingDocument: NoteDocument?
        private var loadingDocument: NoteDocument?
        private var loadedDocumentID: UUID?
        private var loadedTitle: String?
        private var loadedContentJSON: String?
        private var pendingSavedQueryViews: [SavedQueryView]
        private var syncedSavedQueryViews: [SavedQueryView] = []

        init(
            savedQueryViews: [SavedQueryView],
            onChange: @escaping (_ documentID: UUID, _ title: String, _ contentJSON: String, _ plainText: String) -> Void,
            onEntityUpsert: @escaping (_ name: String, _ supertagNames: [String], _ properties: [String: String]?) throws -> EntityReference,
            onQueryRun: @escaping (_ query: String) throws -> QueryResult,
            onSavedQueryViewCreate: @escaping (
                _ name: String,
                _ query: String,
                _ view: String,
                _ groupBy: String?,
                _ visibleColumns: [String],
                _ sortColumn: String?,
                _ sortDescending: Bool,
                _ rowLimit: Int?
            ) throws -> SavedQueryView,
            onOpenDocument: @escaping (_ documentID: UUID) -> Void,
            onOpenEntity: @escaping (_ entityID: UUID) -> Void,
            onReady: @escaping () -> Void,
            onError: @escaping (_ message: String) -> Void
        ) {
            self.pendingSavedQueryViews = savedQueryViews
            self.onChange = onChange
            self.onEntityUpsert = onEntityUpsert
            self.onQueryRun = onQueryRun
            self.onSavedQueryViewCreate = onSavedQueryViewCreate
            self.onOpenDocument = onOpenDocument
            self.onOpenEntity = onOpenEntity
            self.onReady = onReady
            self.onError = onError
        }

        func loadEditorHTML() {
            guard let webView else {
                return
            }

            if Bundle.main.url(
                forResource: "index",
                withExtension: "html",
                subdirectory: "Editor"
            ) != nil {
                webView.load(
                    URLRequest(url: EditorResourceSchemeHandler.editorIndexURL)
                )
            } else {
                onError("Editor resources are missing. Build WebEditor before launching the app.")
                webView.loadHTMLString(
                    """
                    <!doctype html>
                    <html>
                    <body style="font: -apple-system-body; padding: 24px;">
                    Editor resources are missing. Build WebEditor before launching the app.
                    </body>
                    </html>
                    """,
                    baseURL: nil
                )
            }
        }

        func scheduleLoad(_ document: NoteDocument) {
            pendingDocument = document

            guard isEditorReady else {
                return
            }

            guard
                loadedDocumentID != document.id ||
                loadedTitle != document.title ||
                loadedContentJSON != document.tiptapJSON
            else {
                return
            }

            guard
                loadingDocument?.id != document.id ||
                loadingDocument?.title != document.title ||
                loadingDocument?.tiptapJSON != document.tiptapJSON
            else {
                return
            }

            sendLoad(document)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "notesBridge" else {
                return
            }

            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String else {
                return
            }

            switch type {
            case "ready":
                isEditorReady = true
                onReady()
                syncSavedQueryViews(pendingSavedQueryViews)
                if let pendingDocument {
                    sendLoad(pendingDocument)
                }

            case "loaded":
                guard
                    let documentIDString = body["documentId"] as? String,
                    let documentID = UUID(uuidString: documentIDString),
                    let loadingDocument,
                    loadingDocument.id == documentID
                else {
                    return
                }

                loadedDocumentID = loadingDocument.id
                loadedTitle = loadingDocument.title
                loadedContentJSON = loadingDocument.tiptapJSON
                self.loadingDocument = nil

            case "change":
                guard
                    let documentIDString = body["documentId"] as? String,
                    let documentID = UUID(uuidString: documentIDString),
                    let contentJSON = body["contentJSON"] as? String,
                    let title = body["title"] as? String,
                    let plainText = body["plainText"] as? String
                else {
                    return
                }

                loadedDocumentID = documentID
                loadedTitle = title
                loadedContentJSON = contentJSON
                onChange(documentID, title, contentJSON, plainText)
                sendQueryRefresh(reason: "documentChanged")

            case "upsertEntity":
                guard
                    let requestID = body["requestId"] as? String,
                    let name = body["name"] as? String
                else {
                    return
                }

                let supertagNames = body["supertags"] as? [String] ?? []
                let properties = body["properties"] as? [String: String]

                do {
                    let entity = try onEntityUpsert(name, supertagNames, properties)
                    sendEntityResponse(
                        EntityBridgeResponse(
                            requestId: requestID,
                            entityId: entity.id.uuidString,
                            label: entity.label,
                            tags: entity.supertags,
                            properties: entity.properties,
                            error: nil
                        )
                    )
                    sendQueryRefresh(reason: "entityChanged")
                } catch {
                    sendEntityResponse(
                        EntityBridgeResponse(
                            requestId: requestID,
                            entityId: nil,
                            label: nil,
                            tags: [],
                            properties: [:],
                            error: error.localizedDescription
                        )
                    )
                }

            case "runQuery":
                guard
                    let requestID = body["requestId"] as? String,
                    let query = body["query"] as? String
                else {
                    return
                }

                do {
                    let result = try onQueryRun(query)
                    sendQueryResponse(
                        QueryBridgeResponse(
                            requestId: requestID,
                            columns: result.columns,
                            rows: result.rows,
                            error: nil
                        )
                    )
                } catch {
                    sendQueryResponse(
                        QueryBridgeResponse(
                            requestId: requestID,
                            columns: [],
                            rows: [],
                            error: error.localizedDescription
                        )
                    )
                }

            case "saveQueryView":
                guard
                    let requestID = body["requestId"] as? String,
                    let name = body["name"] as? String,
                    let query = body["query"] as? String,
                    let view = body["view"] as? String
                else {
                    return
                }

                let groupBy = body["groupBy"] as? String
                let visibleColumns = body["visibleColumns"] as? [String] ?? []
                let sortColumn = body["sortColumn"] as? String
                let sortDescending = body["sortDescending"] as? Bool ?? ((body["sortDirection"] as? String) == "desc")
                let rowLimit = bridgeInt(body["rowLimit"])

                do {
                    let savedView = try onSavedQueryViewCreate(
                        name,
                        query,
                        view,
                        groupBy,
                        visibleColumns,
                        sortColumn,
                        sortDescending,
                        rowLimit
                    )
                    sendSavedQueryViewResponse(
                        SavedQueryViewBridgeResponse(
                            requestId: requestID,
                            savedView: savedView,
                            error: nil
                        )
                    )
                    sendQueryRefresh(reason: "savedViewSaved")
                } catch {
                    sendSavedQueryViewResponse(
                        SavedQueryViewBridgeResponse(
                            requestId: requestID,
                            savedView: nil,
                            error: error.localizedDescription
                        )
                    )
                }

            case "openDocument":
                guard
                    let documentIDString = body["documentId"] as? String,
                    let documentID = UUID(uuidString: documentIDString)
                else {
                    return
                }

                onOpenDocument(documentID)

            case "openEntity":
                guard
                    let entityIDString = body["entityId"] as? String,
                    let entityID = UUID(uuidString: entityIDString)
                else {
                    return
                }

                onOpenEntity(entityID)

            case "clientError":
                let message = body["message"] as? String ?? "Unknown editor error"
                let source = body["source"] as? String ?? ""
                let line = body["line"] as? Int ?? 0
                onError("Editor error: \(message) \(source):\(line)")

            default:
                return
            }
        }

        func syncSavedQueryViews(_ savedQueryViews: [SavedQueryView]) {
            pendingSavedQueryViews = savedQueryViews

            guard isEditorReady else {
                return
            }

            guard syncedSavedQueryViews != savedQueryViews else {
                return
            }

            sendSavedQueryViews(savedQueryViews)
        }

        private func sendQueryRefresh(reason: String) {
            guard let webView else {
                return
            }

            do {
                let data = try JSONEncoder().encode(QueryRefreshPayload(reason: reason))
                guard let json = String(data: data, encoding: .utf8) else {
                    onError("Could not encode query refresh payload.")
                    return
                }

                webView.evaluateJavaScript(
                    "window.NotesEditor?.refreshQueryViews?.(\(json));"
                ) { [weak self] _, error in
                    if let error {
                        self?.onError("Could not refresh query views: \(error.localizedDescription)")
                    }
                }
            } catch {
                onError("Could not encode query refresh payload: \(error.localizedDescription)")
            }
        }

        private func sendSavedQueryViews(_ savedQueryViews: [SavedQueryView]) {
            guard let webView else {
                return
            }

            do {
                let payload = savedQueryViews.map(EditorSavedQueryViewPayload.init(savedView:))
                let data = try JSONEncoder().encode(payload)
                guard let json = String(data: data, encoding: .utf8) else {
                    onError("Could not encode saved query views.")
                    return
                }

                syncedSavedQueryViews = savedQueryViews
                webView.evaluateJavaScript(
                    "window.NotesEditor?.setSavedQueryViews?.(\(json));"
                ) { [weak self] _, error in
                    if let error {
                        self?.onError("Could not sync saved query views: \(error.localizedDescription)")
                    }
                }
            } catch {
                onError("Could not encode saved query views: \(error.localizedDescription)")
            }
        }

        private func sendQueryResponse(_ response: QueryBridgeResponse) {
            guard let webView else {
                return
            }

            do {
                let data = try JSONEncoder().encode(response)
                guard let json = String(data: data, encoding: .utf8) else {
                    onError("Could not encode query bridge response.")
                    return
                }

                webView.evaluateJavaScript(
                    "window.NotesEditor?.completeQueryRequest(\(json));"
                ) { [weak self] _, error in
                    if let error {
                        self?.onError("Could not complete query request: \(error.localizedDescription)")
                    }
                }
            } catch {
                onError("Could not encode query bridge response: \(error.localizedDescription)")
            }
        }

        private func sendSavedQueryViewResponse(_ response: SavedQueryViewBridgeResponse) {
            guard let webView else {
                return
            }

            do {
                let data = try JSONEncoder().encode(response)
                guard let json = String(data: data, encoding: .utf8) else {
                    onError("Could not encode saved query view bridge response.")
                    return
                }

                webView.evaluateJavaScript(
                    "window.NotesEditor?.completeSavedQueryViewRequest(\(json));"
                ) { [weak self] _, error in
                    if let error {
                        self?.onError("Could not complete saved query view request: \(error.localizedDescription)")
                    }
                }
            } catch {
                onError("Could not encode saved query view bridge response: \(error.localizedDescription)")
            }
        }

        private func sendEntityResponse(_ response: EntityBridgeResponse) {
            guard let webView else {
                return
            }

            do {
                let data = try JSONEncoder().encode(response)
                guard let json = String(data: data, encoding: .utf8) else {
                    onError("Could not encode entity bridge response.")
                    return
                }

                webView.evaluateJavaScript(
                    "window.NotesEditor?.completeEntityRequest(\(json));"
                ) { [weak self] _, error in
                    if let error {
                        self?.onError("Could not complete entity request: \(error.localizedDescription)")
                    }
                }
            } catch {
                onError("Could not encode entity bridge response: \(error.localizedDescription)")
            }
        }

        private func sendLoad(_ document: NoteDocument) {
            guard let webView else {
                return
            }

            do {
                let payload = EditorLoadPayload(
                    documentId: document.id.uuidString,
                    title: document.title,
                    contentJSON: document.tiptapJSON
                )
                let data = try JSONEncoder().encode(payload)
                guard let json = String(data: data, encoding: .utf8) else {
                    return
                }

                loadingDocument = document
                webView.evaluateJavaScript(
                    """
                    (() => {
                      if (!window.NotesEditor?.loadDocument) {
                        return false;
                      }

                      return window.NotesEditor.loadDocument(\(json)) === true;
                    })();
                    """
                ) { [weak self] result, error in
                    guard let self else {
                        return
                    }

                    if let error {
                        if self.loadingDocument?.id == document.id {
                            self.loadingDocument = nil
                        }
                        self.onError("Could not load document into editor: \(error.localizedDescription)")
                        return
                    }

                    if (result as? Bool) != true {
                        if self.loadingDocument?.id == document.id {
                            self.loadingDocument = nil
                        }
                        self.onError("Editor bridge is not ready.")
                    }
                }
            } catch {
                onError("Could not encode editor payload: \(error.localizedDescription)")
            }
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            onError("Editor failed to load: \(error.localizedDescription)")
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            onError("Editor failed to start loading: \(error.localizedDescription)")
        }
    }
}

private struct EditorLoadPayload: Encodable {
    let documentId: String
    let title: String
    let contentJSON: String
}

private struct EditorSavedQueryViewPayload: Encodable {
    let id: String
    let name: String
    let query: String
    let view: String
    let groupBy: String?
    let visibleColumns: [String]
    let sortColumn: String?
    let sortDescending: Bool
    let rowLimit: Int?

    init(savedView: SavedQueryView) {
        self.id = savedView.id.uuidString
        self.name = savedView.name
        self.query = savedView.query
        self.view = savedView.view
        self.groupBy = savedView.groupBy
        self.visibleColumns = savedView.visibleColumns
        self.sortColumn = savedView.sortColumn
        self.sortDescending = savedView.sortDescending
        self.rowLimit = savedView.rowLimit
    }
}

private struct EntityBridgeResponse: Encodable {
    let requestId: String
    let entityId: String?
    let label: String?
    let tags: [String]
    let properties: [String: String]
    let error: String?
}

private struct QueryBridgeResponse: Encodable {
    let requestId: String
    let columns: [String]
    let rows: [[String: String]]
    let error: String?
}

private struct SavedQueryViewBridgeResponse: Encodable {
    let requestId: String
    let id: String?
    let name: String?
    let query: String?
    let view: String?
    let groupBy: String?
    let visibleColumns: [String]?
    let sortColumn: String?
    let sortDescending: Bool?
    let rowLimit: Int?
    let error: String?

    init(requestId: String, savedView: SavedQueryView?, error: String?) {
        self.requestId = requestId
        self.id = savedView?.id.uuidString
        self.name = savedView?.name
        self.query = savedView?.query
        self.view = savedView?.view
        self.groupBy = savedView?.groupBy
        self.visibleColumns = savedView?.visibleColumns
        self.sortColumn = savedView?.sortColumn
        self.sortDescending = savedView?.sortDescending
        self.rowLimit = savedView?.rowLimit
        self.error = error
    }
}

private struct QueryRefreshPayload: Encodable {
    let reason: String
}

private func bridgeInt(_ value: Any?) -> Int? {
    if let value = value as? Int {
        return value
    }

    if let value = value as? NSNumber {
        return value.intValue
    }

    if let value = value as? String {
        return Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    return nil
}

private final class EditorResourceSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "notes-editor"
    static let editorIndexURL = URL(string: "\(scheme)://bundle/index.html")!

    private let resourceRoot: URL? = Bundle.main.resourceURL?
        .appendingPathComponent("Editor", isDirectory: true)

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              let resourceRoot,
              let fileURL = fileURL(for: requestURL, resourceRoot: resourceRoot) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        do {
            let data = try Data(contentsOf: fileURL)
            let response = URLResponse(
                url: requestURL,
                mimeType: mimeType(for: fileURL.pathExtension),
                expectedContentLength: data.count,
                textEncodingName: textEncodingName(for: fileURL.pathExtension)
            )

            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func fileURL(for requestURL: URL, resourceRoot: URL) -> URL? {
        let requestedPath = requestURL.path.removingPercentEncoding ?? requestURL.path
        let relativePath = requestedPath
            .split(separator: "/")
            .filter { $0 != "." && $0 != ".." }
            .joined(separator: "/")

        let resourcePath = relativePath.isEmpty ? "index.html" : relativePath
        let fileURL = resourceRoot.appendingPathComponent(resourcePath, isDirectory: false)

        guard fileURL.path.hasPrefix(resourceRoot.path),
              FileManager.default.fileExists(atPath: fileURL.path) else {
            return nil
        }

        return fileURL
    }

    private func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html":
            "text/html"
        case "js", "mjs":
            "text/javascript"
        case "css":
            "text/css"
        case "json", "map":
            "application/json"
        case "svg":
            "image/svg+xml"
        case "png":
            "image/png"
        case "jpg", "jpeg":
            "image/jpeg"
        case "webp":
            "image/webp"
        case "woff2":
            "font/woff2"
        case "wasm":
            "application/wasm"
        default:
            "application/octet-stream"
        }
    }

    private func textEncodingName(for pathExtension: String) -> String? {
        switch pathExtension.lowercased() {
        case "html", "js", "mjs", "css", "json", "map", "svg":
            "utf-8"
        default:
            nil
        }
    }
}

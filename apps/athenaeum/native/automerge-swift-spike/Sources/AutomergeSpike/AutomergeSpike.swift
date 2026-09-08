import Automerge

/// Minimal wrapper proving the exact Text-CRDT operations Athenaeum's Phase 2 page-body sync
/// needs: create a Text object, splice into it, read the current string back. Mirrors the shape
/// of the backend's own `notes-service-live.ts` (`putObject(... ty: .Text)`, `spliceText`,
/// `text(obj:)`) so a future `AthenaeumCore` page-editing actor has a proven starting point.
public enum AutomergeSpike {
    public static func createTextDocument(initialText: String) throws -> (doc: Document, textId: ObjId) {
        let doc = Document()
        let textId = try doc.putObject(obj: ObjId.ROOT, key: "text", ty: .Text)
        if !initialText.isEmpty {
            try doc.spliceText(obj: textId, start: 0, delete: 0, value: initialText)
        }
        return (doc, textId)
    }

    public static func splice(doc: Document, textId: ObjId, start: UInt64, delete: Int64, insert: String) throws {
        try doc.spliceText(obj: textId, start: start, delete: delete, value: insert)
    }

    public static func readText(doc: Document, textId: ObjId) throws -> String {
        try doc.text(obj: textId)
    }
}

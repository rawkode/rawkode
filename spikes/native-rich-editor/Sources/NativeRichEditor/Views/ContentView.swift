import SwiftUI

struct ContentView: View {
    @ObservedObject var session: EditorSession

    var body: some View {
        VStack(spacing: 0) {
            RichTextEditor(session: session)
            Divider()
            HStack {
                Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
                Text(session.status)
                Spacer()
                Text("Type / for blocks").foregroundStyle(.tertiary)
            }
            .font(.system(size: 11)).padding(.horizontal, 20).frame(height: 30)
        }
        .frame(minWidth: 650, minHeight: 560)
        .toolbar {
            ToolbarItemGroup(placement: .automatic) {
                Menu {
                    ForEach(TextBlockStyle.allCases, id: \.self) { style in
                        Button(style.rawValue) { session.applyTextStyle(style) }
                    }
                    Divider()
                    Button("Bulleted list") { if let text = session.textView { ListEditing.apply(.bullet, in: text) } }
                    Button("Numbered list") { if let text = session.textView { ListEditing.apply(.numbered, in: text) } }
                    Button("To-do list") { if let text = session.textView { ListEditing.apply(.task, in: text) } }
                } label: { Image(systemName: "textformat.size") }
                .help("Paragraph style")
                Button { session.toggleFont(.boldFontMask) } label: { Image(systemName: "bold") }.help("Bold (⌘B)")
                Button { session.toggleFont(.italicFontMask) } label: { Image(systemName: "italic") }.help("Italic (⌘I)")
                Button { session.toggleDecoration(.strikethroughStyle) } label: { Image(systemName: "strikethrough") }.help("Strikethrough")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("D2 Diagram", systemImage: "point.3.connected.trianglepath.dotted") { session.insert(.diagram) }
                    Button("Mermaid Diagram", systemImage: "arrow.triangle.branch") { session.insert(.mermaid) }
                    Button("Code Block", systemImage: "chevron.left.forwardslash.chevron.right") { session.insertCodeBlock() }
                    Button("Drawing", systemImage: "pencil.tip.crop.circle") { session.insert(.drawing) }
                    Button("Link", systemImage: "link") { session.insert(.link) }
                } label: { Label("Insert", systemImage: "plus") }
            }
        }
        .sheet(item: $session.editing) { edit in
            switch edit.component.kind {
            case .diagram, .mermaid:
                DiagramEditor(component: edit.component, onSave: session.commit, onCancel: { session.editing = nil })
            case .drawing:
                DrawingEditor(document: edit.component.drawing ?? DrawingDocument(), onSave: { document in
                    var component = edit.component
                    component.drawing = document
                    session.commit(component)
                }, onCancel: { session.editing = nil })
            case .link:
                LinkEditor(component: edit.component, onSave: session.commit, onCancel: { session.editing = nil })
            }
        }
        .alert("Couldn’t complete that", isPresented: Binding(get: { session.error != nil }, set: { if !$0 { session.error = nil } })) {
            Button("OK") { session.error = nil }
        } message: { Text(session.error ?? "") }
    }
}

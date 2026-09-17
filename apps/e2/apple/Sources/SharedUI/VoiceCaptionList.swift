import ApsidesCore
import SwiftUI

struct VoiceCaptionList: View {
    let captions: VoiceCaptions
    let theme: ApsidesTheme
    @State private var followsLatest = true
    @State private var userScrolling = false
    @State private var atBottom = true

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if captions.earlierCaptionsOmitted {
                        Text("Earlier captions are no longer shown.").font(.footnote).foregroundStyle(theme.secondary)
                    }
                    ForEach(captions.rows) { row in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(row.speaker == .user ? "You" : "Enchiridion")
                                .font(.caption.weight(.semibold)).foregroundStyle(theme.secondary)
                            Text(row.text).font(.body).textSelection(.enabled)
                        }.frame(maxWidth: .infinity, alignment: .leading).id(row.id)
                    }
                    Color.clear.frame(height: 1).id("caption-bottom")
                }.padding(.vertical, 12)
            }
            .accessibilityIdentifier("voiceCaptions")
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 40
            } action: { _, bottom in
                atBottom = bottom
                if userScrolling { followsLatest = bottom }
            }
            .onScrollPhaseChange { _, phase in
                userScrolling = phase == .interacting || phase == .decelerating || phase == .tracking
                if userScrolling { followsLatest = atBottom }
            }
            .onChange(of: captions, initial: true) { _, _ in
                Task { @MainActor in
                    await Task.yield()
                    if followsLatest && !userScrolling { proxy.scrollTo("caption-bottom", anchor: .bottom) }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if !followsLatest {
                    Button("Latest", systemImage: "arrow.down") {
                        followsLatest = true
                        withAnimation { proxy.scrollTo("caption-bottom", anchor: .bottom) }
                    }.buttonStyle(.bordered).padding(.vertical, 8)
                }
            }
        }
    }
}

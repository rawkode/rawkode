import ApsidesCore
import SwiftUI

struct VoiceCaptionList: View {
    let captions: VoiceCaptions
    let theme: ApsidesTheme
    var body: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Conversation").font(.title2.weight(.semibold))
                    Spacer()
                    Button("Latest") {
                        if let id = captions.rows.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                    }.font(.subheadline)
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
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
                    }.padding(.vertical, 12)
                }.accessibilityIdentifier("voiceCaptions")
            }
        }
    }
}

import ApsidesCore
import SwiftUI

struct TodayView: View {
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize = 38
    @ObservedObject var store: WorkspaceStore
    let showAgenda: () -> Void
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center) { heading; Spacer(minLength: 18); dayPicker }
                VStack(alignment: .leading, spacing: 12) { heading; dayPicker }
            }
            if Calendar.current.isDateInToday(store.selectedDay), let snapshot = store.snapshot, snapshot.day == DayIdentity.key(.now), let event = snapshot.nextEvent(at: .now) {
                Button(action: showAgenda) { HStack(alignment: .top) {
                    Image(systemName: "calendar").foregroundStyle(theme.accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(event.title).font(.subheadline.weight(.medium))
                        if let start = event.start { Text(start, format: .dateTime.hour().minute()).font(.caption).foregroundStyle(theme.secondary) }
                    }
                    Spacer()
                    if Date().timeIntervalSince(snapshot.fetchedAt) > 3600 { Text("Cached").font(.caption).foregroundStyle(theme.secondary) }
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(theme.secondary)
                }.padding(.vertical, 8).contentShape(Rectangle()) }.buttonStyle(.plain).accessibilityHint("Open the day calendar")
            }
            ZStack(alignment: .topLeading) {
                if store.dayText.isEmpty { Text("What’s on your mind?").foregroundStyle(theme.secondary).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
                TextEditor(text: Binding(get: { store.dayText }, set: store.setDayText))
                    .font(.system(.body, design: .serif)).lineSpacing(7)
                    .scrollContentBackground(.hidden).disabled(store.isReadOnly)
                    .accessibilityLabel("Daybook editor").accessibilityIdentifier("daybookEditor")
            }
            HStack {
                Text(store.storageError == nil ? "Saved on this device" : "Changes need saving").font(.caption).foregroundStyle(theme.secondary).accessibilityIdentifier("saveStatus")
                Spacer()
                if !store.dayText.isEmpty { ShareLink(item: store.dayText) { Label("Share", systemImage: "square.and.arrow.up") }.labelStyle(.iconOnly) }
            }
        }
        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(theme.canvas).foregroundStyle(theme.ink)
        #if os(macOS)
        .navigationTitle("Daybook")
        #else
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
    private var heading: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(store.selectedDay, format: .dateTime.weekday(.wide).day().month(.wide)).font(.subheadline).foregroundStyle(theme.secondary)
            Text(Calendar.current.isDateInToday(store.selectedDay) ? "Today" : "Daybook")
                .font(.system(size: titleSize, weight: .regular, design: .serif))
        }.fixedSize(horizontal: true, vertical: false)
    }
    private var dayPicker: some View {
        DatePicker("Day", selection: $store.selectedDay, displayedComponents: .date).labelsHidden().fixedSize()
    }
}

import Foundation
import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

/// The immutable field schema snapshot that follows one acknowledged inline `#Supertag`
/// insertion.  It is deliberately keyed by the editor command UUID rather than by a visible tag
/// label or caret range: the same tag can be inserted twice at the same location, but only the
/// exact published command may open this capture surface.
struct DailyNoteInlineSupertagFieldCapture: Identifiable, Equatable {
    let commandID: UUID
    let tagID: EntityId
    let tagName: String
    /// Server order is presentation order. Inherited metadata remains attached to each field so
    /// native never has to recreate the tag-closure ordering locally.
    let fields: [DailyNoteInlineSupertagField]

    var id: UUID { commandID }
}

/// A field popover is allowed to return first responder only to the rich editor that produced its
/// exact acknowledged command. Keeping this witness independent of the mutable popover binding
/// makes a note switch, refresh, or presentation change fail closed while the dismissal animation
/// is in flight.
struct DailyNoteInlineSupertagFieldCaptureFocusWitness: Equatable {
    let commandID: UUID
    let dailyNoteID: EntityId
    let date: Date
    let operationGeneration: Int
    let presentation: AthenaeumViewModel.PagePresentation

    func permitsRestoration(
        hasResolvedDailyNote: Bool,
        dailyNoteID: EntityId,
        selectedDate: Date,
        operationGeneration: Int,
        presentation: AthenaeumViewModel.PagePresentation,
        isEditorInputDisabled: Bool
    ) -> Bool {
        hasResolvedDailyNote &&
            self.dailyNoteID == dailyNoteID &&
            date == selectedDate &&
            self.operationGeneration == operationGeneration &&
            self.presentation == presentation &&
            presentation == .loroRichEditable &&
            !isEditorInputDisabled
    }
}

struct DailyNoteInlineSupertagField: Identifiable, Equatable {
    let resolved: RPCResolvedTagField
    /// The current `graph_facts` receipt for this predicate, if one existed when this capture was
    /// opened. A later save retains this id for upsert rather than manufacturing a duplicate fact.
    let existingFact: Fact?

    var id: String { resolved.field.id }
}

/// Value-facing state for one field control. Raw text is intentionally retained until a save is
/// admitted, while the mutation model freezes the canonical `JSONValue` sent to `addFact`.
struct DailyNoteInlineSupertagFieldDraft: Equatable, Sendable {
    var raw: String
    var checked: Bool

    init(raw: String = "", checked: Bool = false) {
        self.raw = raw
        self.checked = checked
    }

    init(valueKind: RPCTagFieldValueKind, existingValue: JSONValue?) {
        switch (valueKind, existingValue) {
        case (.text, .string(let value)), (.date, .string(let value)), (.entityRef, .string(let value)):
            self.init(raw: value)
        case (.number, .number(let value)):
            self.init(raw: String(value))
        case (.checkbox, .bool(let value)):
            self.init(checked: value)
        default:
            self.init()
        }
    }

    static func canonicalValue(
        valueKind: RPCTagFieldValueKind,
        draft: DailyNoteInlineSupertagFieldDraft
    ) -> Result<JSONValue, DailyNoteInlineSupertagFieldValidationError> {
        switch valueKind {
        case .text:
            return .success(.string(draft.raw))
        case .number:
            let text = draft.raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let value = Double(text), value.isFinite else { return .failure(.invalidNumber) }
            return .success(.number(value))
        case .date:
            let value = draft.raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard isCanonicalDate(value) else { return .failure(.invalidDate) }
            return .success(.string(value))
        case .checkbox:
            return .success(.bool(draft.checked))
        case .entityRef:
            let rawID = draft.raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let id = try? EntityId(validating: rawID) else { return .failure(.invalidEntityReference) }
            return .success(.string(id.rawValue))
        }
    }

    private static func isCanonicalDate(_ value: String) -> Bool {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            return false
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        return formatter.date(from: value) != nil
    }
}

enum DailyNoteInlineSupertagFieldValidationError: Error, Equatable, LocalizedError {
    case invalidNumber
    case invalidDate
    case invalidEntityReference

    var errorDescription: String? {
        switch self {
        case .invalidNumber:
            return "Enter a finite number before saving."
        case .invalidDate:
            return "Enter a date as YYYY-MM-DD before saving."
        case .invalidEntityReference:
            return "Enter a valid Athenaeum entity ID before saving."
        }
    }
}

/// The capture UI owns only drafts and focused control state. Route identity, fact identity,
/// frozen retry payloads, and receipt validation remain in `AthenaeumViewModel`.
struct DailyNoteInlineSupertagFieldCaptureView: View {
    @ObservedObject var model: AthenaeumViewModel
    let capture: DailyNoteInlineSupertagFieldCapture
    @Binding var activeCapture: DailyNoteInlineSupertagFieldCapture?
    @State private var drafts: [String: DailyNoteInlineSupertagFieldDraft]
    @State private var fieldErrors: [String: String] = [:]
    @State private var savingFieldID: String?
    @State private var savedFieldID: String?
    @FocusState private var focusedFieldID: String?

    private var canDismiss: Bool {
        model.canDismissDailyNoteInlineSupertagFieldCapture(captureID: capture.commandID)
    }

    init(
        model: AthenaeumViewModel,
        capture: DailyNoteInlineSupertagFieldCapture,
        activeCapture: Binding<DailyNoteInlineSupertagFieldCapture?>
    ) {
        self.model = model
        self.capture = capture
        _activeCapture = activeCapture
        _drafts = State(initialValue: Dictionary(uniqueKeysWithValues: capture.fields.map { field in
            (
                field.id,
                .init(valueKind: field.resolved.field.valueKind, existingValue: field.existingFact?.value)
            )
        }))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "number.circle.fill")
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("#\(capture.tagName)")
                        .font(.headline)
                    Text("Capture the details that make this reference useful later.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button("Done") {
                    guard canDismiss else { return }
                    activeCapture = nil
                }
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .disabled(!canDismiss)
                    .accessibilityLabel("Close Supertag field capture")
                    .accessibilityHint(
                        canDismiss
                            ? ""
                            : "Retry or finish the saved field update before closing this capture."
                    )
            }

            ForEach(capture.fields) { field in
                fieldControl(field)
            }
        }
        .padding(16)
        .frame(minWidth: 320, idealWidth: 390, maxWidth: 480, alignment: .leading)
        .onAppear {
            focusedFieldID = capture.fields.first?.id
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Fields for #\(capture.tagName)")
    }

    @ViewBuilder
    private func fieldControl(_ field: DailyNoteInlineSupertagField) -> some View {
        let fieldID = field.id
        let definition = field.resolved.field
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Text(definition.name)
                    .font(.subheadline.weight(.medium))
                if field.resolved.inherited {
                    Text("Inherited")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                Spacer()
                Text(definition.valueKind.rawValue)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if definition.valueKind == .checkbox {
                Toggle(definition.name, isOn: checkedBinding(for: field))
                    .labelsHidden()
                    .accessibilityLabel(definition.name)
                    .accessibilityIdentifier("daily-note-supertag-field-\(fieldID)")
            } else {
                TextField(placeholder(for: definition.valueKind), text: rawBinding(for: field))
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedFieldID, equals: fieldID)
                    .onSubmit { save(field) }
                    .accessibilityIdentifier("daily-note-supertag-field-\(fieldID)")
                    #if os(iOS)
                    .textInputAutocapitalization(definition.valueKind == .entityRef ? .never : .sentences)
                    .autocorrectionDisabled(definition.valueKind == .entityRef)
                    #endif
            }

            HStack(spacing: 8) {
                if savingFieldID == fieldID {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if savedFieldID == fieldID {
                    Label("Saved", systemImage: "checkmark")
                        .font(.caption)
                        .foregroundStyle(.green)
                } else if let message = fieldErrors[fieldID] {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityLabel(message)
                    Button("Retry") { retry(field) }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("retry-daily-note-supertag-field-\(fieldID)")
                }
                Spacer()
                Button("Save") { save(field) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(savingFieldID != nil || model.isDailyNoteInlineSupertagFieldMutationInFlight)
                    .accessibilityIdentifier("save-daily-note-supertag-field-\(fieldID)")
            }
        }
        .padding(.vertical, 3)
    }

    private func rawBinding(for field: DailyNoteInlineSupertagField) -> Binding<String> {
        Binding(
            get: { drafts[field.id]?.raw ?? "" },
            set: { value in
                var next = drafts[field.id] ?? .init()
                next.raw = value
                drafts[field.id] = next
                fieldErrors[field.id] = nil
            }
        )
    }

    private func checkedBinding(for field: DailyNoteInlineSupertagField) -> Binding<Bool> {
        Binding(
            get: { drafts[field.id]?.checked ?? false },
            set: { value in
                var next = drafts[field.id] ?? .init()
                next.checked = value
                drafts[field.id] = next
                fieldErrors[field.id] = nil
            }
        )
    }

    private func placeholder(for valueKind: RPCTagFieldValueKind) -> String {
        switch valueKind {
        case .text: return "Enter text"
        case .number: return "Enter a number"
        case .date: return "YYYY-MM-DD"
        case .checkbox: return ""
        case .entityRef: return "Paste an entity ID"
        }
    }

    private func save(_ field: DailyNoteInlineSupertagField) {
        guard savingFieldID == nil else { return }
        let draft = drafts[field.id] ?? .init()
        switch DailyNoteInlineSupertagFieldDraft.canonicalValue(valueKind: field.resolved.field.valueKind, draft: draft) {
        case .failure(let error):
            fieldErrors[field.id] = error.localizedDescription
        case .success(let value):
            savingFieldID = field.id
            fieldErrors[field.id] = nil
            Task { @MainActor in
                let accepted = await model.saveDailyNoteInlineSupertagField(
                    captureID: capture.commandID,
                    fieldID: field.id,
                    value: value
                )
                guard activeCapture?.commandID == capture.commandID else { return }
                savingFieldID = nil
                if accepted {
                    savedFieldID = field.id
                } else {
                    fieldErrors[field.id] = "We couldn’t confirm that this field was saved. Your draft is still here. Retry to continue."
                }
            }
        }
    }

    private func retry(_ field: DailyNoteInlineSupertagField) {
        guard savingFieldID == nil else { return }
        savingFieldID = field.id
        fieldErrors[field.id] = nil
        Task { @MainActor in
            let accepted = await model.retryDailyNoteInlineSupertagField(
                captureID: capture.commandID,
                fieldID: field.id
            )
            guard activeCapture?.commandID == capture.commandID else { return }
            savingFieldID = nil
            if accepted {
                savedFieldID = field.id
            } else {
                fieldErrors[field.id] = "We couldn’t confirm that this field was saved. Your draft is still here. Retry to continue."
            }
        }
    }
}

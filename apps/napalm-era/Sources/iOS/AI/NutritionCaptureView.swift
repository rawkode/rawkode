import PhotosUI
import SwiftData
import SwiftUI
import UIKit

struct NutritionCaptureView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(\.nutritionAssistant) private var assistant
    @Environment(\.healthKitClient) private var healthKit
    var existingMeal: MealEntry?

    @State private var composer = ""
    @State private var transcript: [CaptureMessage] = []
    @State private var result: NutritionAssistantResult?
    @State private var isWorking = false
    @State private var availability: NutritionAssistantAvailability = .available("Checking Apple Intelligence…")
    @State private var errorMessage: String?
    @State private var mealPhoto: PhotosPickerItem?
    @State private var labelPhoto: PhotosPickerItem?
    @State private var cameraIntent: CameraIntent?
    @State private var voice = VoiceCaptureService()

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    availabilityBanner
                    if transcript.isEmpty {
                        ContentUnavailableView(
                            existingMeal == nil ? "Describe what you ate" : "Tell AI what to correct",
                            systemImage: "sparkles",
                            description: Text("Type, speak, or add a meal or nutrition-label photo. AI will estimate without follow-up questions.")
                        )
                        .padding(.vertical, 24)
                    }
                    ForEach(transcript) { message in
                        CaptureBubble(message: message)
                    }
                    if isWorking {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Estimating nutrition…").foregroundStyle(.secondary)
                        }
                        .padding()
                    }
                    if let result {
                        NutritionDraftCard(result: result, save: { Task { await save() } }, discard: discard)
                            .id("draft")
                    }
                }
                .padding()
            }
            .onChange(of: transcript.count) { _, _ in
                withAnimation { proxy.scrollTo("draft", anchor: .bottom) }
            }
        }
        .navigationTitle(existingMeal == nil ? "Log Nutrition" : "Correct Meal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { discard() }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                PhotosPicker(selection: $mealPhoto, matching: .images) {
                    Label("Meal Photo", systemImage: "photo")
                }
                .disabled(result != nil || isWorking)
                PhotosPicker(selection: $labelPhoto, matching: .images) {
                    Label("Label Photo", systemImage: "doc.text.viewfinder")
                }
                .disabled(result != nil || isWorking)
                Menu {
                    Button("Meal Photo", systemImage: "fork.knife") { cameraIntent = .meal }
                    Button("Nutrition Label", systemImage: "doc.text") { cameraIntent = .label }
                } label: {
                    Label("Camera", systemImage: "camera")
                }
                .disabled(result != nil || isWorking || !UIImagePickerController.isSourceTypeAvailable(.camera))
            }
        }
        .safeAreaInset(edge: .bottom) { composerBar }
        .sheet(item: $cameraIntent) { intent in
            CameraCaptureView { image in
                cameraIntent = nil
                guard let cgImage = image.cgImage else { return }
                Task { await analyze(.image(cgImage, kind: intent.kind, note: nil), displayText: intent.label) }
            }
            .ignoresSafeArea()
        }
        .onChange(of: mealPhoto) { _, item in
            guard let item else { return }
            Task { await loadPhoto(item, kind: .meal) }
        }
        .onChange(of: labelPhoto) { _, item in
            guard let item else { return }
            Task { await loadPhoto(item, kind: .label) }
        }
        .task {
            availability = assistant.availability
            if let meal = existingMeal, result == nil {
                let generated = NutritionDraft(rehydrating: meal)
                if let validated = try? NutritionDraftValidator.validate(generated) {
                    result = NutritionAssistantResult(
                        generated: generated,
                        validated: validated,
                        route: NutritionModelRoute(rawValue: meal.modelRoute) ?? .onDevice,
                        promptVersion: meal.promptVersion
                    )
                    transcript = [CaptureMessage(role: .assistant, text: "I’ve loaded the confirmed meal. Tell me what should change.")]
                }
            }
        }
        .onDisappear { voice.cancelAndDelete() }
        .alert("Nutrition Capture", isPresented: .init(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(errorMessage ?? "Unknown error") }
    }

    @ViewBuilder
    private var availabilityBanner: some View {
        if case .unavailable(let reason) = availability {
            Label(reason, systemImage: "apple.intelligence")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: .rect(cornerRadius: 14))
        }
    }

    private var composerBar: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(result == nil ? "Describe your meal" : "Correct this estimate", text: $composer, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
                .disabled(isWorking || !availability.isAvailable)

            Button {
                Task { await toggleVoice() }
            } label: {
                Image(systemName: voice.isRecording ? "stop.fill" : "mic.fill")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.bordered)
            .tint(voice.isRecording ? .red : .accentColor)
            .disabled(isWorking || !availability.isAvailable)
            .accessibilityLabel(voice.isRecording ? "Stop Dictation" : "Start Dictation")

            Button {
                submitComposer()
            } label: {
                Image(systemName: "arrow.up")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.borderedProminent)
            .disabled(composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking || !availability.isAvailable)
            .accessibilityLabel("Send")
        }
        .padding()
        .background(.bar)
    }

    private func submitComposer() {
        let text = composer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composer = ""
        Task {
            if result == nil { await analyze(.text(text), displayText: text) }
            else { await revise(text) }
        }
    }

    private func analyze(_ input: NutritionAssistantInput, displayText: String) async {
        transcript.append(CaptureMessage(role: .user, text: displayText))
        isWorking = true
        defer {
            isWorking = false
            mealPhoto = nil
            labelPhoto = nil
        }
        do {
            result = try await assistant.analyze(input: input)
            transcript.append(CaptureMessage(role: .assistant, text: "Here’s my best estimate. Review the values and assumptions before saving."))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func revise(_ instruction: String) async {
        guard let current = result else { return }
        transcript.append(CaptureMessage(role: .user, text: instruction))
        isWorking = true
        defer { isWorking = false }
        do {
            result = try await assistant.revise(draft: current.generated, instruction: instruction)
            transcript.append(CaptureMessage(role: .assistant, text: "I’ve replaced the draft with the corrected estimate."))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadPhoto(_ item: PhotosPickerItem, kind: NutritionImageKind) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data), let cgImage = image.cgImage else {
                throw CaptureError.unreadablePhoto
            }
            await analyze(.image(cgImage, kind: kind, note: nil), displayText: kind == .label ? "Analyze this nutrition label" : "Estimate this meal photo")
        } catch {
            errorMessage = error.localizedDescription
            mealPhoto = nil
            labelPhoto = nil
        }
    }

    private func toggleVoice() async {
        do {
            if voice.isRecording {
                let text = try await voice.stopAndTranscribe()
                guard !text.isEmpty else { throw CaptureError.emptyTranscript }
                if result == nil { await analyze(.voiceTranscript(text), displayText: text) }
                else { await revise(text) }
            } else {
                try await voice.start()
            }
        } catch {
            errorMessage = error.localizedDescription
            voice.cancelAndDelete()
        }
    }

    private func save() async {
        guard let result else { return }
        isWorking = true
        let draft = result.validated
        let nutrients = draft.nutrients.map {
            NutrientValue(metric: $0.metric, amount: $0.amount, provenance: $0.provenance, confidence: $0.confidence)
        }
        let meal: MealEntry
        if let existingMeal {
            existingMeal.nutrients.forEach(modelContext.delete)
            existingMeal.name = draft.name
            existingMeal.portionSummary = draft.portionSummary
            existingMeal.eatenAt = draft.eatenAt
            existingMeal.updatedAt = .now
            existingMeal.modelRoute = result.route.rawValue
            existingMeal.promptVersion = result.promptVersion
            existingMeal.assumptions = draft.assumptions
            existingMeal.nutrients = nutrients
            meal = existingMeal
        } else {
            meal = MealEntry(
                name: draft.name,
                portionSummary: draft.portionSummary,
                eatenAt: draft.eatenAt,
                modelRoute: result.route.rawValue,
                promptVersion: result.promptVersion,
                assumptions: draft.assumptions,
                nutrients: nutrients
            )
            modelContext.insert(meal)
        }

        do {
            try modelContext.save()
            let correlationID = try await healthKit.replaceMeal(id: meal.id, name: meal.name, eatenAt: meal.eatenAt, nutrients: meal.nutritionAmounts)
            meal.healthKitCorrelationUUID = correlationID
            try modelContext.save()
            voice.cancelAndDelete()
            dismiss()
        } catch {
            isWorking = false
            errorMessage = "The meal is saved in Napalm Era, but Apple Health could not be updated: \(error.localizedDescription)"
        }
    }

    private func discard() {
        voice.cancelAndDelete()
        result = nil
        transcript.removeAll()
        dismiss()
    }
}

private struct CaptureMessage: Identifiable {
    enum Role { case user, assistant }
    let id = UUID()
    let role: Role
    let text: String
}

private struct CaptureBubble: View {
    let message: CaptureMessage

    var body: some View {
        Text(message.text)
            .padding(12)
            .background(message.role == .user ? Color.accentColor : Color(.secondarySystemBackground), in: .rect(cornerRadius: 16))
            .foregroundStyle(message.role == .user ? .white : .primary)
            .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
            .padding(message.role == .user ? .leading : .trailing, 42)
    }
}

private struct NutritionDraftCard: View {
    let result: NutritionAssistantResult
    let save: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(result.validated.name).font(.title2.weight(.semibold))
                Text(result.validated.portionSummary).foregroundStyle(.secondary)
                Text(result.validated.eatenAt, format: .dateTime.day().month().hour().minute())
                    .font(.caption).foregroundStyle(.secondary)
            }

            VStack(spacing: 12) {
                ForEach(result.validated.nutrients) { NutritionValueRow(value: $0) }
            }

            if !result.validated.assumptions.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Assumptions").font(.subheadline.weight(.semibold))
                    ForEach(result.validated.assumptions, id: \.self) { assumption in
                        Text("• \(assumption)").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }

            HStack {
                Button("Discard", role: .destructive, action: discard)
                    .buttonStyle(.bordered)
                Spacer()
                Button("Save", systemImage: "checkmark", action: save)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .background(.background, in: .rect(cornerRadius: 20))
        .overlay { RoundedRectangle(cornerRadius: 20).stroke(.quaternary) }
    }
}

private enum CameraIntent: String, Identifiable {
    case meal, label
    var id: String { rawValue }
    var kind: NutritionImageKind { self == .meal ? .meal : .label }
    var label: String { self == .meal ? "Estimate this meal photo" : "Analyze this nutrition label" }
}

private enum CaptureError: LocalizedError {
    case unreadablePhoto, emptyTranscript
    var errorDescription: String? {
        switch self {
        case .unreadablePhoto: "The selected photo could not be read."
        case .emptyTranscript: "No speech was detected."
        }
    }
}

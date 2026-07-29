import CoreGraphics
import Foundation
import FoundationModels
#if canImport(_Vision_FoundationModels)
import _Vision_FoundationModels
#endif

enum NutritionAssistantAvailability: Equatable, Sendable {
    case available(String)
    case unavailable(String)

    var isAvailable: Bool {
        if case .available = self { true } else { false }
    }
}

enum NutritionImageKind: String, Sendable {
    case meal
    case label
}

enum NutritionAssistantInput: @unchecked Sendable {
    case text(String)
    case voiceTranscript(String)
    case image(CGImage, kind: NutritionImageKind, note: String?)

    var instruction: String {
        switch self {
        case .text(let text): text
        case .voiceTranscript(let text): text
        case .image(_, .meal, let note):
            "Estimate the complete nutrition for the meal photo. \(note ?? "")"
        case .image(_, .label, let note):
            "Read the nutrition label exactly using OCR and return values for the described serving. \(note ?? "")"
        }
    }

    var image: CGImage? {
        if case .image(let image, _, _) = self { image } else { nil }
    }

    var requiresOCR: Bool {
        if case .image(_, .label, _) = self { true } else { false }
    }
}

enum NutritionModelRoute: String, Codable, Sendable {
    case privateCloudCompute
    case onDevice
    case preview
}

struct NutritionModelEndpointState: Equatable, Sendable {
    let isAvailable: Bool
    let isAtQuota: Bool
    let supportsVision: Bool
    let supportsGuidedGeneration: Bool
    let supportsToolCalling: Bool

    init(
        isAvailable: Bool,
        isAtQuota: Bool,
        supportsVision: Bool,
        supportsGuidedGeneration: Bool = true,
        supportsToolCalling: Bool = true
    ) {
        self.isAvailable = isAvailable
        self.isAtQuota = isAtQuota
        self.supportsVision = supportsVision
        self.supportsGuidedGeneration = supportsGuidedGeneration
        self.supportsToolCalling = supportsToolCalling
    }

    func canHandle(requiresVision: Bool, requiresToolCalling: Bool = false) -> Bool {
        isAvailable
            && !isAtQuota
            && supportsGuidedGeneration
            && (!requiresVision || supportsVision)
            && (!requiresToolCalling || supportsToolCalling)
    }
}

enum NutritionRoutingPolicy {
    static func preferredRoute(
        pcc: NutritionModelEndpointState,
        onDevice: NutritionModelEndpointState,
        requiresVision: Bool,
        requiresToolCalling: Bool = false
    ) -> NutritionModelRoute? {
        if pcc.canHandle(requiresVision: requiresVision, requiresToolCalling: requiresToolCalling) {
            return .privateCloudCompute
        }
        if onDevice.canHandle(requiresVision: requiresVision, requiresToolCalling: requiresToolCalling) {
            return .onDevice
        }
        return nil
    }
}

@Generable
enum GeneratedNutritionMetric: CaseIterable {
    case energy
    case protein
    case carbohydrate
    case fat
    case saturatedFat
    case monounsaturatedFat
    case polyunsaturatedFat
    case fibre
    case sugar
    case cholesterol
    case sodium
    case potassium
    case calcium
    case iron
    case magnesium
    case zinc
    case chloride
    case phosphorus
    case copper
    case manganese
    case selenium
    case chromium
    case molybdenum
    case iodine
    case vitaminA
    case vitaminB1
    case vitaminB2
    case vitaminB3
    case vitaminB5
    case vitaminB6
    case vitaminB7
    case vitaminB9
    case vitaminB12
    case vitaminC
    case vitaminD
    case vitaminE
    case vitaminK
    case water
    case caffeine

    var metric: NutritionMetric {
        switch self {
        case .energy: .energy
        case .protein: .protein
        case .carbohydrate: .carbohydrate
        case .fat: .fat
        case .saturatedFat: .saturatedFat
        case .monounsaturatedFat: .monounsaturatedFat
        case .polyunsaturatedFat: .polyunsaturatedFat
        case .fibre: .fibre
        case .sugar: .sugar
        case .cholesterol: .cholesterol
        case .sodium: .sodium
        case .potassium: .potassium
        case .calcium: .calcium
        case .iron: .iron
        case .magnesium: .magnesium
        case .zinc: .zinc
        case .chloride: .chloride
        case .phosphorus: .phosphorus
        case .copper: .copper
        case .manganese: .manganese
        case .selenium: .selenium
        case .chromium: .chromium
        case .molybdenum: .molybdenum
        case .iodine: .iodine
        case .vitaminA: .vitaminA
        case .vitaminB1: .vitaminB1
        case .vitaminB2: .vitaminB2
        case .vitaminB3: .vitaminB3
        case .vitaminB5: .vitaminB5
        case .vitaminB6: .vitaminB6
        case .vitaminB7: .vitaminB7
        case .vitaminB9: .vitaminB9
        case .vitaminB12: .vitaminB12
        case .vitaminC: .vitaminC
        case .vitaminD: .vitaminD
        case .vitaminE: .vitaminE
        case .vitaminK: .vitaminK
        case .water: .water
        case .caffeine: .caffeine
        }
    }
}

@Generable
enum GeneratedProvenance: CaseIterable {
    case label
    case stated
    case estimated

    var value: NutrientProvenance {
        switch self {
        case .label: .label
        case .stated: .stated
        case .estimated: .estimated
        }
    }
}

@Generable
enum GeneratedConfidence: CaseIterable {
    case high
    case medium
    case low

    var value: NutrientConfidence {
        switch self {
        case .high: .high
        case .medium: .medium
        case .low: .low
        }
    }
}

@Generable
struct GeneratedNutrient {
    @Guide(description: "The nutrient represented by this value.")
    var metric: GeneratedNutritionMetric

    @Guide(description: "A nonnegative amount in the app's canonical display unit for this nutrient.", .minimum(0))
    var amount: Double

    @Guide(description: "Whether the value came from a visible label, explicit user statement, or estimation.")
    var provenance: GeneratedProvenance

    @Guide(description: "Confidence in this specific value.")
    var confidence: GeneratedConfidence
}

@Generable
struct NutritionDraft {
    @Guide(description: "A concise name for the meal.")
    var name: String

    @Guide(description: "The assumed portion in plain language.")
    var portionSummary: String

    @Guide(description: "ISO 8601 timestamp. Use the supplied current time unless the user states another time.")
    var timestampISO8601: String

    @Guide(description: "Known or estimated nutrition totals. Omit unknown nutrients; never emit duplicate metrics.", .maximumCount(40))
    var nutrients: [GeneratedNutrient]

    @Guide(description: "Short assumptions that materially affect the estimate.", .maximumCount(4))
    var assumptions: [String]
}

struct ValidatedNutritionDraft: Sendable {
    let name: String
    let portionSummary: String
    let eatenAt: Date
    let nutrients: [NutritionAmount]
    let assumptions: [String]
}

struct NutritionAssistantResult: Sendable {
    let generated: NutritionDraft
    let validated: ValidatedNutritionDraft
    let route: NutritionModelRoute
    let promptVersion: String
}

enum NutritionDraftValidationError: LocalizedError, Equatable {
    case emptyName
    case noNutrition
    case duplicate(NutritionMetric)
    case invalid(NutritionMetric)

    var errorDescription: String? {
        switch self {
        case .emptyName: "The generated meal did not have a name."
        case .noNutrition: "The generated meal did not contain nutrition values."
        case .duplicate(let metric): "The generated meal contained duplicate \(metric.title) values."
        case .invalid(let metric): "The generated \(metric.title) value was outside a safe validation range."
        }
    }
}

enum NutritionDraftValidator {
    static func validate(_ draft: NutritionDraft, now: Date = .now) throws -> ValidatedNutritionDraft {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw NutritionDraftValidationError.emptyName }

        var seen = Set<NutritionMetric>()
        let nutrients = try draft.nutrients.map { value -> NutritionAmount in
            let metric = value.metric.metric
            guard seen.insert(metric).inserted else { throw NutritionDraftValidationError.duplicate(metric) }
            guard value.amount.isFinite, value.amount >= 0, value.amount <= metric.plausibleMaximum else {
                throw NutritionDraftValidationError.invalid(metric)
            }
            return NutritionAmount(
                metric: metric,
                amount: value.amount,
                provenance: value.provenance.value,
                confidence: value.confidence.value
            )
        }
        guard !nutrients.isEmpty else { throw NutritionDraftValidationError.noNutrition }

        return ValidatedNutritionDraft(
            name: name,
            portionSummary: draft.portionSummary.trimmingCharacters(in: .whitespacesAndNewlines),
            eatenAt: ISO8601DateFormatter().date(from: draft.timestampISO8601) ?? now,
            nutrients: nutrients,
            assumptions: Array(draft.assumptions.prefix(4))
        )
    }
}

protocol NutritionAssistantClient: Sendable {
    var availability: NutritionAssistantAvailability { get }
    func analyze(input: NutritionAssistantInput) async throws -> NutritionAssistantResult
    func revise(draft: NutritionDraft, instruction: String) async throws -> NutritionAssistantResult
}

enum NutritionAssistantError: LocalizedError {
    case unavailable(String)

    var errorDescription: String? {
        if case .unavailable(let reason) = self { reason } else { nil }
    }
}

actor FoundationModelsNutritionAssistant: NutritionAssistantClient {
    static let promptVersion = "nutrition-v1"

    nonisolated var availability: NutritionAssistantAvailability {
        let pcc = PrivateCloudComputeLanguageModel()
        if pcc.isAvailable,
           !pcc.quotaUsage.isLimitReached,
           pcc.capabilities.contains(.guidedGeneration) {
            return .available("Private Cloud Compute is ready. The on-device system model remains the automatic fallback.")
        }

        let local = SystemLanguageModel.default
        if local.isAvailable, local.capabilities.contains(.guidedGeneration) {
            let reason = pcc.quotaUsage.isLimitReached
                ? "Private Cloud Compute's daily limit has been reached, so nutrition capture is using the on-device system model."
                : "Nutrition capture is using the on-device system model because Private Cloud Compute is not ready."
            return .available(reason)
        }

        return .unavailable(Self.unavailabilityReason(
            pcc: pcc,
            requiresVision: false,
            requiresToolCalling: false
        ))
    }

    func analyze(input: NutritionAssistantInput) async throws -> NutritionAssistantResult {
        let prompt = Prompt {
            requestPreamble
            "Current time: \(ISO8601DateFormatter().string(from: .now))"
            input.instruction
            if let image = input.image {
                Attachment(image).label("nutrition-input")
            }
        }
        return try await respond(
            to: prompt,
            requiresVision: input.image != nil,
            requiresOCR: input.requiresOCR
        )
    }

    func revise(draft: NutritionDraft, instruction: String) async throws -> NutritionAssistantResult {
        let prompt = Prompt {
            requestPreamble
            "Revise this existing structured meal without asking a follow-up question:"
            draft
            "Correction: \(instruction)"
        }
        return try await respond(to: prompt, requiresVision: false, requiresOCR: false)
    }

    private func respond(
        to prompt: Prompt,
        requiresVision: Bool,
        requiresOCR: Bool
    ) async throws -> NutritionAssistantResult {
        let pcc = PrivateCloudComputeLanguageModel()
        let local = SystemLanguageModel.default
        let pccState = NutritionModelEndpointState(
            isAvailable: pcc.isAvailable,
            isAtQuota: pcc.quotaUsage.isLimitReached,
            supportsVision: pcc.capabilities.contains(.vision),
            supportsGuidedGeneration: pcc.capabilities.contains(.guidedGeneration),
            supportsToolCalling: pcc.capabilities.contains(.toolCalling)
        )
        let localState = NutritionModelEndpointState(
            isAvailable: local.isAvailable,
            isAtQuota: false,
            supportsVision: local.capabilities.contains(.vision),
            supportsGuidedGeneration: local.capabilities.contains(.guidedGeneration),
            supportsToolCalling: local.capabilities.contains(.toolCalling)
        )

        if NutritionRoutingPolicy.preferredRoute(
            pcc: pccState,
            onDevice: localState,
            requiresVision: requiresVision,
            requiresToolCalling: requiresOCR
        ) == .privateCloudCompute {
            do {
                return try await generate(
                    model: pcc,
                    prompt: prompt,
                    route: .privateCloudCompute,
                    usesOCR: requiresOCR
                )
            } catch {
                // A local retry preserves the no-form capture path when PCC is offline or at quota.
            }
        }

        if localState.canHandle(requiresVision: requiresVision, requiresToolCalling: requiresOCR) {
            return try await generate(
                model: local,
                prompt: prompt,
                route: .onDevice,
                usesOCR: requiresOCR
            )
        }
        throw NutritionAssistantError.unavailable(Self.unavailabilityReason(
            pcc: pcc,
            requiresVision: requiresVision,
            requiresToolCalling: requiresOCR
        ))
    }

    private func generate<Model: LanguageModel>(
        model: Model,
        prompt: Prompt,
        route: NutritionModelRoute,
        usesOCR: Bool
    ) async throws -> NutritionAssistantResult {
        #if canImport(_Vision_FoundationModels)
        let tools: [any Tool] = usesOCR ? [OCRTool()] : []
        let session = LanguageModelSession(model: model, tools: tools, instructions: Self.instructions)
        #else
        guard !usesOCR else {
            throw NutritionAssistantError.unavailable("Apple's OCR model is unavailable on this device. Text and meal-photo capture remain available.")
        }
        let session = LanguageModelSession(model: model, instructions: Self.instructions)
        #endif
        let response = try await session.respond(
            to: prompt,
            generating: NutritionDraft.self,
            options: GenerationOptions(samplingMode: .greedy)
        )
        return NutritionAssistantResult(
            generated: response.content,
            validated: try NutritionDraftValidator.validate(response.content),
            route: route,
            promptVersion: Self.promptVersion
        )
    }

    private var requestPreamble: String {
        "Return one complete nutrition estimate now. Never ask a follow-up question. Omit unknown nutrients instead of using zero."
    }

    private static let instructions = """
        You extract or estimate nutrition for a private health journal. Return totals for the entire described portion.
        Use the canonical unit implied by each metric: kcal for energy; grams for macros, fibre, and sugar; milligrams for minerals and caffeine; micrograms for vitamins A, B7, B9, B12, D, K, selenium, chromium, molybdenum, and iodine; millilitres for water.
        When an image contains a nutrition label, call OCR and preserve its explicit numbers as label provenance with high confidence.
        When analyzing a meal photo or vague description, make a conventional serving estimate, mark inferred values as estimated, and lower confidence where appropriate.
        Never claim medical certainty. Never include negative values or duplicate metrics. Omit nutrients you cannot meaningfully estimate.
        """

    nonisolated private static func unavailabilityReason(
        pcc: PrivateCloudComputeLanguageModel,
        requiresVision: Bool,
        requiresToolCalling: Bool
    ) -> String {
        let local = SystemLanguageModel.default
        let pccReady = pcc.isAvailable && !pcc.quotaUsage.isLimitReached
        let localReady = local.isAvailable

        if pccReady || localReady {
            let supportsGuidedGeneration = (pccReady && pcc.capabilities.contains(.guidedGeneration))
                || (localReady && local.capabilities.contains(.guidedGeneration))
            if !supportsGuidedGeneration {
                return "The available Apple Foundation Models do not support structured nutrition generation. There is no manual nutrition-entry fallback."
            }
        }

        if requiresVision {
            let pccCanSee = pccReady && pcc.capabilities.contains(.vision)
            let localCanSee = localReady && local.capabilities.contains(.vision)
            if !pccCanSee, !localCanSee, pcc.isAvailable || local.isAvailable {
                return "The available Apple Foundation Models on this device do not support image analysis. Text and voice nutrition capture remain available."
            }
        }

        if requiresToolCalling {
            let pccCanCallTools = pccReady && pcc.capabilities.contains(.toolCalling)
            let localCanCallTools = localReady && local.capabilities.contains(.toolCalling)
            if !pccCanCallTools, !localCanCallTools {
                return "The available Apple Foundation Models do not support nutrition-label OCR. Text, voice, and meal-photo capture remain available."
            }
        }

        let pccReason: String
        if pcc.quotaUsage.isLimitReached {
            if let resetDate = pcc.quotaUsage.resetDate {
                pccReason = "Private Cloud Compute's daily limit is reached until \(resetDate.formatted(date: .abbreviated, time: .shortened))."
            } else {
                pccReason = "Private Cloud Compute's daily limit has been reached."
            }
        } else {
            switch pcc.availability {
            case .available:
                pccReason = "Private Cloud Compute could not complete this request."
            case .unavailable(.deviceNotEligible):
                pccReason = "This device or account is not eligible for Private Cloud Compute."
            case .unavailable(.systemNotReady):
                pccReason = "Private Cloud Compute is not ready."
            case .unavailable:
                pccReason = "Private Cloud Compute is unavailable for an unrecognized system reason."
            }
        }

        let localReason: String
        switch local.availability {
        case .available:
            localReason = "The on-device system model could not complete this request."
        case .unavailable(.deviceNotEligible):
            localReason = "This device does not support the on-device Apple Intelligence model."
        case .unavailable(.appleIntelligenceNotEnabled):
            localReason = "Apple Intelligence is turned off. Enable it in Settings to use nutrition capture."
        case .unavailable(.modelNotReady):
            localReason = "The on-device Apple Intelligence model is still downloading or preparing."
        case .unavailable:
            localReason = "The on-device Apple Intelligence model is unavailable for an unrecognized system reason."
        }
        return "\(pccReason) \(localReason) There is no manual nutrition-entry fallback."
    }
}

actor PreviewNutritionAssistant: NutritionAssistantClient {
    nonisolated var availability: NutritionAssistantAvailability { .available("Deterministic preview model") }

    func analyze(input: NutritionAssistantInput) async throws -> NutritionAssistantResult {
        try makeResult(name: "Chicken burrito bowl", portion: "1 medium bowl")
    }

    func revise(draft: NutritionDraft, instruction: String) async throws -> NutritionAssistantResult {
        try makeResult(name: draft.name, portion: instruction.localizedCaseInsensitiveContains("300") ? "300 g" : draft.portionSummary)
    }

    private func makeResult(name: String, portion: String) throws -> NutritionAssistantResult {
        let draft = NutritionDraft(
            name: name,
            portionSummary: portion,
            timestampISO8601: ISO8601DateFormatter().string(from: .now),
            nutrients: [
                GeneratedNutrient(metric: .energy, amount: 640, provenance: .estimated, confidence: .medium),
                GeneratedNutrient(metric: .protein, amount: 42, provenance: .estimated, confidence: .medium),
                GeneratedNutrient(metric: .carbohydrate, amount: 71, provenance: .estimated, confidence: .medium),
                GeneratedNutrient(metric: .fat, amount: 21, provenance: .estimated, confidence: .medium),
                GeneratedNutrient(metric: .fibre, amount: 12, provenance: .estimated, confidence: .low),
            ],
            assumptions: ["Typical restaurant serving"]
        )
        return NutritionAssistantResult(
            generated: draft,
            validated: try NutritionDraftValidator.validate(draft),
            route: .preview,
            promptVersion: FoundationModelsNutritionAssistant.promptVersion
        )
    }
}

import HealthKit
import SwiftData
import XCTest
@testable import NapalmEra

final class NutritionTests: XCTestCase {
    func testSparseDraftPreservesMissingValues() throws {
        let draft = makeDraft([
            GeneratedNutrient(metric: .energy, amount: 420, provenance: .estimated, confidence: .medium),
            GeneratedNutrient(metric: .protein, amount: 31, provenance: .stated, confidence: .high),
        ])
        let result = try NutritionDraftValidator.validate(draft)

        XCTAssertEqual(result.nutrients.count, 2)
        XCTAssertNil(result.nutrients.first(where: { $0.metric == .vitaminC }))
    }

    func testValidatorRejectsDuplicateMetric() {
        let draft = makeDraft([
            GeneratedNutrient(metric: .energy, amount: 420, provenance: .estimated, confidence: .medium),
            GeneratedNutrient(metric: .energy, amount: 400, provenance: .estimated, confidence: .low),
        ])
        XCTAssertThrowsError(try NutritionDraftValidator.validate(draft)) {
            XCTAssertEqual($0 as? NutritionDraftValidationError, .duplicate(.energy))
        }
    }

    func testValidatorRejectsNegativeAndNonFiniteValues() {
        for amount in [-1.0, .infinity, .nan] {
            XCTAssertThrowsError(try NutritionDraftValidator.validate(makeDraft([
                GeneratedNutrient(metric: .protein, amount: amount, provenance: .estimated, confidence: .low),
            ])))
        }
    }

    func testAggregationSumsOnlyPresentValues() {
        let summary = DailyNutritionSummary(amounts: [
            NutritionAmount(metric: .protein, amount: 20, provenance: .estimated, confidence: .medium),
            NutritionAmount(metric: .protein, amount: 15, provenance: .label, confidence: .high),
            NutritionAmount(metric: .fat, amount: 8, provenance: .estimated, confidence: .low),
        ])
        XCTAssertEqual(summary.amount(for: .protein), 35)
        XCTAssertEqual(summary.amount(for: .fat), 8)
        XCTAssertEqual(summary.amount(for: .vitaminD), 0)
    }

    func testCanonicalUnitsAndHealthKitMappings() {
        XCTAssertEqual(NutritionMetric.energy.unitSymbol, "kcal")
        XCTAssertEqual(NutritionMetric.protein.unitSymbol, "g")
        XCTAssertEqual(NutritionMetric.vitaminD.unitSymbol, "µg")
        XCTAssertEqual(NutritionMetric.sodium.unitSymbol, "mg")
        XCTAssertEqual(NutritionMetric.energy.healthKitIdentifier, .dietaryEnergyConsumed)
        XCTAssertEqual(NutritionMetric.vitaminB9.healthKitIdentifier, .dietaryFolate)
    }

    func testRoutingPrefersPrivateCloudCompute() {
        let available = NutritionModelEndpointState(isAvailable: true, isAtQuota: false, supportsVision: true)
        XCTAssertEqual(
            NutritionRoutingPolicy.preferredRoute(pcc: available, onDevice: available, requiresVision: false),
            .privateCloudCompute
        )
    }

    func testRoutingFallsBackForOfflineOrQuotaPCC() {
        let onDevice = NutritionModelEndpointState(isAvailable: true, isAtQuota: false, supportsVision: true)
        let offlinePCC = NutritionModelEndpointState(isAvailable: false, isAtQuota: false, supportsVision: true)
        let quotaPCC = NutritionModelEndpointState(isAvailable: true, isAtQuota: true, supportsVision: true)

        XCTAssertEqual(NutritionRoutingPolicy.preferredRoute(pcc: offlinePCC, onDevice: onDevice, requiresVision: false), .onDevice)
        XCTAssertEqual(NutritionRoutingPolicy.preferredRoute(pcc: quotaPCC, onDevice: onDevice, requiresVision: false), .onDevice)
    }

    func testRoutingRequiresVisionCapabilityForPhotos() {
        let noVision = NutritionModelEndpointState(isAvailable: true, isAtQuota: false, supportsVision: false)
        XCTAssertNil(NutritionRoutingPolicy.preferredRoute(pcc: noVision, onDevice: noVision, requiresVision: true))
        XCTAssertEqual(NutritionRoutingPolicy.preferredRoute(pcc: noVision, onDevice: noVision, requiresVision: false), .privateCloudCompute)
    }

    func testRoutingRequiresGuidedGenerationForNutritionDrafts() {
        let unsupported = NutritionModelEndpointState(
            isAvailable: true,
            isAtQuota: false,
            supportsVision: true,
            supportsGuidedGeneration: false
        )
        XCTAssertNil(NutritionRoutingPolicy.preferredRoute(
            pcc: unsupported,
            onDevice: unsupported,
            requiresVision: false
        ))
    }

    func testRoutingRequiresToolCallingOnlyForLabelOCR() {
        let noTools = NutritionModelEndpointState(
            isAvailable: true,
            isAtQuota: false,
            supportsVision: true,
            supportsToolCalling: false
        )
        XCTAssertEqual(
            NutritionRoutingPolicy.preferredRoute(
                pcc: noTools,
                onDevice: noTools,
                requiresVision: true,
                requiresToolCalling: false
            ),
            .privateCloudCompute
        )
        XCTAssertNil(NutritionRoutingPolicy.preferredRoute(
            pcc: noTools,
            onDevice: noTools,
            requiresVision: true,
            requiresToolCalling: true
        ))
    }

    func testRoutingDisablesCaptureWhenNeitherModelIsAvailable() {
        let unavailable = NutritionModelEndpointState(isAvailable: false, isAtQuota: false, supportsVision: false)
        XCTAssertNil(NutritionRoutingPolicy.preferredRoute(pcc: unavailable, onDevice: unavailable, requiresVision: false))
    }

    @MainActor
    func testSeedDataUsesRequestedGymPlansAndUKDefaults() throws {
        let persistence = AppPersistence.make(inMemory: true)
        let context = ModelContext(persistence.container)
        try SeedData.installIfNeeded(in: context)

        let targets = try context.fetch(FetchDescriptor<NutritionTarget>())
        let machines = try context.fetch(FetchDescriptor<MachineProfile>())
        XCTAssertEqual(targets.first(where: { $0.metric == .energy })?.amount, 2_000)
        XCTAssertEqual(targets.first(where: { $0.metric == .vitaminD })?.amount, 10)
        XCTAssertEqual(machines.count, 16)
        XCTAssertEqual(machines.first(where: { $0.name == "Leg extension" })?.defaultSets, 2)
        XCTAssertEqual(machines.first(where: { $0.name == "Leg extension" })?.defaultReps, 12)
        XCTAssertEqual(machines.first(where: { $0.name == "Abdominal crunch" })?.defaultReps, 15)
    }

    @MainActor
    func testAssistantDraftDoesNotMutatePersistence() async throws {
        let persistence = AppPersistence.make(inMemory: true)
        let context = ModelContext(persistence.container)
        _ = try await PreviewNutritionAssistant().analyze(input: .text("Chicken bowl"))
        XCTAssertTrue(try context.fetch(FetchDescriptor<MealEntry>()).isEmpty)
    }

    private func makeDraft(_ nutrients: [GeneratedNutrient]) -> NutritionDraft {
        NutritionDraft(
            name: "Test meal",
            portionSummary: "1 serving",
            timestampISO8601: ISO8601DateFormatter().string(from: .now),
            nutrients: nutrients,
            assumptions: []
        )
    }
}

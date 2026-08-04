import EnchiridionWorkoutTransport
import Foundation

/// Narrow phone-receiver entry point. It intentionally exposes an import result
/// instead of the backing repository, so an off-screen Watch delivery cannot
/// mutate the selected workspace or gain arbitrary graph access.
extension LibraryStore {
  public func importWorkoutCapture(
    _ envelope: WorkoutCaptureEnvelope,
    registry: ModuleRegistry
  ) async throws -> WorkoutImportResult {
    guard let repository else { throw LibraryRepositoryError.invalidRecord }
    return try await repository.importWorkout(envelope, registry: registry)
  }

  public func workoutCaptureProvenance(
    moduleID: String,
    eventID: String,
    payloadHash: String
  ) async throws -> WorkoutCaptureProvenance {
    guard let repository else { throw LibraryRepositoryError.invalidRecord }
    return try await repository.workoutCaptureProvenance(
      moduleID: moduleID, eventID: eventID, payloadHash: payloadHash
    )
  }
}

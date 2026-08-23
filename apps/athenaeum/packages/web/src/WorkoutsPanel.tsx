import { useMemo, useState } from "react"
import * as Effect from "effect/Effect"
import {
  GetWorkoutInput,
  ListWorkoutsInput,
  type EntityId,
  type WorkoutCardioSplit,
  type WorkoutStrengthExercise,
  type WorkoutStrengthSet,
  type WorkoutSummary
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"

// Web-stage Phase 7 task: "Build a minimal workout list/detail view (read path only — import is
// native-only since it needs HealthKit)." Workouts are imported natively
// (`native/AthenaeumCore/Sources/AthenaeumCore/Workouts/WorkoutImportBridge.swift`, real
// `HealthKitWorkoutDataSource`/`SyntheticWorkoutDataSource` transformed through the real
// `importWorkout`/`importWorkouts` RPCs) and persisted as a `Workout`-tagged node subgraph — this
// component only ever calls the two real read methods that subgraph is reconstructed through:
// `listWorkouts` and `getWorkout` (`workout-rpc.ts`). No import/record affordance exists here by
// design, mirroring `MeetingsPanel.tsx`'s identical "native-only capture, web is read-only" scope
// split for the same reason (no HealthKit access from a browser).
//
// List/detail shape mirrors `MeetingsPanel.tsx`'s established "list is lightweight, get is the
// full aggregate" pattern verbatim: `WorkoutSummary` (from `listWorkouts`) renders one row per
// workout; selecting a row calls `getWorkout` for the full `WorkoutDetail` aggregate (root facts
// plus the reconstructed strength exercises/sets or cardio splits subgraph).

const formatDuration = (seconds: number): string => {
  const totalSeconds = Math.round(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

const formatPace = (secondsPerKm: number | undefined): string | undefined => {
  if (secondsPerKm === undefined) return undefined
  const minutes = Math.floor(secondsPerKm / 60)
  const seconds = Math.round(secondsPerKm % 60)
  return `${minutes}:${seconds.toString().padStart(2, "0")}/km`
}

function StrengthExerciseRow({ exercise }: { readonly exercise: WorkoutStrengthExercise }) {
  return (
    <li className="workouts-exercise">
      <div className="workouts-exercise-header">
        <span className="workouts-exercise-ordinal">{exercise.ordinal}.</span>
        <span className="workouts-exercise-name">{exercise.name}</span>
        <span className="workouts-exercise-volume">{exercise.volumeKilograms.toFixed(1)} kg total</span>
      </div>
      <ol className="workouts-sets">
        {exercise.sets.map((set: WorkoutStrengthSet) => (
          <li key={set.nodeId} className="workouts-set">
            <span className="workouts-set-ordinal">#{set.ordinal}</span>
            <span>{set.repetitions} reps</span>
            <span>{set.loadKilograms} kg</span>
            <span>{set.volumeKilograms.toFixed(1)} kg vol</span>
            {set.rpe !== undefined && <span className="workouts-set-rpe">RPE {set.rpe}</span>}
          </li>
        ))}
      </ol>
    </li>
  )
}

function CardioSplitRow({ split }: { readonly split: WorkoutCardioSplit }) {
  return (
    <li className="workouts-split">
      <span className="workouts-split-ordinal">#{split.ordinal}</span>
      <span>{(split.distanceMeters / 1000).toFixed(2)} km</span>
      <span>{formatDuration(split.durationSeconds)}</span>
      {split.paceSecondsPerKilometre !== undefined && (
        <span className="workouts-split-pace">{formatPace(split.paceSecondsPerKilometre)}</span>
      )}
      {split.averageHeartRate !== undefined && <span>{Math.round(split.averageHeartRate)} bpm</span>}
    </li>
  )
}

function WorkoutDetailView({ nodeId }: { readonly nodeId: EntityId }) {
  const getWorkoutEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getWorkout(new GetWorkoutInput({ workspaceId, nodeId })))
      ),
    [nodeId]
  )
  const state = useEffectQuery(getWorkoutEffect, [nodeId])

  if (state.status === "loading") return <p className="workouts-detail-loading">Loading workout…</p>
  if (state.status === "failure") {
    return <p className="error">{formatDomainError(state.error)}</p>
  }

  const { workout } = state.value

  return (
    <div className="workouts-detail">
      <div className="workouts-detail-header">
        <h3>
          {workout.activity}
          {workout.rawActivity !== undefined && <span className="workouts-raw-activity"> ({workout.rawActivity})</span>}
        </h3>
        <p className="workouts-detail-meta">
          {new Date(workout.startedAt).toLocaleString()} · {formatDuration(workout.durationSeconds)} ·{" "}
          <span className="workouts-source">{workout.source}</span>
        </p>
        <p className="workouts-detail-vitals">
          {workout.energyKilocalories !== undefined && <span>{Math.round(workout.energyKilocalories)} kcal</span>}
          {workout.averageHeartRate !== undefined && <span>avg {Math.round(workout.averageHeartRate)} bpm</span>}
          {workout.maximumHeartRate !== undefined && <span>max {Math.round(workout.maximumHeartRate)} bpm</span>}
        </p>
      </div>

      {workout.payload.kind === "strength" ? (
        workout.payload.exercises.length === 0 ? (
          <p className="workouts-detail-empty">No exercises recorded.</p>
        ) : (
          <ol className="workouts-exercises">
            {workout.payload.exercises.map((exercise: WorkoutStrengthExercise) => (
              <StrengthExerciseRow key={exercise.nodeId} exercise={exercise} />
            ))}
          </ol>
        )
      ) : (
        <>
          <p className="workouts-detail-cardio-rollups">
            {workout.payload.distanceMeters !== undefined && (
              <span>{(workout.payload.distanceMeters / 1000).toFixed(2)} km</span>
            )}
            {workout.payload.elevationMeters !== undefined && (
              <span>{Math.round(workout.payload.elevationMeters)} m elevation</span>
            )}
            {workout.payload.averagePaceSecondsPerKilometre !== undefined && (
              <span>{formatPace(workout.payload.averagePaceSecondsPerKilometre)} avg</span>
            )}
          </p>
          {workout.payload.splits.length === 0 ? (
            <p className="workouts-detail-empty">No split/lap structure recorded for this workout.</p>
          ) : (
            <ol className="workouts-splits">
              {workout.payload.splits.map((split: WorkoutCardioSplit) => (
                <CardioSplitRow key={split.nodeId} split={split} />
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  )
}

export function WorkoutsPanel() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedNodeId, setSelectedNodeId] = useState<EntityId | undefined>(undefined)

  const workoutsEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listWorkouts(new ListWorkoutsInput({ workspaceId })))),
    [refreshKey]
  )
  const workoutsState = useEffectQuery(workoutsEffect, [refreshKey])

  const workouts: ReadonlyArray<WorkoutSummary> =
    workoutsState.status === "success" ? workoutsState.value.workouts : []

  return (
    <section className="workouts-panel">
      <h2>Workouts</h2>
      <p className="workouts-panel-hint">
        Read-only here — workout import happens natively, from HealthKit (or a synthetic data
        source for testing), through a real Swift <code>WorkoutDataSource</code> pipeline. This
        panel lists what's been imported into this workspace and lets you review one workout's full
        exercise/set or split detail.
      </p>

      <button type="button" onClick={() => setRefreshKey((k) => k + 1)} disabled={workoutsState.status === "loading"}>
        {workoutsState.status === "loading" ? "Loading…" : "Refresh"}
      </button>

      {workoutsState.status === "failure" && <p className="error">{formatDomainError(workoutsState.error)}</p>}
      {workoutsState.status === "success" && workouts.length === 0 && (
        <p className="workouts-empty">No workouts imported yet.</p>
      )}

      <ul className="workouts-list">
        {workouts.map((workout) => (
          <li key={workout.nodeId} className="workouts-list-item">
            <button
              type="button"
              className={
                workout.nodeId === selectedNodeId
                  ? "workouts-list-item-button workouts-list-item-button-selected"
                  : "workouts-list-item-button"
              }
              onClick={() => setSelectedNodeId(workout.nodeId)}
            >
              <span className="workouts-list-item-kind">{workout.kind}</span>
              <span className="workouts-list-item-activity">{workout.activity}</span>
              <span className="workouts-list-item-meta">
                {new Date(workout.startedAt).toLocaleString()} · {formatDuration(workout.durationSeconds)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selectedNodeId !== undefined && <WorkoutDetailView nodeId={selectedNodeId} />}
    </section>
  )
}

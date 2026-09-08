import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router"
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
import { EmptyState } from "./EmptyState.js"

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
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ nodeId: EntityId; sawLoading: boolean } | undefined>(undefined)
  const getWorkoutEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getWorkout(new GetWorkoutInput({ workspaceId, nodeId })))
      ),
    [nodeId, retryGeneration]
  )
  const state = useEffectQuery(getWorkoutEffect, [nodeId, retryGeneration])
  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (claim.nodeId !== nodeId) {
      retryClaim.current = undefined
      setRetryClaimed(false)
      return
    }
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    // A retry-generation render still contains the preceding failure result. Keep the claim until
    // this selected workout has visibly entered loading, then release it only after it settles.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [nodeId, state.status])
  const retryWorkout = useCallback(() => {
    if (retryClaim.current !== undefined || state.status === "loading") return
    retryClaim.current = { nodeId, sawLoading: false }
    setRetryClaimed(true)
    setRetryGeneration((generation) => generation + 1)
  }, [nodeId, state.status])
  const isRetryingWorkout = retryClaimed || state.status === "loading"

  if (state.status === "loading") {
    return (
      <p className="workouts-detail-loading" role="status" aria-live="polite" aria-atomic="true">
        Loading workout…
      </p>
    )
  }
  if (state.status === "failure") {
    if (state.error._tag === "WorkoutNotFound") {
      return (
        <section className="workouts-load-state" role="status">
          <p>This workout is no longer available. Refresh activity history to update the list.</p>
        </section>
      )
    }
    return (
      <section className="workouts-load-state" role="alert" aria-label="Workout details are unavailable">
        <p>Workout details couldn&rsquo;t be loaded. Nothing has been changed.</p>
        <button type="button" onClick={retryWorkout} disabled={isRetryingWorkout}>
          {isRetryingWorkout ? "Retrying…" : "Retry"}
        </button>
      </section>
    )
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
  const [refreshClaimed, setRefreshClaimed] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<EntityId | undefined>(undefined)
  const refreshClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)

  const workoutsEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listWorkouts(new ListWorkoutsInput({ workspaceId })))),
    [refreshKey]
  )
  const workoutsState = useEffectQuery(workoutsEffect, [refreshKey])
  // `useEffectQuery` keeps its preceding settled result until the next list generation enters
  // loading. Retain that same-workspace list for continuity, but do not let it claim a current
  // empty history while the new generation is still unresolved.
  const activeRefreshKey = useRef(refreshKey)
  useEffect(() => {
    activeRefreshKey.current = refreshKey
  }, [refreshKey])
  const stateIsCurrent = activeRefreshKey.current === refreshKey
  const currentWorkouts = stateIsCurrent && workoutsState.status === "success" ? workoutsState.value.workouts : undefined
  const successfulWorkouts = useRef<ReadonlyArray<WorkoutSummary> | undefined>(currentWorkouts)
  if (currentWorkouts !== undefined) successfulWorkouts.current = currentWorkouts
  const cachedWorkouts = successfulWorkouts.current
  const visibleWorkouts = currentWorkouts ?? cachedWorkouts ?? []
  const isLoadingWorkouts = !stateIsCurrent || workoutsState.status === "loading"

  useEffect(() => {
    const claim = refreshClaim.current
    if (claim === undefined) return
    if (workoutsState.status === "loading") {
      claim.sawLoading = true
      return
    }
    // A refresh-key render initially retains the preceding result. Keep this presentation claim
    // until the list visibly enters loading, then release it only after that read settles.
    if (!claim.sawLoading) return
    refreshClaim.current = undefined
    setRefreshClaimed(false)
  }, [workoutsState.status])

  const refreshWorkouts = useCallback(() => {
    if (refreshClaim.current !== undefined || workoutsState.status === "loading") return
    refreshClaim.current = { sawLoading: false }
    setRefreshClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [workoutsState.status])

  const isRefreshingWorkouts = refreshClaimed || isLoadingWorkouts

  return (
    <section className="workouts-panel">
      <h2>Workouts</h2>
      <p className="workouts-panel-hint">
        Review activity from HealthKit alongside your notes. Each imported workout is structured
        so you can search, link, and build on it later.
      </p>

      <button type="button" onClick={refreshWorkouts} disabled={isRefreshingWorkouts}>
        {refreshClaimed || (isLoadingWorkouts && cachedWorkouts !== undefined)
          ? "Refreshing…"
          : isLoadingWorkouts
            ? "Loading…"
            : "Refresh"}
      </button>

      {workoutsState.status === "failure" && (
        <section className="workouts-load-state" role="alert" aria-label="Workouts are unavailable">
          <p>
            {cachedWorkouts === undefined
              ? "Workouts couldn’t be loaded. Nothing has been changed."
              : "Workouts couldn’t be refreshed. Your previously loaded workouts remain available."}
          </p>
          <button type="button" onClick={refreshWorkouts} disabled={isRefreshingWorkouts}>
            {isRefreshingWorkouts ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {currentWorkouts !== undefined && currentWorkouts.length === 0 && (
        <EmptyState
          icon="◌"
          title="No activity here yet"
          message="Import a workout from HealthKit in the macOS app. Your activity will show up here as typed context."
          action={<Link className="ds-button" to="/notes">Open today’s note</Link>}
        />
      )}

      <ul className="workouts-list">
        {visibleWorkouts.map((workout) => (
          <li key={workout.nodeId} className="workouts-list-item">
            <button
              type="button"
              className={
                workout.nodeId === selectedNodeId
                  ? "workouts-list-item-button workouts-list-item-button-selected"
                  : "workouts-list-item-button"
              }
              aria-current={workout.nodeId === selectedNodeId ? "true" : undefined}
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

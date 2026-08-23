import {
  AddMarkStep,
  RemoveMarkStep,
  ReplaceStep,
  ReplaceAroundStep,
  Step,
} from "prosemirror-transform"
import { Mark, Node } from "prosemirror-model"
import { Prop, next as automerge } from "@automerge/automerge"
import { pmNodeToSpans, pmRangeToAmRange } from "./traversal.js"
import { next as am } from "@automerge/automerge"
import { SchemaAdapter, amMarksFromPmMarks } from "./schema.js"

export type ChangeFn<T> = (doc: T, field: string) => void

export default function (
  adapter: SchemaAdapter,
  spans: am.Span[],
  steps: Step[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  pmDoc: Node,
  path: Prop[],
) {
  let unappliedMarks: AddMarkStep[] = []

  function flushMarks() {
    if (unappliedMarks.length > 0) {
      applyAddMarkSteps(adapter, spans, unappliedMarks, doc, path)
      unappliedMarks = []
    }
  }

  for (const step of steps) {
    // console.log(JSON.stringify(step))
    const stepId = step.toJSON()["stepType"]
    if (stepId === "addMark") {
      unappliedMarks.push(step as AddMarkStep)
      continue
    } else {
      flushMarks()
    }
    oneStep(adapter, spans, stepId, step, doc, pmDoc, path)
    const nextDoc = step.apply(pmDoc).doc
    if (nextDoc == null) {
      throw new Error("Could not apply step to document")
    }
    pmDoc = nextDoc
    spans = automerge.spans(doc, path)
  }
  flushMarks()
}

function oneStep(
  adapter: SchemaAdapter,
  spans: am.Span[],
  stepId: string,
  step: Step,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  pmDoc: Node,
  path: Prop[],
) {
  if (stepId === "replace") {
    replaceStep(adapter, spans, step as ReplaceStep, doc, path, pmDoc)
  } else if (stepId === "replaceAround") {
    replaceAroundStep(adapter, step as ReplaceAroundStep, doc, pmDoc, path)
  } else if (stepId === "removeMark") {
    removeMarkStep(adapter, spans, step as RemoveMarkStep, doc, path)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function replaceStep(
  adapter: SchemaAdapter,
  spans: am.Span[],
  step: ReplaceStep,
  doc: automerge.Doc<unknown>,
  field: Prop[],
  pmDoc: Node,
) {
  if (
    step.slice.content.childCount === 1 &&
    step.slice.content.firstChild?.isText
  ) {
    // This is a text insertion or deletion
    const amRange = pmRangeToAmRange(adapter, spans, {
      from: step.from,
      to: step.to,
    })
    if (amRange == null) {
      throw new Error(
        `Could not find range (${step.from}, ${step.to}) in render tree`,
      )
    }
    let { start, end } = amRange
    if (start > end) {
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
      ;[start, end] = [end, start]
    }

    const toDelete = end - start
    automerge.splice(
      doc,
      field,
      start,
      toDelete,
      step.slice.content.firstChild.text,
    )

    const marks = step.slice.content.firstChild.marks
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const length = step.slice.content.firstChild.text!.length
    reconcileMarks(adapter, doc, field, start, length, marks)
    return
  }
  const applied = step.apply(pmDoc).doc
  if (applied == null) {
    throw new Error("Could not apply step to document")
  }
  const newSpans = pmNodeToSpans(adapter, applied)
  automerge.updateSpans(doc, field, newSpans, adapter.updateSpansConfig())
}

function replaceAroundStep(
  adapter: SchemaAdapter,
  step: ReplaceAroundStep,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  pmDoc: Node,
  field: Prop[],
) {
  const applied = step.apply(pmDoc).doc
  if (applied == null) {
    throw new Error("Could not apply step to document")
  }
  const newSpans = pmNodeToSpans(adapter, applied)
  automerge.updateSpans(doc, field, newSpans, adapter.updateSpansConfig())
}

function applyAddMarkSteps(
  adapter: SchemaAdapter,
  spans: am.Span[],
  steps: AddMarkStep[],
  doc: automerge.Doc<unknown>,
  field: Prop[],
) {
  type Mark = {
    range: { start: number; end: number }
    markName: string
    expand: "before" | "after" | "both" | "none"
    value: am.MarkValue
  }
  const marks: Mark[] = steps.map(step => {
    const amRange = pmRangeToAmRange(adapter, spans, {
      from: step.from,
      to: step.to,
    })
    if (amRange == null) {
      throw new Error(
        `Could not find range (${step.from}, ${step.to}) in render tree`,
      )
    }
    // Deliberate vendoring edit #4 (see `VENDOR.md`): upstream read `step.mark.type.name` (the
    // ProseMirror mark's own schema key) directly as the Automerge mark name, and derived the
    // stored value from a hardcoded `markAttrsToMarkValue` switch covering only upstream's own
    // `link`/`strong`/`em`/`code` marks (falling back to a bare `true` for anything else). Both
    // bypass the `markMappings` indirection `amMarksFromPmMarks`/`pmMarksFromAmMarks` (schema.ts)
    // already use correctly — harmless for every mark in this app's schema whose ProseMirror key
    // happens to equal its `automerge.markName` (em/strong/code/strike/link all do), but a real,
    // silent data-loss bug for `entityRef`: its automerge name is the *different* string
    // `"entity-ref"`, and its real payload (`{nodeId, label}`, via its own `fromProsemirror`
    // parser) was being discarded in favor of a bare boolean `true`. Confirmed for real: an
        // @-mention inserted via `tr.addMark` (this schema's `mention-plugin.ts`) round-tripped through
    // a reload as an unrecognized/`unknownMark` span, its `nodeId` gone. Reusing the same mapping
    // lookup the read path already trusts is the fix.
    const mapping = adapter.markMappings.find(m => m.prosemirrorMark === step.mark.type)
    if (mapping == null) {
      // No Automerge mapping for this mark (matches `amMarksFromPmMarks`'s own "unmapped mark"
      // handling, which folds it into `unknownMark`'s carried-attrs bag rather than throwing) —
      // nothing to persist.
      return null
    }
    const markName = mapping.automergeMarkName
    const expand = step.mark.type.spec.inclusive ? "both" : "none"
    const value = mapping.parsers.fromProsemirror(step.mark)
    return { range: amRange, markName, expand, value }
  }).filter((mark): mark is Mark => mark != null)

  const groupedMarks: Mark[] = marks.reduce((acc, mark) => {
    const lastGroup = acc[acc.length - 1]
    if (lastGroup == null) {
      return [mark]
    }
    if (
      lastGroup.markName === mark.markName &&
      lastGroup.expand === mark.expand &&
      lastGroup.value === mark.value
    ) {
      if (lastGroup.range.end === mark.range.start) {
        lastGroup.range.end = mark.range.end
        return acc
      } else {
        const spansBetween = spans.slice(lastGroup.range.end, mark.range.start)
        if (spansBetween.every(s => s.type === "block")) {
          lastGroup.range.end = mark.range.end
          return acc
        }
      }
    }
    acc.push(mark)
    return acc
  }, [] as Mark[])

  //console.log(groupedMarks)

  for (const mark of groupedMarks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    automerge.mark(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doc as any,
      field,
      { start: mark.range.start, end: mark.range.end, expand: mark.expand },
      mark.markName,
      mark.value,
    )
  }
}

function removeMarkStep(
  adapter: SchemaAdapter,
  spans: am.Span[],
  step: RemoveMarkStep,
  doc: automerge.Doc<unknown>,
  field: Prop[],
) {
  const amRange = pmRangeToAmRange(adapter, spans, {
    from: step.from,
    to: step.to,
  })
  if (amRange == null) {
    throw new Error(
      `Could not find range (${step.from}, ${step.to}) in render tree`,
    )
  }
  const { start, end } = amRange
  if (start == null || end == null) {
    throw new Error(
      `Could not find step.from (${step.from}) or step.to (${step.to}) in render tree`,
    )
  }
  // Same fix as `applyAddMarkSteps` above (vendoring edit #4): the Automerge mark name must come
  // from the mapping, not `step.mark.type.name` directly, or an unmark on `entityRef` would target
  // the wrong Automerge key ("entityRef" instead of "entity-ref") and leave the real mark in place.
  const mapping = adapter.markMappings.find(m => m.prosemirrorMark === step.mark.type)
  if (mapping == null) return
  const markName = mapping.automergeMarkName
  const expand = step.mark.type.spec.inclusive ? "both" : "none"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  automerge.unmark(doc as any, field, { start, end, expand }, markName)
}

function reconcileMarks(
  adapter: SchemaAdapter,
  doc: am.Doc<unknown>,
  path: am.Prop[],
  index: number,
  length: number,
  marks: readonly Mark[],
) {
  const currentMarks = automerge.marksAt(doc, path, index)
  const newMarks = amMarksFromPmMarks(adapter, marks)

  const newMarkNames = new Set(Object.keys(newMarks))
  const currentMarkNames = new Set(Object.keys(currentMarks))

  for (const markName of newMarkNames) {
    if (
      !currentMarkNames.has(markName) ||
      newMarks[markName] !== currentMarks[markName]
    ) {
      const expand =
        (marks.find(m => m.type.name === markName)?.type.spec.inclusive ?? true)
          ? "both"
          : "none"
      automerge.mark(
        doc,
        path,
        { start: index, end: index + length, expand },
        markName,
        newMarks[markName],
      )
    }
  }
  for (const markName of currentMarkNames) {
    const markMapping = adapter.markMappings.find(
      m => m.automergeMarkName === markName,
    )
    if (markMapping == null) {
      continue
    }
    if (!newMarkNames.has(markName)) {
      automerge.unmark(
        doc,
        path,
        { start: index, end: index + length, expand: "both" },
        markName,
      )
    }
  }
}

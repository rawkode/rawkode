/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router"
import { EntityId, ResolvedTagField, Tag, TagFieldDefinition } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryMock = vi.hoisted(() => ({
  tags: [] as unknown[],
  fieldsByTagId: new Map<string, unknown[]>()
}))

vi.mock("./AddTagFieldForm.js", () => ({ AddTagFieldForm: () => null }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    if (dependencies.length === 1) return { status: "success", value: queryMock.tags }
    return {
      status: "success",
      value: queryMock.fieldsByTagId.get(dependencies[0] as string) ?? []
    }
  }
}))

import { mergeTagEditBaseline, requestForTagEditDraft, resolveVisibleTag, SupertagsManager, tagEditRequestSignature } from "./SupertagsManager.js"

const person = new Tag({
  id: EntityId.make("00000000-0000-4000-8000-000000000001"),
  name: "Person",
  parentIds: [],
  builtin: true
})
const project = new Tag({
  id: EntityId.make("00000000-0000-4000-8000-000000000002"),
  name: "Project",
  parentIds: [],
  builtin: false
})

const fieldFor = (tag: Tag, name: string): ResolvedTagField => new ResolvedTagField({
  field: new TagFieldDefinition({
    id: EntityId.make(tag === person ? "00000000-0000-4000-8000-000000000101" : "00000000-0000-4000-8000-000000000102"),
    tagId: tag.id,
    name,
    valueKind: "text",
    sortOrder: 0,
    builtin: tag.builtin
  }),
  inherited: false
})

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function LocationProbe() {
  const location = useLocation()
  return <output data-path={location.pathname} />
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/supertags"]}>
        <SupertagsManager />
        <LocationProbe />
      </MemoryRouter>
    )
    await flush()
  })
  return host
}

const buttonFor = (host: HTMLElement, name: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>(".supertags-list-item-button")]
    .find((button) => button.textContent?.includes(`#${name}`))

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryMock.tags = [project, person]
  queryMock.fieldsByTagId = new Map([
    [person.id, [fieldFor(person, "role")]],
    [project.id, [fieldFor(project, "status")]]
  ])
})

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  queryMock.tags = []
  queryMock.fieldsByTagId = new Map()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("SupertagsManager schema selection", () => {
  it("mints a new request after a failed save is edited, while an unchanged retry is identical", () => {
    const base = { revision: "a".repeat(64), name: "Project", parentIds: new Set<EntityId>([person.id]) }
    const retry = { ...base, parentIds: new Set(base.parentIds) }
    const editedName = { ...base, name: "Project Atlas" }
    const editedParents = { ...base, parentIds: new Set<EntityId>([person.id, project.id]) }
    expect(tagEditRequestSignature(retry)).toBe(tagEditRequestSignature(base))
    expect(tagEditRequestSignature(editedName)).not.toBe(tagEditRequestSignature(base))
    expect(tagEditRequestSignature(editedParents)).not.toBe(tagEditRequestSignature(base))
    let next = 0
    const mint = () => `request-${++next}`
    const failed = requestForTagEditDraft(undefined, base, mint)
    expect(requestForTagEditDraft(failed, retry, mint)).toBe(failed)
    expect(requestForTagEditDraft(failed, editedName, mint)).toMatchObject({ id: "request-2" })
  })

  it("keeps unsaved values when a conflict reload supplies a current revision", () => {
    const draft = { revision: "a".repeat(64), name: "Project Atlas", parentIds: new Set<EntityId>([person.id]) }
    const refreshed = mergeTagEditBaseline(draft, "b".repeat(64))
    expect(refreshed).toEqual({ ...draft, revision: "b".repeat(64) })
    expect(refreshed.name).toBe("Project Atlas")
    expect([...refreshed.parentIds]).toEqual([person.id])
  })

  it("falls back deterministically for no or stale selections but preserves a valid explicit choice", () => {
    const sorted = [person, project]
    const tagsById = new Map(sorted.map((tag) => [tag.id as string, tag]))

    expect(resolveVisibleTag(null, sorted, tagsById)).toBe(person)
    expect(resolveVisibleTag(EntityId.make("00000000-0000-4000-8000-000000000099"), sorted, tagsById)).toBe(person)
    expect(resolveVisibleTag(project.id, sorted, tagsById)).toBe(project)
  })

  it("opens the first visible schema on route entry and keeps an explicit row selection", async () => {
    const host = await mount()

    expect(host.querySelector(".supertags-list-item-button-selected")?.textContent).toContain("#Person")
    expect(buttonFor(host, "Person")?.getAttribute("aria-current")).toBe("true")
    expect(buttonFor(host, "Project")?.getAttribute("aria-current")).toBeNull()
    expect(host.querySelector(".supertags-detail")?.textContent).toContain("#Person")
    expect(host.querySelector(".supertags-detail")?.textContent).toContain("role")

    await act(async () => {
      buttonFor(host, "Project")?.click()
      await flush()
    })

    expect(host.querySelector(".supertags-list-item-button-selected")?.textContent).toContain("#Project")
    expect(buttonFor(host, "Person")?.getAttribute("aria-current")).toBeNull()
    expect(buttonFor(host, "Project")?.getAttribute("aria-current")).toBe("true")
    expect(host.querySelector(".supertags-detail")?.textContent).toContain("#Project")
    expect(host.querySelector(".supertags-detail")?.textContent).toContain("status")
  })

  it("guides a confirmed empty catalog to the daily-note inline authoring path", async () => {
    queryMock.tags = []
    const host = await mount()

    const emptyState = host.querySelector(".supertags-empty")
    expect(emptyState?.textContent).toContain("No Supertags yet.")
    expect(emptyState?.textContent).toContain("apply or create one inline with #")
    const dailyNoteLink = emptyState?.querySelector<HTMLAnchorElement>('a[href="/notes"]')
    expect(dailyNoteLink?.textContent).toBe("Open today’s note")
    expect(host.querySelector(".supertags-create-disclosure")).not.toBeNull()
    expect(host.querySelector("output")?.getAttribute("data-path")).toBe("/supertags")

    await act(async () => {
      dailyNoteLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }))
      await flush()
    })

    expect(host.querySelector("output")?.getAttribute("data-path")).toBe("/notes")
  })
})

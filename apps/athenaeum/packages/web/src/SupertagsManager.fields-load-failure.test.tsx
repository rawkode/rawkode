/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, ResolvedTagField, Tag, TagFieldDefinition, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[],
  fields: undefined as unknown,
  fieldsByTagAndGeneration: new Map<string, unknown>(),
  tags: [] as ReadonlyArray<Tag>
}))

vi.mock("./AddTagFieldForm.js", () => ({
  AddTagFieldForm: ({ onAdded }: { readonly onAdded: () => void }) => (
    <button type="button" data-testid="add-field-form" onClick={onAdded}>Add Field</button>
  )
}))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return dependencies.length === 1
      ? { status: "success" as const, value: queryStateMock.tags }
      : queryStateMock.fieldsByTagAndGeneration.get(`${dependencies[0]}:${dependencies[1]}`) ?? queryStateMock.fields
  }
}))

import { SupertagsManager } from "./SupertagsManager.js"

const project = new Tag({
  id: EntityId.make("00000000-0000-4000-8000-000000000002"),
  name: "Project",
  parentIds: [],
  builtin: false
})
const reference = new Tag({
  id: EntityId.make("00000000-0000-4000-8000-000000000003"),
  name: "Reference",
  parentIds: [],
  builtin: false
})
const projectStatusField = new ResolvedTagField({
  field: new TagFieldDefinition({
    id: EntityId.make("00000000-0000-4000-8000-000000000004"),
    tagId: project.id,
    name: "Status",
    valueKind: "text",
    sortOrder: 0,
    builtin: false
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

const fieldGenerations = (tagId: EntityId): number[] => [
  ...new Set(
    queryStateMock.dependencies
      .filter((dependencies) => dependencies[0] === tagId)
      .map((dependencies) => dependencies[1])
      .filter((value): value is number => typeof value === "number")
  )
]

const catalogGenerations = (): number[] => [
  ...new Set(
    queryStateMock.dependencies
      .filter((dependencies) => dependencies.length === 1)
      .map((dependencies) => dependencies[0])
      .filter((value): value is number => typeof value === "number")
  )
]

const tagButton = (host: HTMLDivElement, name: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>(".supertags-list-item-button")]
    .find((button) => button.textContent?.includes(`#${name}`))

const render = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<SupertagsManager />)
    await flush()
  })
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root)
  return host
}

const rerender = async (host: HTMLDivElement): Promise<void> => {
  const root = roots.find((entry) => entry.host === host)?.root
  if (root === undefined) throw new Error("expected mounted SupertagsManager root")
  await render(root)
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.dependencies = []
  queryStateMock.fieldsByTagAndGeneration.clear()
  queryStateMock.tags = [project, reference]
  queryStateMock.fields = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "private field schema detail" })
  }
})

afterEach(() => {
  queryStateMock.fieldsByTagAndGeneration.clear()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("SupertagsManager field schema recovery", () => {
  it("keeps the selected tag visible and retries its field read once at a time", async () => {
    const host = await mount()

    const detail = host.querySelector<HTMLElement>(".supertags-detail")
    const alert = host.querySelector<HTMLElement>(".supertags-fields-load-state")
    expect(host.querySelector(".supertags-list-item-button-selected")?.textContent).toContain("#Project")
    expect(detail?.textContent).toContain("#Project")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("We couldn’t load this Supertag’s fields.")
    expect(host.textContent).not.toContain("private field schema detail")
    expect(host.querySelector(".supertags-fields-empty")).toBeNull()
    expect(host.querySelector("[data-testid='add-field-form']")).toBeNull()
    expect(catalogGenerations()).toEqual([0])
    expect(fieldGenerations(project.id)).toEqual([0])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(fieldGenerations(project.id)).toEqual([0, 1])
    const retryingButton = host.querySelector<HTMLButtonElement>(".supertags-fields-load-state button")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    queryStateMock.fieldsByTagAndGeneration.set(`${project.id}:1`, { status: "loading" as const })
    await rerender(host)
    const loadingStatus = host.querySelector<HTMLElement>(".supertags-fields-loading")
    expect(loadingStatus?.textContent).toContain("Loading fields…")
    expect(loadingStatus?.getAttribute("role")).toBe("status")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")

    queryStateMock.fieldsByTagAndGeneration.set(`${project.id}:1`, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "private field schema detail" })
    })
    await rerender(host)
    const releasedButton = host.querySelector<HTMLButtonElement>(".supertags-fields-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(fieldGenerations(project.id)).toEqual([0, 1, 2])
    expect(catalogGenerations()).toEqual([0])
  })

  it("clears a claimed field retry when selection changes without refreshing the catalog", async () => {
    const host = await mount()
    const alert = host.querySelector<HTMLElement>(".supertags-fields-load-state")

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(fieldGenerations(project.id)).toEqual([0, 1])
    expect(host.querySelector<HTMLButtonElement>(".supertags-fields-load-state button")?.disabled).toBe(true)

    queryStateMock.fieldsByTagAndGeneration.set(`${reference.id}:1`, { status: "loading" as const })
    await act(async () => {
      tagButton(host, "Reference")?.click()
      await flush()
    })
    expect(host.querySelector(".supertags-list-item-button-selected")?.textContent).toContain("#Reference")
    expect(fieldGenerations(reference.id)).toEqual([1])

    queryStateMock.fieldsByTagAndGeneration.set(`${reference.id}:1`, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "private field schema detail" })
    })
    await rerender(host)
    const releasedButton = host.querySelector<HTMLButtonElement>(".supertags-fields-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(fieldGenerations(reference.id)).toEqual([1, 2])
    expect(catalogGenerations()).toEqual([0])
  })

  it("keeps a successful empty field schema distinct from a failed request", async () => {
    queryStateMock.fields = { status: "success" as const, value: [] }

    const host = await mount()

    expect(host.querySelector(".supertags-fields-load-state")).toBeNull()
    expect(host.querySelector(".supertags-fields-empty")?.textContent).toContain("No fields yet")
    expect(host.querySelector("[data-testid='add-field-form']")).not.toBeNull()
  })

  it("retains only selected-tag fields during a same-tag refresh and failed read", async () => {
    queryStateMock.fields = { status: "success" as const, value: [projectStatusField] }
    const host = await mount()

    expect(host.querySelector(".supertags-field-row")?.textContent).toContain("Status")
    expect(host.querySelector("[data-testid='add-field-form']")).not.toBeNull()

    queryStateMock.fieldsByTagAndGeneration.set(`${project.id}:1`, { status: "loading" as const })
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='add-field-form']")?.click()
      await flush()
    })

    expect(fieldGenerations(project.id)).toEqual([0, 1])
    const refreshStatus = host.querySelector<HTMLElement>(".supertags-fields-loading")
    expect(refreshStatus?.textContent).toContain("Refreshing fields…")
    expect(refreshStatus?.getAttribute("role")).toBe("status")
    expect(refreshStatus?.getAttribute("aria-live")).toBe("polite")
    expect(refreshStatus?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector(".supertags-field-row")?.textContent).toContain("Status")
    expect(host.querySelector("[data-testid='add-field-form']")).toBeNull()

    queryStateMock.fieldsByTagAndGeneration.set(`${project.id}:1`, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "private field schema detail" })
    })
    await rerender(host)

    expect(host.querySelector(".supertags-fields-load-state")?.textContent).toContain("couldn’t refresh")
    expect(host.textContent).not.toContain("private field schema detail")
    expect(host.querySelector(".supertags-field-row")?.textContent).toContain("Status")
    expect(host.querySelector("[data-testid='add-field-form']")).toBeNull()

    queryStateMock.fieldsByTagAndGeneration.set(`${project.id}:1`, { status: "success" as const, value: [] })
    await rerender(host)

    expect(host.querySelector(".supertags-field-row")).toBeNull()
    expect(host.querySelector(".supertags-fields-empty")?.textContent).toContain("No fields yet")
    expect(host.querySelector("[data-testid='add-field-form']")).not.toBeNull()
  })

  it("does not show a prior tag's fields while another tag is loading", async () => {
    queryStateMock.fields = { status: "success" as const, value: [projectStatusField] }
    const host = await mount()

    queryStateMock.fieldsByTagAndGeneration.set(`${reference.id}:0`, { status: "loading" as const })
    await act(async () => {
      tagButton(host, "Reference")?.click()
      await flush()
    })

    expect(host.querySelector(".supertags-list-item-button-selected")?.textContent).toContain("#Reference")
    expect(host.querySelector(".supertags-fields-loading")?.textContent).toContain("Loading fields…")
    expect(host.textContent).not.toContain("Status")
    expect(host.querySelector("[data-testid='add-field-form']")).toBeNull()
  })
})

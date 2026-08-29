/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const devSessionMock = vi.hoisted(() => ({ signIn: vi.fn() }))

vi.mock("./dev-session.js", () => devSessionMock)

import { SignIn } from "./SignIn.js"

const session = {
  email: "writer@example.com",
  credential: "test-credential",
  issuedAt: "2026-08-28T00:00:00.000Z",
  expiresAt: "2026-08-29T00:00:00.000Z"
}

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const deferred = <A,>() => {
  let resolve!: (value: A | PromiseLike<A>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const mount = async (onSignedIn: (value: typeof session) => void): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<SignIn onSignedIn={onSignedIn} />)
    await flush()
  })
  return host
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  devSessionMock.signIn.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("SignIn failure privacy", () => {
  it("keeps a failed sign-in generic and preserves the email until a later success", async () => {
    const privateDetail = "private backend sign-in response"
    const failedSignIn = deferred<typeof session>()
    devSessionMock.signIn.mockReturnValueOnce(failedSignIn.promise).mockResolvedValueOnce(session)
    const onSignedIn = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const host = await mount(onSignedIn)
    const input = host.querySelector<HTMLInputElement>("#sign-in-email")
    const form = host.querySelector<HTMLFormElement>(".sign-in-form")

    await act(async () => {
      setInput(input!, session.email)
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(devSessionMock.signIn).toHaveBeenCalledTimes(1)
    expect(devSessionMock.signIn).toHaveBeenCalledWith(session.email)
    expect(input?.disabled).toBe(true)
    expect(host.querySelector(".sign-in-form button")?.textContent).toBe("Signing in…")
    expect(onSignedIn).not.toHaveBeenCalled()

    await act(async () => {
      failedSignIn.reject(new Error(privateDetail))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toBe("We couldn’t complete dev sign-in. Check the email and try again.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(input?.value).toBe(session.email)
    expect(input?.disabled).toBe(false)
    expect(devSessionMock.signIn).toHaveBeenCalledWith(session.email)
    expect(devSessionMock.signIn).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith(expect.any(Error))
    expect(onSignedIn).not.toHaveBeenCalled()

    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(host.querySelector("[role='alert']")).toBeNull()
    expect(onSignedIn).toHaveBeenCalledWith(session)
    expect(devSessionMock.signIn).toHaveBeenCalledTimes(2)
    expect(devSessionMock.signIn).toHaveBeenLastCalledWith(session.email)
  })
})

import { createNodeFromLoroObj, type LoroNode } from "loro-prosemirror"
import { DOMSerializer } from "prosemirror-model"
import type { LoroDoc } from "loro-crdt/bundler"
import { inspectLoroPage } from "./loro-page.js"
import { richTextSchemaAdapter } from "./rich-text/schema.js"

export type StaticLoroPreview =
  | { readonly kind: "empty" }
  | { readonly kind: "content"; readonly html: string }
  | { readonly kind: "unsupported" }

const permittedHref = (value: string): string | undefined => {
  try {
    const url = new URL(value, window.location.href)
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Read-only Loro projection for generic entity pages.  This intentionally performs no binding,
 * editor creation, dispatch, or sync: the caller has already converged authority.
 */
export const renderStaticLoroPreview = (doc: LoroDoc): StaticLoroPreview => {
  try {
    const page = inspectLoroPage(doc)
    const node = createNodeFromLoroObj(richTextSchemaAdapter.schema, page.pmRoot as LoroNode, new Map())
    if (node.textContent.trim().length === 0) return { kind: "empty" }
    const wrapper = document.createElement("div")
    wrapper.append(DOMSerializer.fromSchema(richTextSchemaAdapter.schema).serializeFragment(node.content))
    for (const link of wrapper.querySelectorAll("a[href]")) {
      const safe = permittedHref(link.getAttribute("href") ?? "")
      if (safe === undefined) link.removeAttribute("href")
      else link.setAttribute("href", safe)
    }
    return { kind: "content", html: wrapper.innerHTML }
  } catch {
    return { kind: "unsupported" }
  }
}

import { useLayoutEffect } from "react"
import { useLocation } from "react-router"
import { applyVisualVariant } from "./visual-variant.js"

/** Keeps the prototype opt-in in sync with client-side navigation, without owning navigation. */
export function VisualVariantSynchronizer() {
  const { search } = useLocation()

  useLayoutEffect(() => {
    applyVisualVariant(search)
  }, [search])

  return null
}

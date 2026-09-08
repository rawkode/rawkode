export type VisualVariant = "paper" | "study"

/**
 * Returns an explicitly requested visual prototype. This is deliberately stricter than a
 * convenience flag: an ambiguous URL must leave the product's normal appearance intact.
 */
export const parseVisualVariant = (search: string): VisualVariant | undefined => {
  const variants = new URLSearchParams(search).getAll("variant")
  if (variants.length !== 1) return undefined

  const [variant] = variants
  return variant === "paper" || variant === "study" ? variant : undefined
}

/** Applies only the opt-in visual-prototype attribute; persisted theme state is not ours. */
export const applyVisualVariant = (
  search: string,
  root: Pick<HTMLElement, "dataset"> = document.documentElement
): void => {
  const variant = parseVisualVariant(search)
  if (variant === undefined) delete root.dataset.visualVariant
  else root.dataset.visualVariant = variant
}

/** Kept separate from the entry module so the pre-render bootstrap has a direct, testable seam. */
export const bootstrapVisualVariant = (
  search: string = window.location.search,
  root: Pick<HTMLElement, "dataset"> = document.documentElement
): void => {
  applyVisualVariant(search, root)
}

import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react"

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

export type DrawerMode = "overlay" | "docked"

export function Drawer({
  open,
  mode,
  id,
  label,
  closeLabel,
  dismissible = true,
  restoreFocusRef,
  restoreFocusOnClose = true,
  onClose,
  className,
  children
}: {
  readonly open: boolean
  readonly mode: DrawerMode
  readonly id: string
  readonly label: string
  readonly closeLabel?: string
  readonly dismissible?: boolean
  readonly restoreFocusRef?: RefObject<HTMLElement | null>
  readonly restoreFocusOnClose?: boolean
  readonly onClose: () => void
  readonly className?: string
  readonly children: ReactNode
}) {
  const panelRef = useRef<HTMLElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const wasOpenRef = useRef(open)
  const previousModeRef = useRef(mode)
  const focusFrameRef = useRef<number | null>(null)

  const cancelFocusFrame = () => {
    if (focusFrameRef.current !== null) {
      window.cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }

  const focusPanel = () => {
    cancelFocusFrame()
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null
      const panel = panelRef.current
      if (panel === null) return
      const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ;(firstFocusable ?? panel).focus()
    })
  }

  const restoreFocus = () => {
    cancelFocusFrame()
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null
      restoreFocusRef?.current?.focus()
    })
  }

  const requestClose = () => {
    onClose()
  }

  useEffect(() => {
    const dialog = dialogRef.current
    const modeChanged = previousModeRef.current !== mode
    let openedDialog = false

    if (mode === "overlay" && dialog !== null) {
      if (open && !dialog.open) {
        dialog.showModal()
        openedDialog = true
      } else if (!open && dialog.open) {
        dialog.close()
      }
    }

    if (open && (openedDialog || !wasOpenRef.current)) {
      focusPanel()
    } else if (open && modeChanged) {
      focusPanel()
    } else if (!open && wasOpenRef.current && restoreFocusOnClose) {
      restoreFocus()
    }

    previousModeRef.current = mode
    wasOpenRef.current = open

    return () => {
      cancelFocusFrame()
      if (dialog?.open) dialog.close()
    }
  }, [mode, open, restoreFocusOnClose])

  useEffect(() => {
    const panel = panelRef.current
    if (panel !== null) panel.inert = !open
  }, [mode, open])

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && mode === "docked" && open && dismissible) {
      event.preventDefault()
      requestClose()
    }
  }

  const sharedProps = {
    id,
    className: `${className ?? ""}${open ? " drawer-open" : ""}`.trim(),
    "aria-label": label,
    tabIndex: -1,
    onKeyDown: handleKeyDown
  }

  if (mode === "overlay") {
    return (
      <dialog
        ref={(element) => {
          dialogRef.current = element
          panelRef.current = element
        }}
        {...sharedProps}
        onCancel={(event) => {
          event.preventDefault()
          if (dismissible) requestClose()
        }}
      >
        {closeLabel && (
          <button type="button" className="ds-button drawer-close" onClick={requestClose} aria-label={closeLabel}>
            <span aria-hidden="true">×</span>
          </button>
        )}
        {children}
      </dialog>
    )
  }

  return (
    <aside ref={panelRef} {...sharedProps} aria-hidden={!open} role="complementary">
      {closeLabel && (
        <button type="button" className="ds-button drawer-close" onClick={requestClose} aria-label={closeLabel}>
          <span aria-hidden="true">×</span>
        </button>
      )}
      {children}
    </aside>
  )
}

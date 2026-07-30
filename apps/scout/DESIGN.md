# Scout Design System

## Direction

Scout uses the approved **Spatial Columns** composition. A compact granted-location sidebar leads into persistent Miller columns. The stable trailing inspector is the destination of that spatial flow. A centered command palette accelerates navigation and file actions without replacing the browser. Native neutral surfaces establish the hierarchy; the selected theme is reserved for selection, focus, and primary actions.

## Physical Scene

A developer moves between bright daytime work and late-night focus while keeping several project hierarchies open. Scout follows the system appearance so the interface remains legible without forcing a light or dark environment.

## Color

The browsing strategy is restrained, with each theme supplying a paired light and dark palette. The selected pair follows the macOS appearance automatically, while System keeps native macOS colors and accent behavior.

- Included themes: System, Rose Pine, Catppuccin, Nord, Dracula, GitHub, Solarized, One Dark, Tokyo Night, Gruvbox, and Monokai.
- Theme selection is persisted in Settings and changes the active window without discarding the current browsing session.
- Light and dark variants are explicit theme data, not a forced app-wide `NSAppearance`.
- Accent use: current selection, keyboard focus, and primary action only.
- Canvas: the theme's base surface, with elevated panels and chrome kept to nearby tonal steps instead of a full-window gradient or wash.
- Chrome and side panels: one tonal step away from the canvas, separated with hairlines instead of floating cards.
- Error, warning, success, and information states use semantic system colors and always include a symbol or label.

## Typography

- SF Pro through SwiftUI and AppKit semantic text styles for all interface copy.
- SF Mono only for paths, shortcut hints, and technical metadata.
- Native compact control sizes and row metrics. No custom display typography.

## Layout

- Default window: 1280 by 780 points. Minimum: 900 by 560 points.
- Sidebar: 190 to 260 points.
- Browser columns: 220 to 320 points with horizontal overflow.
- Inspector: 280 to 360 points, collapsed first below 1100 points.
- Spacing follows a 4-point base scale with 8 to 12 points inside controls and 16 to 24 points between distinct groups.

## Components

- Sidebar rows are flat source-list rows with one symbol and one title.
- Browser rows use native selection and focus behavior with the selected theme accent.
- The command palette is a functional overlay using a tonal material, one hairline boundary, and a short defined shadow no wider than 8 points.
- File operation feedback appears in a compact activity strip with a specific result and an Undo action only when the inverse operation is available.
- Empty, permission, disconnected-volume, and stale-bookmark states explain the condition and provide one direct recovery action.

## Motion

Motion communicates state in 150 to 250 milliseconds. Reduced Motion replaces movement with an immediate state change or short crossfade. Scout has no launch choreography or decorative animation.

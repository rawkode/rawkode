# Enchiridion design

## Context

A daily writing tool used in ordinary desktop and mobile environments. Follow the
system's light/dark appearance and text sizing rather than imposing a theme.

## Typography and layout

Use SF system typography. A restrained date heading introduces a readable,
writing surface that fills the window with a small edge inset. The editor uses
all available width and height until sidebars are introduced. Avoid divider bars around the writing area.

## Controls

One compact command affordance, with Cmd+K on Mac. The command palette is a
transient search-first overlay with keyboard highlighting, action labels, and
shortcut hints. Formatting is a compact floating surface anchored to selection,
not a permanently reserved row. Errors remain explicit and actionable.

## Color and materials

Preserve the scaffold's system-adaptive semantic palette: primary text,
secondary text, native tint for active state, and system material for transient
controls. No new brand colors. Controls remain legible in both appearances.

## Motion and accessibility

Short opacity transitions only, disabled for reduced motion. Name every icon
button, support keyboard commands and Escape, and retain native text editing.

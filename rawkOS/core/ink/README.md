# Ink Visualizers for RawkOS

This directory contains Ink-based visualizers for the RawkOS module execution system. Ink is a React-based library for building interactive CLI applications.

## Components

### Simple Visualizer (`simple-visualizer.tsx`)
- Basic output visualizer that shows module execution progress
- Displays planned effects before execution
- Shows real-time status updates for each module
- Provides a summary at completion

### Interactive TUI Visualizer (`interactive-tui-visualizer.tsx`)
- Full-featured terminal UI with keyboard navigation
- Split-pane view: module list on left, output on right
- Keyboard shortcuts:
  - `j`/`k` or arrow keys: Navigate modules
  - `i`: Jump to module requiring input
  - `q`: Quit
- Scrolling support for large module lists
- Real-time output display for selected module

## Benefits of Ink

1. **React-based**: Leverages React's component model and state management
2. **Declarative UI**: Easier to reason about and maintain than imperative TUI code
3. **Built-in features**: Automatic layout, text wrapping, colors, and more
4. **Testing**: Can be tested with React testing tools
5. **Ecosystem**: Access to React hooks and patterns

## Usage

In the CLI, use the `--ink` flag to enable Ink visualizers:

```bash
# Simple visualizer
./cli.ts plan --ink
./cli.ts apply --ink

# Interactive TUI
./cli.ts apply --ink --tui
```

## Future Enhancements

- Add more interactive features (filtering, searching)
- Implement progress bars for long-running operations
- Add module dependency visualization
- Support for custom themes
- Export execution logs in various formats
import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
	bg: "oklch(1 0 0)",
	chrome: "oklch(0.965 0.006 50)",
	surface: "oklch(0.985 0.002 50)",
	surfaceRaised: "oklch(1 0 0)",
	ink: "oklch(0.18 0.018 55)",
	muted: "oklch(0.46 0.018 55)",
	subtle: "oklch(0.69 0.014 55)",
	border: "oklch(0.88 0.012 55)",
	primary: "oklch(0.40 0.103 50)",
	primaryHover: "oklch(0.34 0.112 50)",
	primarySoft: "oklch(0.93 0.038 50)",
	accent: "oklch(0.36 0.094 215)",
	success: "oklch(0.48 0.11 150)",
	warning: "oklch(0.62 0.14 75)",
	danger: "oklch(0.52 0.17 28)",
	backdrop: "oklch(0.18 0.018 55 / 0.22)",
});

export const fonts = stylex.defineVars({
	sans: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
	mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
});

export const sizes = stylex.defineVars({
	textXs: "11px",
	textSm: "12px",
	textMd: "13px",
	textBase: "14px",
	textLg: "16px",
	textXl: "24px",
	controlSm: "28px",
	controlMd: "34px",
	controlLg: "38px",
	sidebar: "260px",
	sidebarCompact: "230px",
	rail: "360px",
	editorMax: "780px",
});

export const space = stylex.defineVars({
	px: "1px",
	one: "2px",
	two: "4px",
	three: "6px",
	four: "8px",
	five: "10px",
	six: "12px",
	seven: "14px",
	eight: "16px",
	nine: "18px",
	ten: "22px",
	eleven: "24px",
	twelve: "28px",
	thirteen: "30px",
});

export const radii = stylex.defineVars({
	control: "8px",
	panel: "10px",
	modal: "12px",
	pill: "999px",
	tag: "6px",
});

export const shadows = stylex.defineVars({
	focus: "0 0 0 3px oklch(0.84 0.08 50 / 0.55)",
	popover: "0 8px 24px oklch(0.18 0.018 55 / 0.14)",
});

export const motion = stylex.defineVars({
	fast: "160ms ease",
	spin: "0.8s linear infinite",
});

export const zIndex = stylex.defineVars({
	modalBackdrop: "50",
});

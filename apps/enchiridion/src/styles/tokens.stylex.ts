import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
	bg: "var(--color-bg)",
	chrome: "var(--color-chrome)",
	surface: "var(--color-surface)",
	surfaceRaised: "var(--color-surface-raised)",
	ink: "var(--color-ink)",
	muted: "var(--color-muted)",
	subtle: "var(--color-subtle)",
	border: "var(--color-border)",
	borderStrong: "var(--color-border-strong)",
	primary: "var(--color-primary)",
	primaryHover: "var(--color-primary-hover)",
	primarySoft: "var(--color-primary-soft)",
	accent: "var(--color-accent)",
	info: "var(--color-info)",
	infoSoft: "var(--color-info-soft)",
	infoBorder: "var(--color-info-border)",
	success: "var(--color-success)",
	successSoft: "var(--color-success-soft)",
	successBorder: "var(--color-success-border)",
	warning: "var(--color-warning)",
	warningSoft: "var(--color-warning-soft)",
	warningBorder: "var(--color-warning-border)",
	warningText: "var(--color-warning-text)",
	danger: "var(--color-danger)",
	dangerSoft: "var(--color-danger-soft)",
	dangerBorder: "var(--color-danger-border)",
	backdrop: "var(--color-backdrop)",
});

export const fonts = stylex.defineVars({
	sans: "\"Geist Sans\", Geist, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
	mono: "\"Geist Mono\", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
	control: "6px",
	panel: "8px",
	modal: "12px",
	pill: "999px",
	tag: "6px",
});

export const shadows = stylex.defineVars({
	focus: "0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-focus)",
	popover: "var(--shadow-popover)",
});

export const motion = stylex.defineVars({
	fast: "150ms",
	popover: "200ms",
	overlay: "300ms",
	ease: "cubic-bezier(0.175, 0.885, 0.32, 1.1)",
	spin: "0.8s linear infinite",
});

export const zIndex = stylex.defineVars({
	modalBackdrop: "50",
});

import type { Bookmark, KanbanBoard, KanbanCard, KanbanColumn, Project } from "./types";

export function renderBookmarksPage(bookmarks: Bookmark[]): Response {
	const items = bookmarks.map((bookmark) => `
		<article class="item">
			<div>
				<h2><a href="${escapeHtml(bookmark.url)}">${escapeHtml(bookmark.title)}</a></h2>
				<p>${escapeHtml(bookmark.description || bookmark.url)}</p>
			</div>
			<div class="tags">${bookmark.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
		</article>
	`).join("");

	return htmlPage("Bookmarks", `
		<header>
			<a href="/">Enchiridion</a>
			<h1>Bookmarks</h1>
			<p>Independent mini-app route backed by host primitives and searchable resource projections.</p>
		</header>
		<main>${items || "<p>No bookmarks yet.</p>"}</main>
	`);
}

export function renderProjectsPage(projects: Project[], boards: Array<KanbanBoard & { columns: Array<KanbanColumn & { cards: KanbanCard[] }> }>): Response {
	const projectList = projects.map((project) => `
		<li>
			<strong>${escapeHtml(project.name)}</strong>
			<span>${escapeHtml(project.description)}</span>
		</li>
	`).join("");

	const boardList = boards.map((board) => `
		<section class="board">
			<h2>${escapeHtml(board.name)}</h2>
			<div class="columns">
				${board.columns.map((column) => `
					<div class="column">
						<h3>${escapeHtml(column.name)}</h3>
						${column.cards.map((card) => renderCard(card)).join("")}
					</div>
				`).join("")}
			</div>
		</section>
	`).join("");

	return htmlPage("Projects", `
		<header>
			<a href="/">Enchiridion</a>
			<h1>Projects</h1>
			<p>Projects and Kanban boards exposed as an independent mini-app route.</p>
		</header>
		<main>
			<ul class="projects">${projectList}</ul>
			${boardList}
		</main>
	`);
}

export function renderBookmarkFragment(bookmarks: Bookmark[], tag?: string): Response {
	const body = `
		<section class="extension-fragment">
			<header>
				<strong>Bookmark query</strong>
				<span>${tag ? `tag:${escapeHtml(tag)}` : "latest"}</span>
			</header>
			${bookmarks.map((bookmark) => `
				<a class="fragment-row" href="${escapeHtml(bookmark.url)}">
					<span>${escapeHtml(bookmark.title)}</span>
					<small>${escapeHtml(bookmark.url)}</small>
				</a>
			`).join("") || "<p>No matching bookmarks.</p>"}
		</section>
	`;
	return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function renderProjectsFragment(boards: Array<KanbanBoard & { columns: Array<KanbanColumn & { cards: KanbanCard[] }> }>, boardId?: string): Response {
	const board = boardId ? boards.find((entry) => entry.id === boardId) : boards[0];
	const body = `
		<section class="extension-fragment">
			<header>
				<strong>${escapeHtml(board?.name ?? "Kanban board")}</strong>
				<span>${board?.columns.length ?? 0} columns</span>
			</header>
			<div class="fragment-kanban">
				${board?.columns.map((column) => `
					<div>
						<b>${escapeHtml(column.name)}</b>
						${column.cards.map((card) => `<span>${escapeHtml(card.title)}</span>`).join("")}
					</div>
				`).join("") ?? "<p>No board exists.</p>"}
			</div>
		</section>
	`;
	return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function renderCard(card: KanbanCard): string {
	return `
		<article class="card">
			<strong>${escapeHtml(card.title)}</strong>
			<p>${escapeHtml(card.description)}</p>
		</article>
	`;
}

function htmlPage(title: string, content: string): Response {
	return new Response(`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escapeHtml(title)} · Enchiridion</title>
	<style>
		:root {
			color-scheme: light;
			--bg: oklch(1 0 0);
			--chrome: oklch(0.965 0.006 50);
			--surface: oklch(0.985 0.002 50);
			--ink: oklch(0.18 0.018 55);
			--muted: oklch(0.46 0.018 55);
			--border: oklch(0.88 0.012 55);
			--primary: oklch(0.4 0.103 50);
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			background: var(--chrome);
			color: var(--ink);
			font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}
		header, main {
			max-width: 1100px;
			margin: 0 auto;
			padding: 24px;
		}
		header a {
			color: var(--primary);
			text-decoration: none;
			font-weight: 650;
		}
		h1 {
			margin: 18px 0 4px;
			font-size: 30px;
			letter-spacing: 0;
		}
		p { color: var(--muted); }
		.item, .board, .projects {
			background: var(--bg);
			border: 1px solid var(--border);
			border-radius: 10px;
			padding: 16px;
			margin-bottom: 12px;
		}
		.item {
			display: flex;
			gap: 16px;
			justify-content: space-between;
		}
		h2, h3 { margin: 0; }
		h2 a { color: var(--ink); }
		.tags {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			align-content: flex-start;
		}
		.tags span {
			border: 1px solid var(--border);
			border-radius: 999px;
			padding: 2px 8px;
			color: var(--muted);
		}
		.columns {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
			gap: 12px;
			margin-top: 14px;
		}
		.column {
			background: var(--surface);
			border: 1px solid var(--border);
			border-radius: 8px;
			padding: 12px;
			min-height: 140px;
		}
		.card {
			background: var(--bg);
			border: 1px solid var(--border);
			border-radius: 8px;
			padding: 10px;
			margin-top: 8px;
		}
		.projects {
			display: grid;
			gap: 8px;
			list-style: none;
		}
		.projects li {
			display: grid;
			gap: 2px;
		}
		.projects span {
			color: var(--muted);
		}
		@media (max-width: 700px) {
			.item { display: grid; }
			header, main { padding: 18px; }
		}
	</style>
</head>
<body>${content}</body>
</html>`, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case "\"":
				return "&quot;";
			default:
				return "&#039;";
		}
	});
}

import { Node } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as stylex from "@stylexjs/stylex";
import {
	BookOpen,
	Bot,
	CalendarClock,
	Check,
	ChevronLeft,
	ChevronRight,
	Command,
	ExternalLink,
	FileText,
	FolderKanban,
	LayoutGrid,
	Link,
	Send,
	Plus,
	Save,
	Search,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AppSnapshot,
	Bookmark,
	DailyNote,
	ExtensionCommand,
	ExtensionEditorBlock,
	ExtensionManifest,
	JsonObject,
	KanbanBoard,
	KanbanCard,
	KanbanColumn,
	ResourceIndexRecord,
} from "../lib/types";
import { inferMiniAppIntent, summarizeMiniApp, type MiniAppIntent } from "../lib/mini-app-requests";
import { shell } from "../styles/shell.stylex";

const ExtensionBlock = Node.create({
	name: "extensionBlock",
	group: "block",
	atom: true,
	addAttributes() {
		return {
			app: { default: "" },
			block: { default: "" },
			props: { default: {} },
			version: { default: "0.1.0" },
		};
	},
	parseHTML() {
		return [{ tag: "div[data-extension-block]" }];
	},
	renderHTML({ HTMLAttributes }) {
		const app = String(HTMLAttributes.app ?? "");
		const block = String(HTMLAttributes.block ?? "");
		return [
			"div",
			{
				"data-extension-block": "",
				"data-app": app,
				"data-block": block,
				class: "extension-node",
			},
			["span", {}, `${app}/${block}`],
		];
	},
});

function dateKey(date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/London",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

function addDays(date: string, delta: number): string {
	const next = new Date(`${date}T12:00:00.000Z`);
	next.setUTCDate(next.getUTCDate() + delta);
	return next.toISOString().slice(0, 10);
}

type AgentMessage = {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
};

export default function AppShell() {
	const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
	const [selectedDate, setSelectedDate] = useState(dateKey());
	const [note, setNote] = useState<DailyNote | null>(null);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [paletteQuery, setPaletteQuery] = useState("");
	const [resourceQuery, setResourceQuery] = useState("");
	const [resources, setResources] = useState<ResourceIndexRecord[]>([]);
	const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
	const [boards, setBoards] = useState<Array<KanbanBoard & { columns: Array<KanbanColumn & { cards: KanbanCard[] }> }>>([]);
	const skipNextUpdate = useRef(false);
	const saveTimer = useRef<number | null>(null);

	const editor = useEditor({
		extensions: [
			StarterKit,
			ExtensionBlock,
			Placeholder.configure({
				placeholder: "Write the day. Type naturally, then add structure when it earns its place.",
			}),
		],
		content: note?.documentJson ?? {
			type: "doc",
			content: [{ type: "paragraph" }],
		},
		editorProps: {
			attributes: {
				class: "editor-prose",
				"aria-label": "Daily note editor",
			},
		},
		onUpdate({ editor: currentEditor }) {
			if (skipNextUpdate.current) {
				skipNextUpdate.current = false;
				return;
			}
			const documentJson = currentEditor.getJSON() as JsonObject;
			queueSave(documentJson);
		},
	});

	const loadSnapshot = useCallback(async (date = selectedDate) => {
		const response = await fetch(`/api/bootstrap?date=${encodeURIComponent(date)}`);
		if (!response.ok) {
			throw new Error(`Failed to load Enchiridion: ${response.status}`);
		}
		const nextSnapshot = await response.json() as AppSnapshot;
		setSnapshot(nextSnapshot);
		setNote(nextSnapshot.dailyNote);
		setBookmarks(nextSnapshot.bookmarks);
		setBoards(nextSnapshot.boards);
		setResources(nextSnapshot.resourceIndex);
	}, [selectedDate]);

	useEffect(() => {
		loadSnapshot(selectedDate).catch((error) => {
			console.error(error);
			setSaveState("error");
		});
	}, [loadSnapshot, selectedDate]);

	useEffect(() => {
		if (!editor || !note) {
			return;
		}
		skipNextUpdate.current = true;
		editor.commands.setContent(note.documentJson);
		setSaveState("idle");
	}, [editor, note?.id]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setPaletteOpen((current) => !current);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	useEffect(() => {
		if (!resourceQuery.trim()) {
			setResources(snapshot?.resourceIndex ?? []);
			return;
		}
		const abort = new AbortController();
		fetch(`/api/search?q=${encodeURIComponent(resourceQuery)}`, { signal: abort.signal })
			.then((response) => response.json())
			.then((data) => setResources(data as ResourceIndexRecord[]))
			.catch((error) => {
				if (error.name !== "AbortError") {
					console.error(error);
				}
			});
		return () => abort.abort();
	}, [resourceQuery, snapshot?.resourceIndex]);

	const queueSave = useCallback((documentJson: JsonObject) => {
		if (!note) {
			return;
		}
		setSaveState("saving");
		if (saveTimer.current) {
			window.clearTimeout(saveTimer.current);
		}
		saveTimer.current = window.setTimeout(async () => {
			try {
				const response = await fetch(`/api/daily-notes/${note.date}`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ documentJson, version: note.version }),
				});
				if (response.status === 409) {
					setSaveState("conflict");
					return;
				}
				if (!response.ok) {
					throw new Error(`Save failed with ${response.status}`);
				}
				const saved = await response.json() as DailyNote;
				setNote(saved);
				setSaveState("saved");
			} catch (error) {
				console.error(error);
				setSaveState("error");
			}
		}, 700);
	}, [note]);

	const commands = useMemo(() => snapshot?.commands ?? [], [snapshot?.commands]);
	const filteredCommands = useMemo(() => {
		const query = paletteQuery.toLowerCase();
		return commands.filter((command) => {
			return command.label.toLowerCase().includes(query) || command.description.toLowerCase().includes(query);
		});
	}, [commands, paletteQuery]);

	const runCommand = useCallback(async (command: ExtensionCommand) => {
		if (command.kind === "navigate") {
			window.location.href = command.action;
			return;
		}
		if (command.kind === "insert-block") {
			const block = snapshot?.editorBlocks.find((entry) => entry.app === command.app && entry.id === command.action);
			if (block) {
				insertExtensionBlock(block);
			}
			setPaletteOpen(false);
			return;
		}
		if (command.action === "bookmarks.create") {
			await createBookmarkFromPrompt();
		}
		if (command.action === "projects.create") {
			await createProjectFromPrompt();
		}
		if (command.action === "cards.create") {
			await createCardFromPrompt();
		}
		setPaletteOpen(false);
	}, [snapshot?.editorBlocks, editor]);

	const insertExtensionBlock = useCallback((block: ExtensionEditorBlock) => {
		if (!editor) {
			return;
		}
		editor.chain().focus().insertContent({
			type: "extensionBlock",
			attrs: {
				app: block.app,
				block: block.id,
				props: block.defaultProps,
				version: "0.1.0",
			},
		}).run();
	}, [editor]);

	const createBookmarkFromPrompt = useCallback(async () => {
		const url = window.prompt("Bookmark URL");
		if (!url) {
			return;
		}
		const title = window.prompt("Bookmark title", url) ?? url;
		await postBookmark({ title, url, description: "", tags: [] });
	}, []);

	const createProjectFromPrompt = useCallback(async () => {
		const name = window.prompt("Project name");
		if (!name) {
			return;
		}
		await postProject({ name, description: "" });
	}, []);

	const createCardFromPrompt = useCallback(async () => {
		const title = window.prompt("Card title");
		if (!title) {
			return;
		}
		await postCard({ title, description: "" });
	}, []);

	async function postBookmark(payload: { title: string; url: string; description: string; tags: string[] }) {
		const response = await fetch("/api/apps/bookmarks/bookmarks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (response.ok) {
			setBookmarks(await fetchJson<Bookmark[]>("/api/apps/bookmarks/bookmarks"));
			setResources(await fetchJson<ResourceIndexRecord[]>("/api/search"));
		}
	}

	async function postProject(payload: { name: string; description: string }) {
		const response = await fetch("/api/apps/projects/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (response.ok) {
			await refreshProjects();
		}
	}

	async function postCard(payload: { title: string; description: string }) {
		const response = await fetch("/api/apps/projects/cards", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (response.ok) {
			await refreshProjects();
		}
	}

	async function refreshProjects() {
		const [nextBoards, nextResources] = await Promise.all([
			fetchJson<Array<KanbanBoard & { columns: Array<KanbanColumn & { cards: KanbanCard[] }> }>>("/api/apps/projects/boards"),
			fetchJson<ResourceIndexRecord[]>("/api/search"),
		]);
		setBoards(nextBoards);
		setResources(nextResources);
	}

	if (!snapshot || !note) {
		return (
			<div {...stylex.props(shell.loadingShell)}>
				<div {...stylex.props(shell.loadingMark)} />
				<span>Loading Enchiridion</span>
			</div>
		);
	}

	return (
		<div {...stylex.props(shell.appShell)}>
			<aside {...stylex.props(shell.sidebar)}>
				<div {...stylex.props(shell.brand)}>
					<div {...stylex.props(shell.brandMark)}>E</div>
					<div>
						<strong {...stylex.props(shell.blockText)}>Enchiridion</strong>
						<span {...stylex.props(shell.mutedText, shell.blockText)}>{snapshot.principal.email}</span>
					</div>
				</div>

				<button {...stylex.props(shell.controlBase, shell.interactiveHover, shell.commandButton)} type="button" onClick={() => setPaletteOpen(true)}>
					<Command size={16} />
					<span>Command palette</span>
					<kbd {...stylex.props(shell.keycap)}>⌘K</kbd>
				</button>

				<nav {...stylex.props(shell.stack)} aria-label="Daily notes">
					{snapshot.recentNotes.map((entry) => (
						<button
							key={entry.id}
							type="button"
							{...stylex.props(
								shell.controlBase,
								shell.interactiveHover,
								shell.navItem,
								entry.date === selectedDate ? shell.navItemActive : null,
							)}
							onClick={() => setSelectedDate(entry.date)}
						>
							<FileText size={15} />
							<span>{entry.date}</span>
						</button>
					))}
				</nav>

				<div {...stylex.props(shell.sidebarSection)}>
					<h2 {...stylex.props(shell.sectionHeading)}>Mini apps</h2>
					{snapshot.extensions.map((extension) => (
						<a {...stylex.props(shell.controlBase, shell.interactiveHover, shell.miniAppLink)} key={extension.slug} href={`/apps/${extension.slug}`}>
							<LayoutGrid size={15} />
							<span>{extension.name}</span>
							<ExternalLink size={13} />
						</a>
					))}
				</div>
			</aside>

			<main {...stylex.props(shell.workspace)}>
				<header {...stylex.props(shell.workspaceHeader)}>
					<div>
						<div {...stylex.props(shell.dateControls)}>
							<button
								{...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)}
								type="button"
								onClick={() => setSelectedDate(addDays(selectedDate, -1))}
								aria-label="Previous day"
							>
								<ChevronLeft size={16} />
							</button>
							<strong>{selectedDate}</strong>
							<button
								{...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)}
								type="button"
								onClick={() => setSelectedDate(addDays(selectedDate, 1))}
								aria-label="Next day"
							>
								<ChevronRight size={16} />
							</button>
						</div>
						<h1 {...stylex.props(shell.pageTitle)}>{note.title}</h1>
					</div>
					<SaveState state={saveState} />
				</header>

				<div {...stylex.props(shell.editorToolbar)} aria-label="Editor actions">
					{snapshot.editorBlocks.map((block) => (
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
							key={`${block.app}-${block.id}`}
							type="button"
							onClick={() => insertExtensionBlock(block)}
						>
							{block.app === "bookmarks" ? <Link size={15} /> : <FolderKanban size={15} />}
							<span>{block.label}</span>
						</button>
					))}
				</div>

				<section {...stylex.props(shell.editorPanel)}>
					<EditorContent editor={editor} />
				</section>
			</main>

			<aside {...stylex.props(shell.contextRail)}>
				<section {...stylex.props(shell.panel)}>
					<div {...stylex.props(shell.panelHeading)}>
						<Search size={16} />
						<h2 {...stylex.props(shell.sectionHeading)}>Resource graph</h2>
					</div>
					<input
						{...stylex.props(shell.field)}
						value={resourceQuery}
						onChange={(event) => setResourceQuery(event.target.value)}
						placeholder="Search notes, apps, tasks"
					/>
					<div {...stylex.props(shell.stack)}>
						{resources.map((resource) => (
							<a key={resource.id} href={resource.url ?? "#"} {...stylex.props(shell.resourceRow)}>
								<strong>{resource.title}</strong>
								<span {...stylex.props(shell.rowMeta)}>{resource.sourceApp}/{resource.sourceType}</span>
							</a>
						))}
					</div>
				</section>

				<section {...stylex.props(shell.panel)}>
					<div {...stylex.props(shell.panelHeading)}>
						<BookOpen size={16} />
						<h2 {...stylex.props(shell.sectionHeading)}>Bookmarks</h2>
					</div>
					<BookmarkForm onCreate={postBookmark} />
					<div {...stylex.props(shell.stack)}>
						{bookmarks.slice(0, 4).map((bookmark) => (
							<a key={bookmark.id} href={bookmark.url} {...stylex.props(shell.resourceRow)}>
								<strong>{bookmark.title}</strong>
								<span {...stylex.props(shell.rowMeta)}>{bookmark.tags.join(", ") || bookmark.url}</span>
							</a>
						))}
					</div>
				</section>

				<section {...stylex.props(shell.panel)}>
					<div {...stylex.props(shell.panelHeading)}>
						<FolderKanban size={16} />
						<h2 {...stylex.props(shell.sectionHeading)}>Projects</h2>
					</div>
					<ProjectForm onCreate={postProject} />
					<KanbanPreview boards={boards} onCreateCard={postCard} />
				</section>

				<section {...stylex.props(shell.panel)}>
					<div {...stylex.props(shell.panelHeading)}>
						<CalendarClock size={16} />
						<h2 {...stylex.props(shell.sectionHeading)}>Scheduled work</h2>
					</div>
					<div {...stylex.props(shell.stack)}>
						{snapshot.scheduledWorkflows.map((workflow) => (
							<div key={workflow.id} {...stylex.props(shell.resourceRow)}>
								<strong>{workflow.name}</strong>
								<span {...stylex.props(shell.rowMeta)}>{workflow.enabled ? "Enabled" : "Disabled"} · {workflow.cron}</span>
							</div>
						))}
					</div>
				</section>

				<section {...stylex.props(shell.panel)}>
					<div {...stylex.props(shell.panelHeading)}>
						<Bot size={16} />
						<h2 {...stylex.props(shell.sectionHeading)}>Agent</h2>
					</div>
					<AgentPanel extensions={snapshot.extensions} onRefresh={() => loadSnapshot(selectedDate)} />
				</section>
			</aside>

			{paletteOpen && (
				<CommandPalette
					commands={filteredCommands}
					query={paletteQuery}
					onQuery={setPaletteQuery}
					onClose={() => setPaletteOpen(false)}
					onRun={runCommand}
				/>
			)}
		</div>
	);
}

function SaveState({ state }: { state: "idle" | "saving" | "saved" | "conflict" | "error" }) {
	const label = {
		idle: "Ready",
		saving: "Saving",
		saved: "Saved",
		conflict: "Conflict",
		error: "Error",
	}[state];
	const stateStyle = {
		idle: null,
		saving: shell.saveSaving,
		saved: shell.saveSaved,
		conflict: shell.saveError,
		error: shell.saveError,
	}[state];

	return (
		<div {...stylex.props(shell.saveState, stateStyle)}>
			{state === "saved" ? <Check size={15} /> : <Save size={15} />}
			<span>{label}</span>
		</div>
	);
}

function CommandPalette({
	commands,
	query,
	onQuery,
	onClose,
	onRun,
}: {
	commands: ExtensionCommand[];
	query: string;
	onQuery: (value: string) => void;
	onClose: () => void;
	onRun: (command: ExtensionCommand) => void;
}) {
	return (
		<div {...stylex.props(shell.paletteBackdrop)} role="presentation" onMouseDown={onClose}>
			<div {...stylex.props(shell.palette)} role="dialog" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
				<div {...stylex.props(shell.paletteInput)}>
					<Command size={18} />
					<input
						{...stylex.props(shell.field, shell.paletteField)}
						autoFocus
						value={query}
						onChange={(event) => onQuery(event.target.value)}
						placeholder="Run a command"
					/>
				</div>
				<div {...stylex.props(shell.paletteList)}>
					{commands.map((command) => (
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.paletteButton)}
							key={`${command.app}-${command.id}`}
							type="button"
							onClick={() => onRun(command)}
						>
							<Sparkles size={16} />
							<span {...stylex.props(shell.paletteLabel)}>
								<strong>{command.label}</strong>
								<small {...stylex.props(shell.paletteMeta)}>{command.description}</small>
							</span>
							<em {...stylex.props(shell.paletteMeta)}>{command.app}</em>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function AgentPanel({ extensions, onRefresh }: { extensions: ExtensionManifest[]; onRefresh: () => Promise<void> }) {
	const [messages, setMessages] = useState<AgentMessage[]>([]);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState<"chat" | "build" | null>(null);

	const appendMessage = useCallback((message: Omit<AgentMessage, "id">) => {
		setMessages((current) => [
			...current,
			{ ...message, id: `${Date.now()}-${Math.random().toString(16).slice(2)}` },
		]);
	}, []);

	const submit = useCallback(async (mode: "chat" | "build") => {
		const message = prompt.trim();
		if (!message || busy) {
			return;
		}

		setPrompt("");
		setBusy(mode);
		appendMessage({ role: "user", text: message });

		try {
			const intent = inferMiniAppIntent(message, extensions, mode === "build");
			if (intent.shouldBuild) {
				const response = await fetch("/api/flue/workflows/generate-mini-app?wait=result", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						prompt: message,
						operation: intent.operation,
						targetSlug: intent.targetSlug,
						slugHint: intent.slugHint,
						autonomousDeploy: true,
					}),
				});
				const body = await readJsonBody<{ result?: Record<string, unknown>; error?: unknown }>(response);
				if (!response.ok) {
					throw new Error(formatAgentError(body.error, `Workflow failed with ${response.status}`));
				}

				const result = body.result ?? {};
				appendMessage({
					role: "assistant",
					text: formatMiniAppResult(result, intent),
				});
				await onRefresh();
				return;
			}

			const response = await fetch("/api/flue/agents/second-brain-agent/default?wait=result", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: buildAgentMessage(message, extensions) }),
			});
			const body = await readJsonBody<{ result?: unknown; error?: unknown }>(response);
			if (!response.ok) {
				throw new Error(formatAgentError(body.error, `Agent failed with ${response.status}`));
			}

			appendMessage({
				role: "assistant",
				text: formatAgentResult(body.result),
			});
		} catch (error) {
			appendMessage({
				role: "system",
				text: error instanceof Error ? error.message : "Agent request failed.",
			});
		} finally {
			setBusy(null);
		}
	}, [appendMessage, busy, extensions, onRefresh, prompt]);

	return (
		<form {...stylex.props(shell.agentPanel)} onSubmit={(event) => {
			event.preventDefault();
			void submit("chat");
		}}>
			<div {...stylex.props(shell.agentTranscript)} aria-live="polite">
				{messages.length === 0 ? (
					<div {...stylex.props(shell.agentEmpty)}>
						<Sparkles size={16} />
						<span>Ready</span>
					</div>
				) : messages.map((message) => (
					<div
						key={message.id}
						{...stylex.props(
							shell.agentMessage,
							message.role === "user" ? shell.agentUserMessage : null,
							message.role === "system" ? shell.agentSystemMessage : null,
						)}
					>
						{message.text}
					</div>
				))}
			</div>
			<textarea
				{...stylex.props(shell.field, shell.agentTextArea)}
				value={prompt}
				onChange={(event) => setPrompt(event.target.value)}
				placeholder="Ask Enchiridion"
				rows={3}
			/>
			<div {...stylex.props(shell.agentActions)}>
				<button
					{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
					type="button"
					disabled={busy !== null}
					onClick={() => void submit("build")}
				>
					<Sparkles size={15} />
					<span>{busy === "build" ? "Building" : "Build app"}</span>
				</button>
				<button
					{...stylex.props(shell.controlBase, shell.primaryTextButton)}
					type="submit"
					disabled={busy !== null}
				>
					<Send size={15} />
					<span>{busy === "chat" ? "Sending" : "Send"}</span>
				</button>
			</div>
		</form>
	);
}

async function readJsonBody<T>(response: Response): Promise<T> {
	const text = await response.text();
	if (!text) {
		return {} as T;
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		return { error: text } as T;
	}
}

function buildAgentMessage(message: string, extensions: ExtensionManifest[]): string {
	return [
		message,
		"Current Enchiridion mini apps:",
		JSON.stringify(extensions.map((extension) => summarizeMiniApp(extension)), null, 2),
	].join("\n\n");
}

function formatMiniAppResult(result: Record<string, unknown>, intent: MiniAppIntent): string {
	const status = String(result.status ?? "completed");
	const operation = String(result.operation ?? intent.operation);
	const slug = String(result.slug ?? intent.targetSlug ?? "mini-app");
	const message = typeof result.message === "string" ? result.message : "";
	const routeUrl = typeof result.routeUrl === "string" ? result.routeUrl : "";
	const issues = Array.isArray(result.issues) ? result.issues.map(String) : [];

	if (issues.length > 0) {
		return `${status}: ${slug}. ${issues.join(" ")}`.trim();
	}

	if (status === "validation_failed") {
		return `${status}: ${slug}. ${message || "The Worker uploaded, but the primary route did not render. The previous active app was left unchanged."}`.trim();
	}

	if (result.deployed === true) {
		const routeHref = routeUrl.startsWith("/") && typeof window !== "undefined"
			? `${window.location.origin}${routeUrl}`
			: routeUrl;
		const route = routeHref ? ` ${routeHref}` : "";
		return `${status}: ${slug} ${operation === "update" ? "updated" : "deployed"}.${route}`.trim();
	}

	return `${status}: ${slug}. ${message}`.trim();
}

function formatAgentResult(result: unknown): string {
	if (!result) {
		return "Done.";
	}
	if (typeof result === "string") {
		return result;
	}
	if (typeof result === "object") {
		const text = readStringProperty(result, "text") ?? readStringProperty(result, "message");
		if (text) {
			return text;
		}
		try {
			return JSON.stringify(result);
		} catch {
			return "Done.";
		}
	}

	return String(result);
}

function formatAgentError(error: unknown, fallback: string): string {
	if (!error) {
		return fallback;
	}
	if (typeof error === "string") {
		return error;
	}
	if (error instanceof Error) {
		return error.message || fallback;
	}
	if (typeof error === "object") {
		const message = readStringProperty(error, "message") ?? readStringProperty(error, "error");
		if (message) {
			return message;
		}

		try {
			return JSON.stringify(error);
		} catch {
			return fallback;
		}
	}

	return String(error);
}

function readStringProperty(source: object, key: string): string | undefined {
	if (!(key in source)) {
		return undefined;
	}
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function BookmarkForm({ onCreate }: { onCreate: (payload: { title: string; url: string; description: string; tags: string[] }) => Promise<void> }) {
	const [url, setUrl] = useState("");
	const [title, setTitle] = useState("");

	return (
		<form {...stylex.props(shell.inlineForm)} onSubmit={async (event) => {
			event.preventDefault();
			if (!url.trim()) {
				return;
			}
			await onCreate({ title: title.trim() || url.trim(), url: url.trim(), description: "", tags: ["captured"] });
			setUrl("");
			setTitle("");
		}}>
			<input {...stylex.props(shell.field)} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." />
			<input {...stylex.props(shell.field)} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
			<button {...stylex.props(shell.controlBase, shell.primaryIconButton)} type="submit" aria-label="Create bookmark"><Plus size={15} /></button>
		</form>
	);
}

function ProjectForm({ onCreate }: { onCreate: (payload: { name: string; description: string }) => Promise<void> }) {
	const [name, setName] = useState("");

	return (
		<form {...stylex.props(shell.inlineForm, shell.inlineFormSingle)} onSubmit={async (event) => {
			event.preventDefault();
			if (!name.trim()) {
				return;
			}
			await onCreate({ name: name.trim(), description: "" });
			setName("");
		}}>
			<input {...stylex.props(shell.field)} value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" />
			<button {...stylex.props(shell.controlBase, shell.primaryIconButton)} type="submit" aria-label="Create project"><Plus size={15} /></button>
		</form>
	);
}

function KanbanPreview({
	boards,
	onCreateCard,
}: {
	boards: Array<KanbanBoard & { columns: Array<KanbanColumn & { cards: KanbanCard[] }> }>;
	onCreateCard: (payload: { title: string; description: string }) => Promise<void>;
}) {
	const board = boards[0];
	const [title, setTitle] = useState("");

	if (!board) {
		return <p {...stylex.props(shell.mutedText)}>Create a project to start a board.</p>;
	}

	return (
		<div {...stylex.props(shell.kanbanPreview)}>
			<form {...stylex.props(shell.inlineForm, shell.inlineFormSingle)} onSubmit={async (event) => {
				event.preventDefault();
				if (!title.trim()) {
					return;
				}
				await onCreateCard({ title: title.trim(), description: "" });
				setTitle("");
			}}>
				<input {...stylex.props(shell.field)} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Card title" />
				<button {...stylex.props(shell.controlBase, shell.primaryIconButton)} type="submit" aria-label="Create Kanban card"><Plus size={15} /></button>
			</form>
			<div {...stylex.props(shell.kanbanColumns)}>
				{board.columns.map((column) => (
					<div key={column.id} {...stylex.props(shell.kanbanColumn)}>
						<strong {...stylex.props(shell.kanbanColumnTitle)}>{column.name}</strong>
						{column.cards.slice(0, 3).map((card) => (
							<span key={card.id} {...stylex.props(shell.kanbanCard)}>{card.title}</span>
						))}
					</div>
				))}
			</div>
		</div>
	);
}

async function fetchJson<T>(path: string): Promise<T> {
	const response = await fetch(path);
	if (!response.ok) {
		throw new Error(`${path} failed with ${response.status}`);
	}
	return response.json() as Promise<T>;
}

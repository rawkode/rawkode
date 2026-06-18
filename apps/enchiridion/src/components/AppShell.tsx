import { Extension, Node } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type ReactNodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as stylex from "@stylexjs/stylex";
import {
	Bot,
	CheckCircle2,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Clock,
	Command,
	Code2,
	Database,
	Info,
	ExternalLink,
	FileText,
	FolderKanban,
	Heading1,
	Heading2,
	LayoutGrid,
	Link,
	List,
	ListOrdered,
	MessageSquareReply,
	Pin,
	RefreshCw,
	Save,
	ScrollText,
	Sparkles,
	TextQuote,
	TriangleAlert,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { closeAppPanelTab, openAppPanelTab, type AppPanelTab, type AppPanelMode } from "../lib/app-panel-tabs";
import { auditDetailSummary, auditToneForStatus } from "../lib/audit";
import { formatBootstrapLoadError } from "../lib/bootstrap-error";
import { routeActionForCommand } from "../lib/command-routing";
import { titleForDailyNote } from "../lib/dates";
import { mergeExtensionBlockProps, readExtensionBlockString } from "../lib/extension-block-props";
import { formatAgentBuildMeta, generateMiniAppWorkflowName, retryModeForAgentBlock } from "../lib/agent-retry";
import type {
	AppSnapshot,
	Bookmark,
	DailyNote,
	ExtensionCommand,
	ExtensionEditorBlock,
	ExtensionBindingRequest,
	ExtensionManifest,
	JsonObject,
	KanbanCard,
	MiniAppAuditRecord,
	Project,
	ScheduledWorkflow,
} from "../lib/types";
import { formatAgentError, formatAgentResult, formatMiniAppBuildError, formatMiniAppResult } from "../lib/agent-format";
import { buildFollowUpPrompt } from "../lib/agent-follow-up";
import {
	findReferencedExtension,
	inferMiniAppIntent,
	summarizeMiniApp,
	type MiniAppIntent,
	type MiniAppOperation,
} from "../lib/mini-app-requests";
import { textToTiptapBlocks } from "../lib/text";
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
	addNodeView() {
		return ReactNodeViewRenderer(ExtensionBlockView);
	},
});

const admonitionKinds = ["info", "warning", "error", "success", "alert"] as const;
type AdmonitionKind = typeof admonitionKinds[number];

const admonitionLabels: Record<AdmonitionKind, string> = {
	alert: "Alert",
	error: "Error",
	info: "Info",
	success: "Success",
	warning: "Warning",
};

const Admonition = Node.create({
	name: "admonition",
	group: "block",
	content: "block+",
	defining: true,
	addAttributes() {
		return {
			kind: {
				default: "info",
				parseHTML: (element) => readAdmonitionKind(element.getAttribute("data-admonition")),
				renderHTML: (attributes) => ({ "data-admonition": readAdmonitionKind(attributes.kind) }),
			},
			title: {
				default: null,
				parseHTML: (element) => element.getAttribute("data-admonition-title"),
				renderHTML: (attributes) => {
					const title = typeof attributes.title === "string" && attributes.title.trim()
						? attributes.title.trim()
						: admonitionLabels[readAdmonitionKind(attributes.kind)];
					return { "data-admonition-title": title };
				},
			},
		};
	},
	parseHTML() {
		return [{ tag: "section[data-admonition]" }];
	},
	renderHTML({ node }) {
		const kind = readAdmonitionKind(node.attrs.kind);
		const title = typeof node.attrs.title === "string" && node.attrs.title.trim()
			? node.attrs.title.trim()
			: admonitionLabels[kind];
		return [
			"section",
			{
				"data-admonition": kind,
				"data-admonition-title": title,
			},
			["div", { "data-admonition-heading": "" }, title],
			["div", { "data-admonition-body": "" }, 0],
		];
	},
});

type ExtensionBlockProps = JsonObject & {
	bookmarkTitle?: string;
	buildDeadlineAt?: string;
	buildId?: string;
	cardTitle?: string;
	contextPrompt?: string;
	contextResponse?: string;
	description?: string;
	draftPrompt?: string;
	id?: string;
	name?: string;
	operation?: string;
	prompt?: string;
	route?: string;
	runId?: string;
	runOffset?: string;
	slugHint?: string;
	streamUrl?: string;
	status?: string;
	summary?: string;
	tagsInput?: string;
	targetSlug?: string;
	title?: string;
	url?: string;
	workflowName?: string;
};

type UpdateExtensionBlockProps = (patch: ExtensionBlockProps) => void;

type OpenAppPanelEvent = CustomEvent<{
	mode: AppPanelMode;
	route: string;
	title: string;
}>;

type AgentRequestSubmitEvent = CustomEvent<{
	blockId: string;
	contextPrompt?: string;
	contextResponse?: string;
	mode: AgentRequestMode;
	prompt: string;
	targetSlug?: string;
}>;

type AgentRequestCancelEvent = CustomEvent<{
	blockId: string;
}>;

type BookmarkCreateSubmitEvent = CustomEvent<{
	blockId: string;
	description: string;
	tags: string[];
	title: string;
	url: string;
}>;

type BookmarkCreateCancelEvent = CustomEvent<{
	blockId: string;
}>;

type ProjectCreateSubmitEvent = CustomEvent<{
	blockId: string;
	description: string;
	name: string;
}>;

type ProjectCreateCancelEvent = CustomEvent<{
	blockId: string;
}>;

type KanbanCardCreateSubmitEvent = CustomEvent<{
	blockId: string;
	description: string;
	title: string;
}>;

type KanbanCardCreateCancelEvent = CustomEvent<{
	blockId: string;
}>;

type SlashRange = {
	from: number;
	to: number;
};

type SlashMenuState = SlashRange & {
	query: string;
	top: number;
	left: number;
};

type SlashCommandKeyEvent = CustomEvent<{
	key: "ArrowDown" | "ArrowUp" | "Enter" | "Escape";
	handled: boolean;
}>;

type SlashCommandItem = {
	id: string;
	label: string;
	description: string;
	app: string;
	icon: "agent" | "block" | "bullet-list" | "code" | "error" | "heading-1" | "heading-2" | "info" | "kanban" | "ordered-list" | "quote" | "success" | "warning";
	keywords?: string[];
	run: (range: SlashRange) => void | Promise<void>;
};

type AgentRequestMode = "ask" | "build" | "update";
type RichTextCommand = "bullet-list" | "code" | "heading-1" | "heading-2" | "ordered-list" | "quote";

type PendingNoteSave = {
	date: string;
	documentJson: JsonObject;
	noteId: string;
	version: number;
};

type MiniAppBuildAdmission = {
	autonomousDeploy: boolean;
	currentRunId: string | null;
	deadlineAt: string;
	error: JsonObject | null;
	id: string;
	maxAttempts: number;
	operation: "create" | "update";
	prompt: string;
	result: JsonObject | null;
	status: MiniAppBuildStatus;
	targetSlug: string | null;
	slugHint: string | null;
};

type MiniAppBuildStatus = "pending" | "running" | "interrupted" | "completed" | "failed" | "expired";

type MiniAppBuildRecord = MiniAppBuildAdmission & {
	attemptCount: number;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

type PendingMiniAppBuildRun = {
	buildId: string;
	blockId: string;
	intent: MiniAppIntent;
	prompt: string;
	runId?: string;
};

type AgentTargetOption = {
	name: string;
	slug: string;
};

const slashCommandKey = new PluginKey("enchiridionSlashCommand");
const slashStateEvent = "enchiridion:slash-state";
const slashKeyEvent = "enchiridion:slash-key";
const agentRequestSubmitEvent = "enchiridion:agent-request-submit";
const agentRequestCancelEvent = "enchiridion:agent-request-cancel";
const bookmarkCreateSubmitEvent = "enchiridion:bookmark-create-submit";
const bookmarkCreateCancelEvent = "enchiridion:bookmark-create-cancel";
const projectCreateSubmitEvent = "enchiridion:project-create-submit";
const projectCreateCancelEvent = "enchiridion:project-create-cancel";
const kanbanCardCreateSubmitEvent = "enchiridion:kanban-card-create-submit";
const kanbanCardCreateCancelEvent = "enchiridion:kanban-card-create-cancel";

const SlashCommandExtension = Extension.create({
	name: "slashCommand",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: slashCommandKey,
				props: {
					handleKeyDown(view, event) {
						const slashState = readSlashMenuState(view);
						if (!slashState || !isSlashMenuKey(event.key)) {
							return false;
						}
						const detail: SlashCommandKeyEvent["detail"] = {
							key: event.key,
							handled: false,
						};
						window.dispatchEvent(new CustomEvent(slashKeyEvent, { detail }));
						if (detail.handled) {
							event.preventDefault();
						}
						return detail.handled;
					},
				},
				view(view) {
					emitSlashMenuState(view);
					return {
						update(nextView) {
							emitSlashMenuState(nextView);
						},
					};
				},
			}),
		];
	},
});

function ExtensionBlockView({ editor, getPos, node, updateAttributes }: ReactNodeViewProps) {
	const app = String(node.attrs.app ?? "");
	const block = String(node.attrs.block ?? "");
	const props = asExtensionBlockProps(node.attrs.props);
	const title = props.title || (app === "agent" ? "Agent response" : humanizeSlug(app));
	const rawSummary = props.summary || props.prompt || `${app}/${block}`;
	const route = typeof props.route === "string" && props.route.trim() ? props.route : app !== "agent" ? `/apps/${app}` : "";
	const routeTitle = route ? titleForExtensionRoute(app, title) : title;
	const status = typeof props.status === "string" ? props.status : "";
	const isWorking = status === "running";
	const isError = status === "error";
	const isUntrackedMiniAppBuild = app === "agent"
		&& block === "request"
		&& isWorking
		&& !props.buildId;
	const summary = isUntrackedMiniAppBuild
		? "This build started before durable build tracking existed. Start it again to track a 30 minute build."
		: isError ? formatMiniAppBuildError(rawSummary, rawSummary) : rawSummary;
	const retryMode = retryModeForAgentBlock({
		...props,
		app,
		block,
		isUntrackedMiniAppBuild,
		title,
	});
	const canRetry = retryMode !== null;
	const canPromote = app === "agent" && block === "response" && summary.trim().length > 0;
	const canFollowUp = canPromote;
	const buildMeta = formatAgentBuildMeta({ ...props, app, block }, formatBuildDeadline);
	const updateProps: UpdateExtensionBlockProps = (patch) => {
		updateAttributes({
			props: mergeExtensionBlockProps(props, patch),
		});
	};

	if (app === "agent" && block === "request-input") {
		return <AgentRequestInputBlock props={props} updateProps={updateProps} />;
	}
	if (app === "bookmarks" && block === "create-bookmark") {
		return <BookmarkCreateBlock props={props} updateProps={updateProps} />;
	}
	if (app === "projects" && block === "create-project") {
		return <ProjectCreateBlock props={props} updateProps={updateProps} />;
	}
	if (app === "projects" && block === "create-card") {
		return <KanbanCardCreateBlock props={props} updateProps={updateProps} />;
	}

	const open = (mode: AppPanelMode) => {
		if (!route) {
			return;
		}
		openAppInShell({ mode, route, title: routeTitle });
	};

	return (
		<NodeViewWrapper
			{...stylex.props(shell.extensionBlock, isError ? shell.extensionBlockError : null)}
			contentEditable={false}
			data-extension-block=""
			data-app={app}
			data-block={block}
		>
			<div {...stylex.props(shell.extensionBlockBody)}>
				<div {...stylex.props(shell.extensionBlockHeader)}>
					<span {...stylex.props(shell.extensionBlockKind)}>{app}/{block}</span>
					{status ? <span {...stylex.props(shell.extensionBlockStatus)}>{isUntrackedMiniAppBuild ? "Untracked" : isWorking ? "Working" : status}</span> : null}
				</div>
				<strong {...stylex.props(shell.extensionBlockTitle)}>{title}</strong>
				{props.prompt ? <span {...stylex.props(shell.extensionBlockPrompt)}>{props.prompt}</span> : null}
				<span {...stylex.props(shell.extensionBlockSummary)}>{summary}</span>
				{buildMeta ? <span {...stylex.props(shell.paletteMeta)}>{buildMeta}</span> : null}
			</div>
			{route || canPromote || canFollowUp || canRetry ? (
				<div {...stylex.props(shell.extensionBlockActions)}>
					{canRetry ? (
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
							type="button"
							onClick={() => insertRetryRequestAfterBlock(editor, getPos, node.nodeSize, props, retryMode, summary)}
						>
							<RefreshCw size={14} />
							<span>{retryMode === "update" ? "Retry update" : "Retry build"}</span>
						</button>
					) : null}
					{canFollowUp ? (
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
							type="button"
							onClick={() => insertFollowUpRequestAfterBlock(editor, getPos, node.nodeSize, props.prompt, summary)}
						>
							<MessageSquareReply size={14} />
							<span>Follow up</span>
						</button>
					) : null}
					{canPromote ? (
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
							type="button"
							onClick={() => promoteBlockToDocumentBody(editor, getPos, node.nodeSize, summary)}
						>
							<FileText size={14} />
							<span>Promote to body</span>
						</button>
					) : null}
					{route ? (
						<>
							<button {...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)} type="button" onClick={() => open("panel")}>
								<LayoutGrid size={14} />
								<span>Open side panel</span>
							</button>
							<button {...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)} type="button" onClick={() => open("tab")}>
								<ExternalLink size={14} />
								<span>Open workspace tab</span>
							</button>
						</>
					) : null}
				</div>
			) : null}
		</NodeViewWrapper>
	);
}

function BookmarkCreateBlock({ props, updateProps }: { props: ExtensionBlockProps; updateProps: UpdateExtensionBlockProps }) {
	const blockId = typeof props.id === "string" && props.id ? props.id : createClientId();
	const url = readExtensionBlockString(props, "url");
	const title = readExtensionBlockString(props, "bookmarkTitle");
	const description = readExtensionBlockString(props, "description");
	const tagsInput = readExtensionBlockString(props, "tagsInput");
	const [submitted, setSubmitted] = useState(false);
	const urlRef = useRef<HTMLInputElement | null>(null);
	const cleanUrl = url.trim();
	const cleanTitle = title.trim() || cleanUrl;
	const canSubmit = cleanUrl.length > 0 && !submitted;

	useEffect(() => {
		const handle = window.setTimeout(() => {
			urlRef.current?.focus();
		}, 0);
		return () => window.clearTimeout(handle);
	}, []);

	return (
		<NodeViewWrapper
			{...stylex.props(shell.extensionBlock, shell.extensionBlockDraft)}
			contentEditable={false}
			data-extension-block=""
			data-app="bookmarks"
			data-block="create-bookmark"
		>
			<form
				{...stylex.props(shell.agentRequestForm)}
				onSubmit={(event) => {
					event.preventDefault();
					if (!canSubmit) {
						return;
					}
					setSubmitted(true);
					window.dispatchEvent(new CustomEvent(bookmarkCreateSubmitEvent, {
						detail: {
							blockId,
							description: description.trim(),
							tags: splitTags(tagsInput),
							title: cleanTitle,
							url: cleanUrl,
						},
					}));
				}}
			>
				<div {...stylex.props(shell.extensionBlockHeader)}>
					<span {...stylex.props(shell.extensionBlockKind)}>bookmarks/create</span>
					<span {...stylex.props(shell.extensionBlockStatus)}>draft</span>
				</div>
				<strong {...stylex.props(shell.extensionBlockTitle)}>{props.title || "Create bookmark"}</strong>
				<label {...stylex.props(shell.agentRequestField)}>
					<span {...stylex.props(shell.paletteMeta)}>URL</span>
					<input
						ref={urlRef}
						{...stylex.props(shell.field)}
						type="url"
						value={url}
						onChange={(event) => updateProps({ url: event.target.value })}
						disabled={submitted}
						placeholder="https://..."
					/>
				</label>
				<label {...stylex.props(shell.agentRequestField)}>
					<span {...stylex.props(shell.paletteMeta)}>Title</span>
					<input
						{...stylex.props(shell.field)}
						value={title}
						onChange={(event) => updateProps({ bookmarkTitle: event.target.value })}
						disabled={submitted}
						placeholder="Defaults to the URL"
					/>
				</label>
				<label {...stylex.props(shell.agentRequestField)}>
					<span {...stylex.props(shell.paletteMeta)}>Tags</span>
					<input
						{...stylex.props(shell.field)}
						value={tagsInput}
						onChange={(event) => updateProps({ tagsInput: event.target.value })}
						disabled={submitted}
						placeholder="cloudflare, agents"
					/>
				</label>
				<label {...stylex.props(shell.agentRequestField)}>
					<span {...stylex.props(shell.paletteMeta)}>Notes</span>
					<textarea
						{...stylex.props(shell.field, shell.agentRequestPrompt)}
						value={description}
						onChange={(event) => updateProps({ description: event.target.value })}
						disabled={submitted}
						placeholder="Why this matters..."
					/>
				</label>
				<div {...stylex.props(shell.agentRequestActions)}>
					<span {...stylex.props(shell.emptyHint)}>{props.summary || "Creates the bookmark and leaves a reference here."}</span>
					<div {...stylex.props(shell.agentRequestButtons)}>
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
							type="button"
							disabled={submitted}
							onClick={() => {
								window.dispatchEvent(new CustomEvent(bookmarkCreateCancelEvent, {
									detail: { blockId },
								}));
							}}
						>
							<X size={14} />
							<span>Cancel</span>
						</button>
						<button
							{...stylex.props(shell.controlBase, shell.primaryTextButton)}
							type="submit"
							disabled={!canSubmit}
						>
							<Link size={14} />
							<span>{submitted ? "Saving" : "Save bookmark"}</span>
						</button>
					</div>
				</div>
			</form>
		</NodeViewWrapper>
	);
}

function ProjectCreateBlock({ props, updateProps }: { props: ExtensionBlockProps; updateProps: UpdateExtensionBlockProps }) {
	const blockId = typeof props.id === "string" && props.id ? props.id : createClientId();
	const name = readExtensionBlockString(props, "name");
	const description = readExtensionBlockString(props, "description");
	const [submitted, setSubmitted] = useState(false);
	const nameRef = useRef<HTMLInputElement | null>(null);
	const cleanName = name.trim();
	const canSubmit = cleanName.length > 0 && !submitted;

	useEffect(() => {
		const handle = window.setTimeout(() => {
			nameRef.current?.focus();
		}, 0);
		return () => window.clearTimeout(handle);
	}, []);

	return (
		<NodeViewWrapper
			{...stylex.props(shell.extensionBlock, shell.extensionBlockDraft)}
			contentEditable={false}
			data-extension-block=""
			data-app="projects"
			data-block="create-project"
		>
			<form
				{...stylex.props(shell.agentRequestForm)}
				onSubmit={(event) => {
					event.preventDefault();
					if (!canSubmit) {
						return;
					}
					setSubmitted(true);
					window.dispatchEvent(new CustomEvent(projectCreateSubmitEvent, {
						detail: {
							blockId,
							description: description.trim(),
							name: cleanName,
						},
					}));
				}}
			>
				<div {...stylex.props(shell.extensionBlockHeader)}>
					<span {...stylex.props(shell.extensionBlockKind)}>projects/create</span>
					<span {...stylex.props(shell.extensionBlockStatus)}>draft</span>
				</div>
				<strong {...stylex.props(shell.extensionBlockTitle)}>{props.title || "Create project"}</strong>
				<label {...stylex.props(shell.agentRequestField)}>
					<span {...stylex.props(shell.paletteMeta)}>Project name</span>
					<input
						ref={nameRef}
						{...stylex.props(shell.field)}
						value={name}
						onChange={(event) => updateProps({ name: event.target.value })}
						disabled={submitted}
						placeholder="Project name"
					/>
				</label>
				<label {...stylex.props(shell.agentRequestField)}>
					<span {...stylex.props(shell.paletteMeta)}>Notes</span>
					<textarea
						{...stylex.props(shell.field, shell.agentRequestPrompt)}
						value={description}
						onChange={(event) => updateProps({ description: event.target.value })}
						disabled={submitted}
						placeholder="Scope, outcome, or why it matters..."
					/>
				</label>
				<div {...stylex.props(shell.agentRequestActions)}>
					<span {...stylex.props(shell.emptyHint)}>{props.summary || "Creates the project and leaves a reference here."}</span>
					<div {...stylex.props(shell.agentRequestButtons)}>
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
							type="button"
							disabled={submitted}
							onClick={() => {
								window.dispatchEvent(new CustomEvent(projectCreateCancelEvent, {
									detail: { blockId },
								}));
							}}
						>
							<X size={14} />
							<span>Cancel</span>
						</button>
						<button
							{...stylex.props(shell.controlBase, shell.primaryTextButton)}
							type="submit"
							disabled={!canSubmit}
						>
							<FolderKanban size={14} />
							<span>{submitted ? "Saving" : "Save project"}</span>
						</button>
					</div>
				</div>
			</form>
		</NodeViewWrapper>
	);
}

function KanbanCardCreateBlock({ props, updateProps }: { props: ExtensionBlockProps; updateProps: UpdateExtensionBlockProps }) {
	const blockId = typeof props.id === "string" && props.id ? props.id : createClientId();
	const title = readExtensionBlockString(props, "cardTitle");
	const description = readExtensionBlockString(props, "description");
	const [submitted, setSubmitted] = useState(false);
	const titleRef = useRef<HTMLInputElement | null>(null);
	const cleanTitle = title.trim();
	const canSubmit = cleanTitle.length > 0 && !submitted;

	useEffect(() => {
		const handle = window.setTimeout(() => {
			titleRef.current?.focus();
		}, 0);
		return () => window.clearTimeout(handle);
	}, []);

	return (
		<NodeViewWrapper
			{...stylex.props(shell.extensionBlock, shell.extensionBlockDraft)}
			contentEditable={false}
			data-extension-block=""
			data-app="projects"
			data-block="create-card"
		>
			<form
				{...stylex.props(shell.agentRequestForm)}
				onSubmit={(event) => {
					event.preventDefault();
					if (!canSubmit) {
						return;
					}
					setSubmitted(true);
					window.dispatchEvent(new CustomEvent(kanbanCardCreateSubmitEvent, {
						detail: {
							blockId,
							description: description.trim(),
							title: cleanTitle,
						},
					}));
				}}
			>
				<div {...stylex.props(shell.extensionBlockHeader)}>
					<span {...stylex.props(shell.extensionBlockKind)}>projects/card</span>
					<span {...stylex.props(shell.extensionBlockStatus)}>draft</span>
				</div>
				<strong {...stylex.props(shell.extensionBlockTitle)}>{props.title || "Create Kanban card"}</strong>
				<label {...stylex.props(shell.agentRequestField)}>
					<span {...stylex.props(shell.paletteMeta)}>Card title</span>
					<input
						ref={titleRef}
						{...stylex.props(shell.field)}
						value={title}
						onChange={(event) => updateProps({ cardTitle: event.target.value })}
						disabled={submitted}
						placeholder="Card title"
					/>
				</label>
				<label {...stylex.props(shell.agentRequestField)}>
					<span {...stylex.props(shell.paletteMeta)}>Notes</span>
					<textarea
						{...stylex.props(shell.field, shell.agentRequestPrompt)}
						value={description}
						onChange={(event) => updateProps({ description: event.target.value })}
						disabled={submitted}
						placeholder="Acceptance notes, links, or constraints..."
					/>
				</label>
				<div {...stylex.props(shell.agentRequestActions)}>
					<span {...stylex.props(shell.emptyHint)}>{props.summary || "Creates the card and leaves a reference here."}</span>
					<div {...stylex.props(shell.agentRequestButtons)}>
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
							type="button"
							disabled={submitted}
							onClick={() => {
								window.dispatchEvent(new CustomEvent(kanbanCardCreateCancelEvent, {
									detail: { blockId },
								}));
							}}
						>
							<X size={14} />
							<span>Cancel</span>
						</button>
						<button
							{...stylex.props(shell.controlBase, shell.primaryTextButton)}
							type="submit"
							disabled={!canSubmit}
						>
							<LayoutGrid size={14} />
							<span>{submitted ? "Saving" : "Save card"}</span>
						</button>
					</div>
				</div>
			</form>
		</NodeViewWrapper>
	);
}

function AgentRequestInputBlock({ props, updateProps }: { props: ExtensionBlockProps; updateProps: UpdateExtensionBlockProps }) {
	const mode = isAgentRequestMode(props.mode) ? props.mode : "ask";
	const targetOptions = readAgentTargetOptions(props.targetOptions);
	const contextPrompt = typeof props.contextPrompt === "string" ? props.contextPrompt : "";
	const contextResponse = typeof props.contextResponse === "string" ? props.contextResponse : "";
	const hasContext = contextPrompt.trim().length > 0 || contextResponse.trim().length > 0;
	const prompt = readExtensionBlockString(props, "draftPrompt");
	const targetSlug = readExtensionBlockString(props, "targetSlug") || (mode === "update" && targetOptions.length === 1 ? targetOptions[0]?.slug ?? "" : "");
	const [submitted, setSubmitted] = useState(false);
	const promptRef = useRef<HTMLTextAreaElement | null>(null);
	const blockId = typeof props.id === "string" && props.id ? props.id : createClientId();
	const needsTarget = mode === "update";
	const canSubmit = prompt.trim().length > 0 && (!needsTarget || targetSlug.trim().length > 0) && !submitted;
	const actionLabel = typeof props.actionLabel === "string" ? props.actionLabel : mode === "build" ? "Build app" : mode === "update" ? "Update app" : "Ask agent";
	const placeholder = typeof props.placeholder === "string"
		? props.placeholder
		: mode === "build"
			? "Describe the mini app to build..."
			: mode === "update"
				? "Describe what should change..."
				: "Ask for a summary, draft, plan, or action...";

	useEffect(() => {
		const handle = window.setTimeout(() => {
			promptRef.current?.focus();
		}, 0);
		return () => window.clearTimeout(handle);
	}, []);

	return (
		<NodeViewWrapper
			{...stylex.props(shell.extensionBlock, shell.extensionBlockDraft)}
			contentEditable={false}
			data-extension-block=""
			data-app="agent"
			data-block="request-input"
		>
			<form
				{...stylex.props(shell.agentRequestForm)}
				onSubmit={(event) => {
					event.preventDefault();
					if (!canSubmit) {
						return;
					}
					setSubmitted(true);
					window.dispatchEvent(new CustomEvent(agentRequestSubmitEvent, {
						detail: {
							blockId,
							contextPrompt: contextPrompt || undefined,
							contextResponse: contextResponse || undefined,
							mode,
							prompt: prompt.trim(),
							targetSlug: targetSlug.trim() || undefined,
						},
					}));
				}}
			>
				<div {...stylex.props(shell.extensionBlockHeader)}>
					<span {...stylex.props(shell.extensionBlockKind)}>agent/{mode}</span>
					<span {...stylex.props(shell.extensionBlockStatus)}>draft</span>
				</div>
				<strong {...stylex.props(shell.extensionBlockTitle)}>{props.title || actionLabel}</strong>
				{hasContext ? (
					<div {...stylex.props(shell.agentContext)}>
						<span {...stylex.props(shell.paletteMeta)}>Continuing from</span>
						{contextPrompt ? <strong {...stylex.props(shell.agentContextPrompt)}>{contextPrompt}</strong> : null}
						{contextResponse ? <span {...stylex.props(shell.extensionBlockSummary)}>{contextResponse}</span> : null}
					</div>
				) : null}
				{needsTarget ? (
					<label {...stylex.props(shell.agentRequestField)}>
						<span {...stylex.props(shell.paletteMeta)}>Mini app</span>
						{targetOptions.length > 0 ? (
							<select
								{...stylex.props(shell.field)}
								value={targetSlug}
								onChange={(event) => updateProps({ targetSlug: event.target.value })}
								disabled={submitted}
							>
								<option value="">Choose a mini app</option>
								{targetOptions.map((option) => (
									<option key={option.slug} value={option.slug}>{option.name}</option>
								))}
							</select>
						) : (
							<input
								{...stylex.props(shell.field)}
								value={targetSlug}
								onChange={(event) => updateProps({ targetSlug: event.target.value })}
								disabled={submitted}
								placeholder="mini-app-slug"
							/>
						)}
					</label>
				) : null}
				<label {...stylex.props(shell.agentRequestField)}>
					<span {...stylex.props(shell.paletteMeta)}>Request</span>
					<textarea
						ref={promptRef}
						{...stylex.props(shell.field, shell.agentRequestPrompt)}
						value={prompt}
						onChange={(event) => updateProps({ draftPrompt: event.target.value })}
						disabled={submitted}
						placeholder={placeholder}
					/>
				</label>
				<div {...stylex.props(shell.agentRequestActions)}>
					<span {...stylex.props(shell.emptyHint)}>{props.summary || "The response will replace this block."}</span>
					<div {...stylex.props(shell.agentRequestButtons)}>
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
							type="button"
							disabled={submitted}
							onClick={() => {
								window.dispatchEvent(new CustomEvent(agentRequestCancelEvent, {
									detail: { blockId },
								}));
							}}
						>
							<X size={14} />
							<span>Cancel</span>
						</button>
						<button
							{...stylex.props(shell.controlBase, shell.primaryTextButton)}
							type="submit"
							disabled={!canSubmit}
						>
							<Bot size={14} />
							<span>{submitted ? "Sending" : actionLabel}</span>
						</button>
					</div>
				</div>
			</form>
		</NodeViewWrapper>
	);
}

function dateKey(date = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/London",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

function addMonths(month: string, delta: number): string {
	const [year, monthIndex] = month.split("-").map(Number);
	const next = new Date(Date.UTC(year, monthIndex - 1 + delta, 1, 12));
	return next.toISOString().slice(0, 7);
}

function addDays(date: string, delta: number): string {
	const next = dateFromKey(date);
	next.setUTCDate(next.getUTCDate() + delta);
	return next.toISOString().slice(0, 10);
}

function dateFromKey(date: string): Date {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day, 12));
}

function buildMonthCalendarDays(month: string): Array<{ date: string; inMonth: boolean; label: number }> {
	const [year, monthIndex] = month.split("-").map(Number);
	const first = new Date(Date.UTC(year, monthIndex - 1, 1, 12));
	const firstWeekday = (first.getUTCDay() + 6) % 7;
	const start = new Date(first);
	start.setUTCDate(first.getUTCDate() - firstWeekday);

	return Array.from({ length: 42 }, (_, index) => {
		const day = new Date(start);
		day.setUTCDate(start.getUTCDate() + index);
		return {
			date: day.toISOString().slice(0, 10),
			inMonth: day.getUTCMonth() === monthIndex - 1,
			label: day.getUTCDate(),
		};
	});
}

function buildWeekCalendarDays(date: string): Array<{ date: string; inMonth: boolean; label: number }> {
	const selected = dateFromKey(date);
	const weekStartOffset = (selected.getUTCDay() + 6) % 7;
	const start = new Date(selected);
	start.setUTCDate(selected.getUTCDate() - weekStartOffset);

	return Array.from({ length: 7 }, (_, index) => {
		const day = new Date(start);
		day.setUTCDate(start.getUTCDate() + index);
		return {
			date: day.toISOString().slice(0, 10),
			inMonth: day.getUTCMonth() === selected.getUTCMonth(),
			label: day.getUTCDate(),
		};
	});
}

function formatCalendarMonth(month: string): string {
	const [year, monthIndex] = month.split("-").map(Number);
	return new Intl.DateTimeFormat("en-GB", {
		month: "short",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(Date.UTC(year, monthIndex - 1, 1, 12)));
}

function formatCalendarWeek(date: string): string {
	const start = dateFromKey(date);
	const end = new Date(start);
	const weekStartOffset = (start.getUTCDay() + 6) % 7;
	start.setUTCDate(start.getUTCDate() - weekStartOffset);
	end.setTime(start.getTime());
	end.setUTCDate(start.getUTCDate() + 6);

	if (start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()) {
		const month = new Intl.DateTimeFormat("en-GB", {
			month: "short",
			timeZone: "UTC",
		}).format(start);
		return `${start.getUTCDate()}-${end.getUTCDate()} ${month}`;
	}

	const formatter = new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	});
	return `${formatter.format(start)}-${formatter.format(end)}`;
}

export default function AppShell() {
	const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
	const [selectedDate, setSelectedDate] = useState(dateKey());
	const [calendarMonth, setCalendarMonth] = useState(() => dateKey().slice(0, 7));
	const [calendarExpanded, setCalendarExpanded] = useState(false);
	const [note, setNote] = useState<DailyNote | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [paletteQuery, setPaletteQuery] = useState("");
	const [paletteSelectedIndex, setPaletteSelectedIndex] = useState(0);
	const [pinChooserOpen, setPinChooserOpen] = useState(false);
	const [scheduleManagerOpen, setScheduleManagerOpen] = useState(false);
	const [scheduleUpdatingIds, setScheduleUpdatingIds] = useState<string[]>([]);
	const [scheduleErrors, setScheduleErrors] = useState<Record<string, string>>({});
	const [auditLogOpen, setAuditLogOpen] = useState(false);
	const [auditLogRecords, setAuditLogRecords] = useState<MiniAppAuditRecord[]>([]);
	const [auditLogLoading, setAuditLogLoading] = useState(false);
	const [auditLogError, setAuditLogError] = useState<string | null>(null);
	const [bindingRequestsOpen, setBindingRequestsOpen] = useState(false);
	const [bindingRequests, setBindingRequests] = useState<ExtensionBindingRequest[]>([]);
	const [bindingRequestsLoading, setBindingRequestsLoading] = useState(false);
	const [bindingRequestsError, setBindingRequestsError] = useState<string | null>(null);
	const [pinnedAppSlugs, setPinnedAppSlugs] = useState<string[]>(() => readPinnedApps());
	const [workspaceTabs, setWorkspaceTabs] = useState<AppPanelTab[]>([]);
	const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState<string | null>(null);
	const [panelTabs, setPanelTabs] = useState<AppPanelTab[]>([]);
	const [activePanelTabId, setActivePanelTabId] = useState<string | null>(null);
	const [slashState, setSlashState] = useState<SlashMenuState | null>(null);
	const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
	const skipNextUpdate = useRef(false);
	const saveTimer = useRef<number | null>(null);
	const latestNoteRef = useRef<DailyNote | null>(null);
	const pendingSaveRef = useRef<PendingNoteSave | null>(null);
	const saveInFlightRef = useRef(false);
	const activeMiniAppRunPollers = useRef(new Set<string>());
	const unmountedRef = useRef(false);
	const slashStateRef = useRef<SlashMenuState | null>(null);
	const slashSelectedIndexRef = useRef(0);
	const slashItemsRef = useRef<SlashCommandItem[]>([]);

	const editor = useEditor({
		extensions: [
			StarterKit,
			Admonition,
			ExtensionBlock,
			SlashCommandExtension,
			Placeholder.configure({
				placeholder: "Write the day. Type / for commands.",
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
		setLoadError(null);
		const response = await fetch(`/api/bootstrap?date=${encodeURIComponent(date)}`);
		if (!response.ok) {
			throw new Error(`Failed to load Enchiridion: ${response.status}`);
		}
		const nextSnapshot = await response.json() as AppSnapshot;
		setSnapshot(nextSnapshot);
		setNote(nextSnapshot.dailyNote);
		setLoadError(null);
	}, [selectedDate]);

	useEffect(() => {
		loadSnapshot(selectedDate).catch((error) => {
			console.error(error);
			setLoadError(formatBootstrapLoadError(error));
			setSaveState("error");
		});
	}, [loadSnapshot, selectedDate]);

	useEffect(() => {
		setCalendarMonth(selectedDate.slice(0, 7));
	}, [selectedDate]);

	useEffect(() => {
		if (!editor || !note) {
			return;
		}
		skipNextUpdate.current = true;
		editor.commands.setContent(note.documentJson);
		setSaveState("idle");
	}, [editor, note?.id]);

	useEffect(() => {
		latestNoteRef.current = note;
	}, [note]);

	useEffect(() => {
		if (snapshot) {
			setAuditLogRecords(snapshot.miniAppAudit);
		}
	}, [snapshot]);

	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
			if (saveTimer.current) {
				window.clearTimeout(saveTimer.current);
			}
		};
	}, []);

	const closePalette = useCallback(() => {
		setPaletteOpen(false);
		setPaletteQuery("");
		setPaletteSelectedIndex(0);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				if (paletteOpen) {
					closePalette();
					return;
				}
				setPaletteOpen(true);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [closePalette, paletteOpen]);

	useEffect(() => {
		writePinnedApps(pinnedAppSlugs);
	}, [pinnedAppSlugs]);

	useEffect(() => {
		const onSlashState = (event: Event) => {
			const nextState = (event as CustomEvent<SlashMenuState | null>).detail;
			setSlashState((current) => {
				if (!nextState) {
					return null;
				}
				if (!current || current.from !== nextState.from || current.query !== nextState.query) {
					setSlashSelectedIndex(0);
				}
				return nextState;
			});
		};
		window.addEventListener(slashStateEvent, onSlashState);
		return () => window.removeEventListener(slashStateEvent, onSlashState);
	}, []);

	useEffect(() => {
		const openPanel = (event: Event) => {
			const detail = (event as OpenAppPanelEvent).detail;
			if (!detail?.route) {
				return;
			}
			if (detail.mode === "tab") {
				setWorkspaceTabs((current) => {
					const next = openAppPanelTab(current, detail);
					setActiveWorkspaceTabId(next.activeTabId);
					return next.tabs;
				});
				return;
			}
			setPanelTabs((current) => {
				const next = openAppPanelTab(current, detail);
				setActivePanelTabId(next.activeTabId);
				return next.tabs;
			});
		};
		window.addEventListener("enchiridion:open-app", openPanel);
		return () => window.removeEventListener("enchiridion:open-app", openPanel);
	}, []);

	useEffect(() => {
		slashStateRef.current = slashState;
	}, [slashState]);

	useEffect(() => {
		slashSelectedIndexRef.current = slashSelectedIndex;
	}, [slashSelectedIndex]);

	const flushQueuedSave = useCallback(async function flushQueuedSave() {
		if (saveInFlightRef.current) {
			return;
		}

		const pending = pendingSaveRef.current;
		if (!pending) {
			return;
		}

		pendingSaveRef.current = null;
		saveInFlightRef.current = true;
		setSaveState("saving");

		const currentNote = latestNoteRef.current;
		const version = currentNote?.id === pending.noteId ? currentNote.version : pending.version;

		try {
			const response = await fetch(`/api/daily-notes/${pending.date}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ documentJson: pending.documentJson, version }),
			});
			if (response.status === 409) {
				setSaveState("conflict");
				return;
			}
			if (!response.ok) {
				throw new Error(`Save failed with ${response.status}`);
			}
			const saved = await response.json() as DailyNote;
			if (latestNoteRef.current?.id === saved.id || latestNoteRef.current?.date === saved.date) {
				latestNoteRef.current = saved;
				setNote(saved);
			}
			setSaveState("saved");
		} catch (error) {
			console.error(error);
			setSaveState("error");
		} finally {
			saveInFlightRef.current = false;
			if (pendingSaveRef.current) {
				if (saveTimer.current) {
					window.clearTimeout(saveTimer.current);
				}
				saveTimer.current = window.setTimeout(() => {
					void flushQueuedSave();
				}, 0);
			}
		}
	}, []);

	const queueSave = useCallback((documentJson: JsonObject) => {
		const currentNote = latestNoteRef.current;
		if (!currentNote) {
			return;
		}

		pendingSaveRef.current = {
			date: currentNote.date,
			documentJson,
			noteId: currentNote.id,
			version: currentNote.version,
		};
		setSaveState("saving");

		if (saveTimer.current) {
			window.clearTimeout(saveTimer.current);
		}
		if (saveInFlightRef.current) {
			return;
		}

		saveTimer.current = window.setTimeout(() => {
			void flushQueuedSave();
		}, 700);
	}, [flushQueuedSave]);

	const persistCurrentDocument = useCallback(async () => {
		if (!editor) {
			return;
		}

		queueSave(editor.getJSON() as JsonObject);
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await flushQueuedSave();
			if (!pendingSaveRef.current && !saveInFlightRef.current) {
				return;
			}
			await delay(100);
		}
	}, [editor, flushQueuedSave, queueSave]);

	const loadAuditLog = useCallback(async () => {
		setAuditLogLoading(true);
		setAuditLogError(null);
		try {
			const response = await fetch("/api/mini-app-audit?limit=30");
			const body = await readJsonBody<MiniAppAuditRecord[] | { error?: unknown }>(response);
			if (!response.ok) {
				const message = !Array.isArray(body) && typeof body.error === "string"
					? body.error
					: `Audit log failed with ${response.status}`;
				throw new Error(message);
			}
			setAuditLogRecords(Array.isArray(body) ? body : []);
		} catch (error) {
			setAuditLogError(error instanceof Error ? error.message : "Audit log could not be loaded.");
		} finally {
			setAuditLogLoading(false);
		}
	}, []);

	const openAuditLog = useCallback(() => {
		setAuditLogOpen(true);
		void loadAuditLog();
	}, [loadAuditLog]);

	const loadBindingRequests = useCallback(async () => {
		setBindingRequestsLoading(true);
		setBindingRequestsError(null);
		try {
			const response = await fetch("/api/extension-binding-requests?limit=30");
			const body = await readJsonBody<ExtensionBindingRequest[] | { error?: unknown }>(response);
			if (!response.ok) {
				const message = !Array.isArray(body) && typeof body.error === "string"
					? body.error
					: `Binding requests failed with ${response.status}`;
				throw new Error(message);
			}
			setBindingRequests(Array.isArray(body) ? body : []);
		} catch (error) {
			setBindingRequestsError(error instanceof Error ? error.message : "Binding requests could not be loaded.");
		} finally {
			setBindingRequestsLoading(false);
		}
	}, []);

	const openBindingRequests = useCallback(() => {
		setBindingRequestsOpen(true);
		setBindingRequests(snapshot?.bindingRequests ?? []);
		void loadBindingRequests();
	}, [loadBindingRequests, snapshot?.bindingRequests]);

	const hostCommands = useMemo<ExtensionCommand[]>(() => [
		{
			id: "agent.ask-in-note",
			label: "Ask agent in note",
			description: "Embed the response at the cursor",
			kind: "workflow",
			scope: "daily-note",
			app: "enchiridion",
			action: "agent.ask",
			requiredHostApis: [],
		},
		{
			id: "agent.build-mini-app-in-note",
			label: "Build mini app in note",
			description: "Create a mini app and insert its reference",
			kind: "workflow",
			scope: "daily-note",
			app: "enchiridion",
			action: "agent.build-app",
			requiredHostApis: [],
		},
		{
			id: "agent.update-mini-app-in-note",
			label: "Update mini app in note",
			description: "Regenerate an existing dynamic mini app",
			kind: "workflow",
			scope: "daily-note",
			app: "enchiridion",
			action: "agent.update-app",
			requiredHostApis: [],
		},
		{
			id: "mini-apps.pin",
			label: "Pin mini apps",
			description: "Choose which apps appear in the sidebar",
			kind: "workflow",
			scope: "global",
			app: "enchiridion",
			action: "mini-apps.pin",
			requiredHostApis: [],
		},
		{
			id: "schedules.manage",
			label: "Manage schedules",
			description: "Enable, disable, and inspect scheduled workflows",
			kind: "workflow",
			scope: "global",
			app: "enchiridion",
			action: "schedules.manage",
			requiredHostApis: [],
		},
		{
			id: "bindings.review",
			label: "Review binding requests",
			description: "Inspect mini apps waiting for isolated Cloudflare resources",
			kind: "workflow",
			scope: "global",
			app: "enchiridion",
			action: "bindings.review",
			requiredHostApis: [],
		},
		{
			id: "audit.view",
			label: "View audit log",
			description: "Inspect agent, mini app, and scheduled workflow activity",
			kind: "workflow",
			scope: "global",
			app: "enchiridion",
			action: "audit.view",
			requiredHostApis: [],
		},
	], []);
	const commands = useMemo(() => [...hostCommands, ...(snapshot?.commands ?? [])], [hostCommands, snapshot?.commands]);
	const filteredCommands = useMemo(() => {
		const query = paletteQuery.toLowerCase();
		return commands.filter((command) => {
			return command.label.toLowerCase().includes(query) || command.description.toLowerCase().includes(query);
		});
	}, [commands, paletteQuery]);

	useEffect(() => {
		setPaletteSelectedIndex(0);
	}, [paletteQuery]);

	useEffect(() => {
		if (paletteSelectedIndex >= filteredCommands.length) {
			setPaletteSelectedIndex(Math.max(0, filteredCommands.length - 1));
		}
	}, [filteredCommands.length, paletteSelectedIndex]);

	const moveCalendar = useCallback((delta: number) => {
		if (calendarExpanded) {
			setCalendarMonth((month) => addMonths(month, delta));
			return;
		}
		setSelectedDate((date) => addDays(date, delta * 7));
	}, [calendarExpanded]);

	const insertExtensionBlockAttrs = useCallback((attrs: { app: string; block: string; props: JsonObject; version?: string }, range?: SlashRange) => {
		if (!editor) {
			return;
		}
		const chain = editor.chain().focus();
		if (range) {
			chain.deleteRange(range);
		}
		chain.insertContent({
			type: "extensionBlock",
			attrs: {
				app: attrs.app,
				block: attrs.block,
				props: attrs.props,
				version: attrs.version ?? "0.1.0",
			},
		}).run();
	}, [editor]);

	const insertExtensionBlock = useCallback((block: ExtensionEditorBlock, range?: SlashRange) => {
		insertExtensionBlockAttrs({
			app: block.app,
			block: block.id,
			props: {
				...block.defaultProps,
				title: block.label,
				summary: block.description,
			},
			version: "0.1.0",
		}, range);
	}, [insertExtensionBlockAttrs]);

	const updateExtensionBlock = useCallback((blockId: string, attrs: { app?: string; block?: string; props: ExtensionBlockProps }) => {
		if (!editor) {
			return;
		}
		editor.commands.command(({ state, tr, dispatch }) => {
			let found = false;
			state.doc.descendants((node, position) => {
				if (found || node.type.name !== "extensionBlock") {
					return !found;
				}
				const currentProps = asExtensionBlockProps(node.attrs.props);
				if (currentProps.id !== blockId) {
					return true;
				}
				found = true;
				tr.setNodeMarkup(position, undefined, {
					...node.attrs,
					app: attrs.app ?? node.attrs.app,
					block: attrs.block ?? node.attrs.block,
					props: attrs.props,
				});
				return false;
			});
			if (found && dispatch) {
				dispatch(tr);
			}
			return found;
		});
	}, [editor]);

	const removeExtensionBlock = useCallback((blockId: string) => {
		if (!editor) {
			return;
		}
		editor.commands.command(({ state, tr, dispatch }) => {
			let found = false;
			state.doc.descendants((node, position) => {
				if (found || node.type.name !== "extensionBlock") {
					return !found;
				}
				const currentProps = asExtensionBlockProps(node.attrs.props);
				if (currentProps.id !== blockId) {
					return true;
				}
				found = true;
				tr.delete(position, position + node.nodeSize);
				return false;
			});
			if (found && dispatch) {
				dispatch(tr);
			}
			return found;
		});
	}, [editor]);

	const pollMiniAppBuildRun = useCallback(async (pending: PendingMiniAppBuildRun) => {
		if (activeMiniAppRunPollers.current.has(pending.buildId)) {
			return;
		}

		activeMiniAppRunPollers.current.add(pending.buildId);
		try {
			while (!unmountedRef.current) {
				const build = await fetchMiniAppBuild(pending.buildId);
				if (build.status === "pending" || build.status === "running" || build.status === "interrupted") {
					updateExtensionBlock(pending.blockId, {
						app: "agent",
						block: "request",
						props: {
							id: pending.blockId,
							buildDeadlineAt: build.deadlineAt,
							buildId: build.id,
							operation: pending.intent.operation,
							prompt: pending.prompt,
							runId: build.currentRunId ?? pending.runId,
							slugHint: pending.intent.slugHint,
							status: "running",
							summary: formatMiniAppBuildProgress(build),
							targetSlug: pending.intent.targetSlug,
							title: build.status === "interrupted" ? "Mini app build retrying" : "Mini app build running",
							workflowName: generateMiniAppWorkflowName,
						},
					});
					await delay(build.status === "interrupted" ? 10_000 : 3_000);
					continue;
				}

				if (build.status === "completed") {
					const result = asRecord(build.result);
					const slug = String(result.slug ?? pending.intent.targetSlug ?? "mini-app");
					const route = typeof result.routeUrl === "string" && result.routeUrl.trim() ? result.routeUrl : `/apps/${slug}`;
					updateExtensionBlock(pending.blockId, {
						app: slug,
						block: "mini-app-reference",
						props: {
							id: pending.blockId,
							buildDeadlineAt: build.deadlineAt,
							buildId: build.id,
							operation: pending.intent.operation,
							prompt: pending.prompt,
							route,
							runId: build.currentRunId ?? pending.runId,
							slugHint: pending.intent.slugHint,
							status: "complete",
							summary: formatMiniAppResult(result, pending.intent, typeof window !== "undefined" ? window.location.origin : undefined),
							title: `${humanizeSlug(slug)} mini app`,
							workflowName: generateMiniAppWorkflowName,
						},
					});
					await persistCurrentDocument();
					await loadSnapshot(selectedDate);
					return;
				}

				updateExtensionBlock(pending.blockId, {
					app: "agent",
					block: "error",
					props: {
						id: pending.blockId,
						buildDeadlineAt: build.deadlineAt,
						buildId: build.id,
						operation: pending.intent.operation,
						prompt: pending.prompt,
						runId: build.currentRunId ?? pending.runId,
						status: "error",
						summary: formatMiniAppBuildError(build.error, `Mini app build ${pending.buildId} failed.`),
						title: build.status === "expired" ? "Mini app build expired" : "Mini app build failed",
						workflowName: generateMiniAppWorkflowName,
					},
				});
				await persistCurrentDocument();
				return;
			}
		} catch (error) {
			if (!unmountedRef.current) {
				updateExtensionBlock(pending.blockId, {
					app: "agent",
					block: "error",
					props: {
						id: pending.blockId,
						operation: pending.intent.operation,
						prompt: pending.prompt,
						buildId: pending.buildId,
						runId: pending.runId,
						status: "error",
						summary: formatMiniAppBuildError(error, `Mini app build ${pending.buildId} could not be checked.`),
						title: "Mini app build failed",
						workflowName: generateMiniAppWorkflowName,
					},
				});
				await persistCurrentDocument();
			}
		} finally {
			activeMiniAppRunPollers.current.delete(pending.buildId);
		}
	}, [loadSnapshot, persistCurrentDocument, selectedDate, updateExtensionBlock]);

	useEffect(() => {
		if (!note) {
			return;
		}

		for (const pending of findPendingMiniAppBuildRuns(note.documentJson)) {
			void pollMiniAppBuildRun(pending);
		}
	}, [note?.id, note?.version, pollMiniAppBuildRun]);

	const startAgentRequestInDocument = useCallback((mode: AgentRequestMode, range?: SlashRange) => {
		if (!editor || !snapshot) {
			return;
		}
		const dynamicExtensions = snapshot.extensions.filter((extension) => extension.status === "dynamic");
		const actionLabel = mode === "build" ? "Build app" : mode === "update" ? "Update app" : "Ask agent";
		const title = mode === "build" ? "Build mini app" : mode === "update" ? "Update mini app" : "Ask agent";
		const placeholder = mode === "build"
			? "Describe the mini app to build..."
			: mode === "update"
				? "Describe what should change..."
				: "Ask for a summary, draft, plan, or action...";
		insertExtensionBlockAttrs({
			app: "agent",
			block: "request-input",
			props: {
				id: createClientId(),
				actionLabel,
				mode,
				placeholder,
				status: "draft",
				summary: "The response will replace this block.",
				targetOptions: dynamicExtensions.map((extension) => ({
					name: extension.name,
					slug: extension.slug,
				})),
				targetSlug: mode === "update" && dynamicExtensions.length === 1 ? dynamicExtensions[0]?.slug : undefined,
				title,
			},
		}, range);
	}, [editor, insertExtensionBlockAttrs, snapshot]);

	const submitAgentRequest = useCallback(async ({
		blockId,
		contextPrompt,
		contextResponse,
		mode,
		prompt: inputPrompt,
		targetSlug: inputTargetSlug,
	}: AgentRequestSubmitEvent["detail"]) => {
		if (!snapshot) {
			return;
		}
		const message = inputPrompt.trim();
		if (!message) {
			return;
		}
		let operationOverride: MiniAppOperation | undefined;
		let targetSlug: string | undefined;
		let promptPrefix = "";

		if (mode === "update") {
			const dynamicExtensions = snapshot.extensions.filter((extension) => extension.status === "dynamic");
			const searchableExtensions = dynamicExtensions.length > 0 ? dynamicExtensions : snapshot.extensions;
			const target = inputTargetSlug ? findReferencedExtension(inputTargetSlug, searchableExtensions) : findReferencedExtension(message, searchableExtensions);
			targetSlug = target?.slug ?? inputTargetSlug?.trim();
			if (!targetSlug) {
				updateExtensionBlock(blockId, {
					app: "agent",
					block: "error",
					props: {
						id: blockId,
						prompt: message,
						status: "error",
						title: "Agent failed",
						summary: "Choose or type a mini app slug to update.",
					},
				});
				return;
			}
			operationOverride = "update";
			promptPrefix = `Update ${target ? `${target.name} (${target.slug})` : targetSlug} mini app:\n`;
		}

		const prompt = `${promptPrefix}${message}`;
		const agentPrompt = buildFollowUpPrompt({
			contextPrompt,
			contextResponse,
			prompt,
		});
		updateExtensionBlock(blockId, {
			app: "agent",
			block: "request",
			props: {
				id: blockId,
				prompt,
				status: "running",
				title: "Agent request",
				summary: "Working in the document.",
			},
		});

		let attemptedMiniAppBuild = mode === "build" || mode === "update";
		try {
			const intent: MiniAppIntent = operationOverride
				? { shouldBuild: true, operation: operationOverride, ...(targetSlug ? { targetSlug } : {}) }
				: inferMiniAppIntent(agentPrompt, snapshot.extensions, mode === "build");
			if (intent.shouldBuild) {
				attemptedMiniAppBuild = true;
				updateExtensionBlock(blockId, {
					app: "agent",
					block: "request",
					props: {
						id: blockId,
						operation: intent.operation,
						prompt,
						slugHint: intent.slugHint,
						status: "running",
						summary: "Admitting the mini app build to Flue.",
						targetSlug: intent.targetSlug,
						title: "Mini app build starting",
						workflowName: generateMiniAppWorkflowName,
					},
				});
				await persistCurrentDocument();
				const buildResponse = await fetch("/api/mini-app-builds", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						prompt: agentPrompt,
						operation: intent.operation,
						targetSlug: intent.targetSlug,
						slugHint: intent.slugHint,
						autonomousDeploy: true,
					}),
				});
				const build = await readJsonBody<MiniAppBuildAdmission & { error?: unknown }>(buildResponse);
				if (!buildResponse.ok || !build.id) {
					throw new Error(formatMiniAppBuildError(build.error, `Mini app build admission failed with ${buildResponse.status}`));
				}
				updateExtensionBlock(blockId, {
					app: "agent",
					block: "request",
					props: {
						id: blockId,
						buildDeadlineAt: build.deadlineAt,
						buildId: build.id,
						operation: intent.operation,
						prompt,
						runId: build.currentRunId ?? undefined,
						slugHint: intent.slugHint,
						status: "running",
						summary: formatMiniAppBuildProgress({
							attemptCount: 1,
							autonomousDeploy: build.autonomousDeploy,
							completedAt: null,
							createdAt: "",
							currentRunId: build.currentRunId,
							deadlineAt: build.deadlineAt,
							error: build.error,
							id: build.id,
							maxAttempts: build.maxAttempts,
							operation: build.operation,
							prompt: build.prompt,
							result: build.result,
							status: build.status,
							targetSlug: build.targetSlug,
							slugHint: build.slugHint,
							updatedAt: "",
						}),
						targetSlug: intent.targetSlug,
						title: "Mini app build running",
						workflowName: generateMiniAppWorkflowName,
					},
				});
				await persistCurrentDocument();
				void pollMiniAppBuildRun({
					buildId: build.id,
					blockId,
					intent,
					prompt,
					runId: build.currentRunId ?? undefined,
				});
				return;
			}

			const response = await fetch("/api/flue/agents/second-brain-agent/default?wait=result", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: buildAgentMessage(agentPrompt, snapshot.extensions) }),
			});
			const body = await readJsonBody<{ result?: unknown; error?: unknown }>(response);
			if (!response.ok) {
				throw new Error(formatAgentError(body.error, `Agent failed with ${response.status}`));
			}
			updateExtensionBlock(blockId, {
				app: "agent",
				block: "response",
				props: {
					id: blockId,
					prompt,
					status: "complete",
					title: "Agent response",
					summary: formatAgentResult(body.result),
				},
			});
		} catch (error) {
			const buildError = attemptedMiniAppBuild;
			const summary = buildError
				? formatMiniAppBuildError(error, "Mini app build failed before returning a deployment result. No mini app was activated.")
				: formatAgentError(error, "Agent request failed.");
			updateExtensionBlock(blockId, {
				app: "agent",
				block: "error",
				props: {
					id: blockId,
					prompt,
					status: "error",
					title: buildError ? "Mini app build failed" : "Agent failed",
					summary,
				},
			});
		}
	}, [loadSnapshot, persistCurrentDocument, pollMiniAppBuildRun, selectedDate, snapshot, updateExtensionBlock]);

	useEffect(() => {
		const onAgentRequestSubmit = (event: Event) => {
			void submitAgentRequest((event as AgentRequestSubmitEvent).detail);
		};
		window.addEventListener(agentRequestSubmitEvent, onAgentRequestSubmit);
		return () => window.removeEventListener(agentRequestSubmitEvent, onAgentRequestSubmit);
	}, [submitAgentRequest]);

	useEffect(() => {
		const onAgentRequestCancel = (event: Event) => {
			removeExtensionBlock((event as AgentRequestCancelEvent).detail.blockId);
		};
		window.addEventListener(agentRequestCancelEvent, onAgentRequestCancel);
		return () => window.removeEventListener(agentRequestCancelEvent, onAgentRequestCancel);
	}, [removeExtensionBlock]);

	const runRichTextCommand = useCallback((command: RichTextCommand, range: SlashRange) => {
		if (!editor) {
			return;
		}
		const chain = editor.chain().focus().deleteRange(range);
		if (command === "heading-1") {
			chain.setNode("heading", { level: 1 }).run();
			return;
		}
		if (command === "heading-2") {
			chain.setNode("heading", { level: 2 }).run();
			return;
		}
		if (command === "bullet-list") {
			chain.toggleBulletList().run();
			return;
		}
		if (command === "ordered-list") {
			chain.toggleOrderedList().run();
			return;
		}
		if (command === "quote") {
			chain.toggleBlockquote().run();
			return;
		}
		chain.toggleCodeBlock().run();
	}, [editor]);

	const insertAdmonition = useCallback((kind: AdmonitionKind, range: SlashRange) => {
		if (!editor) {
			return;
		}
		editor.chain().focus().deleteRange(range).insertContent({
			type: "admonition",
			attrs: {
				kind,
				title: admonitionLabels[kind],
			},
			content: [{ type: "paragraph" }],
		}).run();
	}, [editor]);

	const startBookmarkCreateInDocument = useCallback((range?: SlashRange) => {
		insertExtensionBlockAttrs({
			app: "bookmarks",
			block: "create-bookmark",
			props: {
				id: createClientId(),
				status: "draft",
				summary: "Creates the bookmark and leaves a reference here.",
				title: "Create bookmark",
			},
		}, range);
	}, [insertExtensionBlockAttrs]);

	const startProjectCreateInDocument = useCallback((range?: SlashRange) => {
		insertExtensionBlockAttrs({
			app: "projects",
			block: "create-project",
			props: {
				id: createClientId(),
				status: "draft",
				summary: "Creates the project and leaves a reference here.",
				title: "Create project",
			},
		}, range);
	}, [insertExtensionBlockAttrs]);

	const startKanbanCardCreateInDocument = useCallback((range?: SlashRange) => {
		insertExtensionBlockAttrs({
			app: "projects",
			block: "create-card",
			props: {
				id: createClientId(),
				status: "draft",
				summary: "Creates the card and leaves a reference here.",
				title: "Create Kanban card",
			},
		}, range);
	}, [insertExtensionBlockAttrs]);

	const submitBookmarkCreate = useCallback(async ({ blockId, description, tags, title, url }: BookmarkCreateSubmitEvent["detail"]) => {
		updateExtensionBlock(blockId, {
			app: "bookmarks",
			block: "bookmark-reference",
			props: {
				id: blockId,
				route: "/apps/bookmarks",
				status: "running",
				summary: url,
				title: "Saving bookmark",
			},
		});

		try {
			const response = await fetch("/api/apps/bookmarks/bookmarks", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ description, tags, title, url }),
			});
			const bookmark = await readJsonBody<Bookmark>(response);
			if (!response.ok) {
				throw new Error(`Bookmark save failed with ${response.status}`);
			}
			updateExtensionBlock(blockId, {
				app: "bookmarks",
				block: "bookmark-reference",
				props: {
					id: blockId,
					route: "/apps/bookmarks",
					status: "complete",
					summary: bookmark.description || bookmark.url,
					title: bookmark.title,
					url: bookmark.url,
				},
			});
			await loadSnapshot(selectedDate);
		} catch (error) {
			updateExtensionBlock(blockId, {
				app: "bookmarks",
				block: "bookmark-reference",
				props: {
					id: blockId,
					route: "/apps/bookmarks",
					status: "error",
					summary: error instanceof Error ? error.message : "Bookmark save failed.",
					title: "Bookmark failed",
				},
			});
		}
	}, [loadSnapshot, selectedDate, updateExtensionBlock]);

	const submitProjectCreate = useCallback(async ({ blockId, description, name }: ProjectCreateSubmitEvent["detail"]) => {
		updateExtensionBlock(blockId, {
			app: "projects",
			block: "project-reference",
			props: {
				id: blockId,
				route: "/apps/projects",
				status: "running",
				summary: description,
				title: "Saving project",
			},
		});

		try {
			const response = await fetch("/api/apps/projects/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ description, name }),
			});
			const project = await readJsonBody<Project>(response);
			if (!response.ok) {
				throw new Error(`Project save failed with ${response.status}`);
			}
			updateExtensionBlock(blockId, {
				app: "projects",
				block: "project-reference",
				props: {
					id: blockId,
					route: "/apps/projects",
					status: "complete",
					summary: project.description || project.status,
					title: project.name,
				},
			});
			await loadSnapshot(selectedDate);
		} catch (error) {
			updateExtensionBlock(blockId, {
				app: "projects",
				block: "project-reference",
				props: {
					id: blockId,
					route: "/apps/projects",
					status: "error",
					summary: error instanceof Error ? error.message : "Project save failed.",
					title: "Project failed",
				},
			});
		}
	}, [loadSnapshot, selectedDate, updateExtensionBlock]);

	const submitKanbanCardCreate = useCallback(async ({ blockId, description, title }: KanbanCardCreateSubmitEvent["detail"]) => {
		updateExtensionBlock(blockId, {
			app: "projects",
			block: "kanban-card-reference",
			props: {
				id: blockId,
				route: "/apps/projects",
				status: "running",
				summary: description,
				title: "Saving card",
			},
		});

		try {
			const response = await fetch("/api/apps/projects/cards", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ description, title }),
			});
			const card = await readJsonBody<KanbanCard>(response);
			if (!response.ok) {
				throw new Error(`Card save failed with ${response.status}`);
			}
			updateExtensionBlock(blockId, {
				app: "projects",
				block: "kanban-card-reference",
				props: {
					id: blockId,
					route: "/apps/projects",
					status: "complete",
					summary: card.description || "Kanban card",
					title: card.title,
				},
			});
			await loadSnapshot(selectedDate);
		} catch (error) {
			updateExtensionBlock(blockId, {
				app: "projects",
				block: "kanban-card-reference",
				props: {
					id: blockId,
					route: "/apps/projects",
					status: "error",
					summary: error instanceof Error ? error.message : "Card save failed.",
					title: "Card failed",
				},
			});
		}
	}, [loadSnapshot, selectedDate, updateExtensionBlock]);

	useEffect(() => {
		const onBookmarkCreateSubmit = (event: Event) => {
			void submitBookmarkCreate((event as BookmarkCreateSubmitEvent).detail);
		};
		window.addEventListener(bookmarkCreateSubmitEvent, onBookmarkCreateSubmit);
		return () => window.removeEventListener(bookmarkCreateSubmitEvent, onBookmarkCreateSubmit);
	}, [submitBookmarkCreate]);

	useEffect(() => {
		const onBookmarkCreateCancel = (event: Event) => {
			removeExtensionBlock((event as BookmarkCreateCancelEvent).detail.blockId);
		};
		window.addEventListener(bookmarkCreateCancelEvent, onBookmarkCreateCancel);
		return () => window.removeEventListener(bookmarkCreateCancelEvent, onBookmarkCreateCancel);
	}, [removeExtensionBlock]);

	useEffect(() => {
		const onProjectCreateSubmit = (event: Event) => {
			void submitProjectCreate((event as ProjectCreateSubmitEvent).detail);
		};
		window.addEventListener(projectCreateSubmitEvent, onProjectCreateSubmit);
		return () => window.removeEventListener(projectCreateSubmitEvent, onProjectCreateSubmit);
	}, [submitProjectCreate]);

	useEffect(() => {
		const onProjectCreateCancel = (event: Event) => {
			removeExtensionBlock((event as ProjectCreateCancelEvent).detail.blockId);
		};
		window.addEventListener(projectCreateCancelEvent, onProjectCreateCancel);
		return () => window.removeEventListener(projectCreateCancelEvent, onProjectCreateCancel);
	}, [removeExtensionBlock]);

	useEffect(() => {
		const onKanbanCardCreateSubmit = (event: Event) => {
			void submitKanbanCardCreate((event as KanbanCardCreateSubmitEvent).detail);
		};
		window.addEventListener(kanbanCardCreateSubmitEvent, onKanbanCardCreateSubmit);
		return () => window.removeEventListener(kanbanCardCreateSubmitEvent, onKanbanCardCreateSubmit);
	}, [submitKanbanCardCreate]);

	useEffect(() => {
		const onKanbanCardCreateCancel = (event: Event) => {
			removeExtensionBlock((event as KanbanCardCreateCancelEvent).detail.blockId);
		};
		window.addEventListener(kanbanCardCreateCancelEvent, onKanbanCardCreateCancel);
		return () => window.removeEventListener(kanbanCardCreateCancelEvent, onKanbanCardCreateCancel);
	}, [removeExtensionBlock]);

	const slashCommandItems = useMemo<SlashCommandItem[]>(() => [
		{
			id: "agent.ask",
			label: "Ask agent",
			description: "Embed an agent response in this note",
			app: "enchiridion",
			icon: "agent",
			run: (range) => startAgentRequestInDocument("ask", range),
		},
		{
			id: "agent.build-app",
			label: "Build mini app",
			description: "Create a mini app and insert its reference",
			app: "enchiridion",
			icon: "agent",
			run: (range) => startAgentRequestInDocument("build", range),
		},
		{
			id: "agent.update-app",
			label: "Update mini app",
			description: "Regenerate an existing dynamic mini app",
			app: "enchiridion",
			icon: "agent",
			run: (range) => startAgentRequestInDocument("update", range),
		},
		{
			id: "bookmarks.create",
			label: "Create bookmark",
			description: "Capture a URL in this note",
			app: "bookmarks",
			icon: "block",
			keywords: ["capture", "link", "save", "url"],
			run: (range) => startBookmarkCreateInDocument(range),
		},
		{
			id: "format.heading-1",
			label: "Heading 1",
			description: "Large section heading",
			app: "editor",
			icon: "heading-1",
			keywords: ["h1", "#", "title"],
			run: (range) => runRichTextCommand("heading-1", range),
		},
		{
			id: "format.heading-2",
			label: "Heading 2",
			description: "Section heading",
			app: "editor",
			icon: "heading-2",
			keywords: ["h2", "##", "subtitle"],
			run: (range) => runRichTextCommand("heading-2", range),
		},
		{
			id: "format.bullet-list",
			label: "Bullet list",
			description: "Start a bulleted list",
			app: "editor",
			icon: "bullet-list",
			keywords: ["bullet", "bullets", "list", "ul", "-"],
			run: (range) => runRichTextCommand("bullet-list", range),
		},
		{
			id: "format.ordered-list",
			label: "Numbered list",
			description: "Start a numbered list",
			app: "editor",
			icon: "ordered-list",
			keywords: ["numbered", "ordered", "list", "ol", "1."],
			run: (range) => runRichTextCommand("ordered-list", range),
		},
		{
			id: "format.quote",
			label: "Quote",
			description: "Start a quote block",
			app: "editor",
			icon: "quote",
			keywords: ["blockquote", ">"],
			run: (range) => runRichTextCommand("quote", range),
		},
		{
			id: "admonition.info",
			label: "Info admonition",
			description: "Call out context or details",
			app: "editor",
			icon: "info",
			keywords: ["callout", "note", "admonition", "info"],
			run: (range) => insertAdmonition("info", range),
		},
		{
			id: "admonition.warning",
			label: "Warning admonition",
			description: "Call out risk or caution",
			app: "editor",
			icon: "warning",
			keywords: ["warn", "warning", "caution", "admonition", "alert"],
			run: (range) => insertAdmonition("warning", range),
		},
		{
			id: "admonition.error",
			label: "Error admonition",
			description: "Call out a failure or blocker",
			app: "editor",
			icon: "error",
			keywords: ["error", "danger", "failed", "admonition"],
			run: (range) => insertAdmonition("error", range),
		},
		{
			id: "admonition.success",
			label: "Success admonition",
			description: "Call out a confirmed result",
			app: "editor",
			icon: "success",
			keywords: ["success", "done", "passed", "admonition"],
			run: (range) => insertAdmonition("success", range),
		},
		{
			id: "admonition.alert",
			label: "Alert admonition",
			description: "Call out something urgent",
			app: "editor",
			icon: "warning",
			keywords: ["alert", "urgent", "important", "admonition"],
			run: (range) => insertAdmonition("alert", range),
		},
		{
			id: "format.code",
			label: "Code block",
			description: "Start a code block",
			app: "editor",
			icon: "code",
			keywords: ["code", "pre", "```"],
			run: (range) => runRichTextCommand("code", range),
		},
		...(snapshot?.editorBlocks ?? []).map((block): SlashCommandItem => ({
			id: `${block.app}.${block.id}`,
			label: block.label,
			description: block.description,
			app: block.app,
			icon: block.app === "projects" ? "kanban" : "block",
			run: (range) => insertExtensionBlock(block, range),
		})),
	], [insertAdmonition, insertExtensionBlock, runRichTextCommand, snapshot?.editorBlocks, startAgentRequestInDocument, startBookmarkCreateInDocument]);

	const filteredSlashItems = useMemo(() => {
		if (!slashState) {
			return [];
		}
		const query = normalizeSearch(slashState.query);
		const items = query
			? slashCommandItems.filter((item) => {
				return normalizeSearch(`${item.label} ${item.description} ${item.app} ${(item.keywords ?? []).join(" ")}`).includes(query);
			})
			: slashCommandItems;
		return items.slice(0, 12);
	}, [slashCommandItems, slashState]);

	useEffect(() => {
		slashItemsRef.current = filteredSlashItems;
		if (slashSelectedIndex >= filteredSlashItems.length) {
			setSlashSelectedIndex(Math.max(0, filteredSlashItems.length - 1));
		}
	}, [filteredSlashItems, slashSelectedIndex]);

	useEffect(() => {
		const onSlashKey = (event: Event) => {
			const detail = (event as SlashCommandKeyEvent).detail;
			const state = slashStateRef.current;
			const items = slashItemsRef.current;
			if (!state) {
				return;
			}
			if (detail.key === "Escape") {
				setSlashState(null);
				detail.handled = true;
				return;
			}
			if (items.length === 0) {
				return;
			}
			if (detail.key === "ArrowDown") {
				setSlashSelectedIndex((current) => (current + 1) % items.length);
				detail.handled = true;
				return;
			}
			if (detail.key === "ArrowUp") {
				setSlashSelectedIndex((current) => (current - 1 + items.length) % items.length);
				detail.handled = true;
				return;
			}
			if (detail.key === "Enter") {
				const selected = items[Math.min(slashSelectedIndexRef.current, items.length - 1)];
				setSlashState(null);
				void selected.run({ from: state.from, to: state.to });
				detail.handled = true;
			}
		};
		window.addEventListener(slashKeyEvent, onSlashKey);
		return () => window.removeEventListener(slashKeyEvent, onSlashKey);
	}, []);

	const runCommand = useCallback(async (command: ExtensionCommand) => {
		if (command.app === "enchiridion" && command.action === "agent.ask") {
			closePalette();
			startAgentRequestInDocument("ask");
			return;
		}
		if (command.app === "enchiridion" && command.action === "agent.build-app") {
			closePalette();
			startAgentRequestInDocument("build");
			return;
		}
		if (command.app === "enchiridion" && command.action === "agent.update-app") {
			closePalette();
			startAgentRequestInDocument("update");
			return;
		}
		if (command.app === "enchiridion" && command.action === "mini-apps.pin") {
			closePalette();
			setPinChooserOpen(true);
			return;
		}
		if (command.app === "enchiridion" && command.action === "schedules.manage") {
			closePalette();
			setScheduleManagerOpen(true);
			return;
		}
		if (command.app === "enchiridion" && command.action === "audit.view") {
			closePalette();
			openAuditLog();
			return;
		}
		if (command.app === "enchiridion" && command.action === "bindings.review") {
			closePalette();
			openBindingRequests();
			return;
		}
		if (command.kind === "navigate") {
			closePalette();
			const routeAction = routeActionForCommand(command);
			if (routeAction.type === "app-tab") {
				openAppInShell({
					mode: "tab",
					route: routeAction.route,
					title: routeAction.title,
				});
				return;
			}
			window.location.href = routeAction.href;
			return;
		}
		if (command.kind === "insert-block") {
			const block = snapshot?.editorBlocks.find((entry) => entry.app === command.app && entry.id === command.action);
			if (block) {
				insertExtensionBlock(block);
			}
			closePalette();
			return;
		}
		if (command.action === "bookmarks.create") {
			closePalette();
			startBookmarkCreateInDocument();
			return;
		}
		if (command.action === "projects.create") {
			closePalette();
			startProjectCreateInDocument();
			return;
		}
		if (command.action === "cards.create") {
			closePalette();
			startKanbanCardCreateInDocument();
			return;
		}
		closePalette();
	}, [closePalette, insertExtensionBlock, openAuditLog, openBindingRequests, snapshot?.editorBlocks, startAgentRequestInDocument, startBookmarkCreateInDocument, startKanbanCardCreateInDocument, startProjectCreateInDocument]);

	const toggleScheduledWorkflow = useCallback(async (workflow: ScheduledWorkflow, enabled: boolean) => {
		setScheduleUpdatingIds((current) => current.includes(workflow.id) ? current : [...current, workflow.id]);
		setScheduleErrors((current) => {
			const { [workflow.id]: _removed, ...rest } = current;
			return rest;
		});
		try {
			const response = await fetch(`/api/scheduled-workflows/${encodeURIComponent(workflow.id)}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			const body = await readJsonBody<ScheduledWorkflow & { error?: unknown }>(response);
			if (!response.ok) {
				throw new Error(typeof body.error === "string" ? body.error : `Schedule update failed with ${response.status}`);
			}
			setSnapshot((current) => current
				? {
					...current,
					scheduledWorkflows: current.scheduledWorkflows.map((entry) => entry.id === body.id ? body : entry),
				}
				: current);
		} catch (error) {
			setScheduleErrors((current) => ({
				...current,
				[workflow.id]: error instanceof Error ? error.message : "Schedule update failed.",
			}));
		} finally {
			setScheduleUpdatingIds((current) => current.filter((entry) => entry !== workflow.id));
		}
	}, []);

	if (!snapshot || !note) {
		if (loadError) {
			return <BootstrapError message={loadError} onRetry={() => void loadSnapshot(selectedDate)} />;
		}
		return (
			<div {...stylex.props(shell.loadingShell)}>
				<div {...stylex.props(shell.loadingMark)} />
				<span>Loading Enchiridion</span>
			</div>
		);
	}

	const pinnedExtensions = snapshot.extensions.filter((extension) => pinnedAppSlugs.includes(extension.slug));
	const activePanelTab = panelTabs.find((tab) => tab.id === activePanelTabId) ?? panelTabs[0] ?? null;
	const noteDisplayTitle = titleForDailyNote(note.date);
	const activeWorkspaceTab = activeWorkspaceTabId
		? workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? null
		: null;
	const noteDates = new Set(snapshot.recentNotes.map((entry) => entry.date));
	const calendarDays = calendarExpanded ? buildMonthCalendarDays(calendarMonth) : buildWeekCalendarDays(selectedDate);
	const calendarTitle = calendarExpanded ? formatCalendarMonth(calendarMonth) : formatCalendarWeek(selectedDate);
	const calendarUnit = calendarExpanded ? "month" : "week";

	return (
		<div {...stylex.props(shell.appShell, activePanelTab ? shell.appShellWithPanel : null)}>
			<aside {...stylex.props(shell.sidebar)}>
				<div {...stylex.props(shell.brand)}>
					<div {...stylex.props(shell.brandMark)}>E</div>
					<div>
						<strong {...stylex.props(shell.blockText)}>Enchiridion</strong>
						<span {...stylex.props(shell.mutedText, shell.blockText)}>{snapshot.principal.email}</span>
					</div>
				</div>

				<section {...stylex.props(shell.calendarPanel)} aria-label="Daily note calendar">
					<div {...stylex.props(shell.calendarHeader)}>
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)}
							type="button"
							onClick={() => moveCalendar(-1)}
							aria-label={`Previous ${calendarUnit}`}
						>
							<ChevronLeft size={15} />
						</button>
						<strong {...stylex.props(shell.calendarTitle)}>{calendarTitle}</strong>
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.calendarModeButton)}
							type="button"
							onClick={() => setCalendarExpanded((current) => !current)}
							aria-label={calendarExpanded ? "Show week calendar" : "Show full month calendar"}
							aria-expanded={calendarExpanded}
							title={calendarExpanded ? "Show week" : "Show month"}
						>
							{calendarExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
						</button>
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)}
							type="button"
							onClick={() => moveCalendar(1)}
							aria-label={`Next ${calendarUnit}`}
						>
							<ChevronRight size={15} />
						</button>
					</div>
					<div {...stylex.props(shell.weekdayGrid)} aria-hidden="true">
						{["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
							<span key={`${day}-${index}`}>{day}</span>
						))}
					</div>
					<div {...stylex.props(shell.calendarGrid)}>
						{calendarDays.map((day) => (
							<button
								key={day.date}
								{...stylex.props(
									shell.calendarDay,
									day.inMonth ? null : shell.calendarDayOutside,
									day.date === selectedDate ? shell.calendarDaySelected : null,
									day.date === dateKey() ? shell.calendarDayToday : null,
								)}
								type="button"
								onClick={() => setSelectedDate(day.date)}
								aria-label={`Open daily note ${day.date}`}
							>
								<span>{day.label}</span>
								{noteDates.has(day.date) ? <span {...stylex.props(shell.calendarDot)} /> : null}
							</button>
						))}
					</div>
				</section>

				<div {...stylex.props(shell.sidebarSection)}>
					<div {...stylex.props(shell.sectionHeaderRow)}>
						<h2 {...stylex.props(shell.sectionHeading)}>Pinned apps</h2>
						<button
							{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
							type="button"
							onClick={() => setPinChooserOpen(true)}
						>
							<Pin size={14} />
							<span>Pin apps</span>
						</button>
					</div>
					{pinnedExtensions.length === 0 ? (
						<span {...stylex.props(shell.emptyHint)}>No pinned apps. Pin the apps you use often.</span>
					) : pinnedExtensions.map((extension) => {
						const route = primaryRouteForExtension(extension);
						return (
							<div {...stylex.props(shell.miniAppRow)} key={extension.slug}>
								<button
									{...stylex.props(shell.controlBase, shell.interactiveHover, shell.miniAppPrimaryButton)}
									type="button"
									onClick={() => openAppInShell({ mode: "panel", route, title: extension.name })}
								>
									<LayoutGrid size={15} />
									<span>{extension.name}</span>
								</button>
								<button
									{...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)}
									type="button"
									onClick={() => openAppInShell({ mode: "tab", route, title: extension.name })}
									aria-label={`Open ${extension.name} as app tab`}
									title="Open as app tab"
								>
									<ExternalLink size={13} />
								</button>
							</div>
						);
					})}
				</div>
			</aside>

			<main {...stylex.props(shell.workspace)}>
				{workspaceTabs.length > 0 ? (
					<WorkspaceTabs
						tabs={workspaceTabs}
						activeTabId={activeWorkspaceTabId}
						noteTitle={noteDisplayTitle}
						onSelectNote={() => setActiveWorkspaceTabId(null)}
						onSelectTab={setActiveWorkspaceTabId}
						onCloseTab={(tabId) => {
							setWorkspaceTabs((current) => {
								const next = closeAppPanelTab(current, activeWorkspaceTabId, tabId);
								setActiveWorkspaceTabId(next.activeTabId);
								return next.tabs;
							});
						}}
					/>
				) : null}

				{activeWorkspaceTab ? (
					<WorkspaceAppView tab={activeWorkspaceTab} />
				) : (
					<>
						<header {...stylex.props(shell.workspaceHeader)}>
							<div>
								<h1 {...stylex.props(shell.pageTitle)}>{noteDisplayTitle}</h1>
							</div>
							{saveState === "saving" || saveState === "conflict" || saveState === "error" ? <SaveState state={saveState} /> : null}
						</header>

						<section {...stylex.props(shell.editorPanel)}>
							<EditorContent editor={editor} />
						</section>
					</>
				)}
			</main>

			{activePanelTab ? (
				<DocumentPanel
					tabs={panelTabs}
					activeTab={activePanelTab}
					onSelect={setActivePanelTabId}
					onClose={(tabId) => {
						setPanelTabs((current) => {
							const next = closeAppPanelTab(current, activePanelTabId, tabId);
							setActivePanelTabId(next.activeTabId);
							return next.tabs;
						});
					}}
					onCloseAll={() => {
						setPanelTabs([]);
						setActivePanelTabId(null);
					}}
				/>
			) : null}

			{pinChooserOpen ? (
				<PinAppsDialog
					extensions={snapshot.extensions}
					pinnedSlugs={pinnedAppSlugs}
					onToggle={(slug) => {
						setPinnedAppSlugs((current) => current.includes(slug)
							? current.filter((entry) => entry !== slug)
							: [...current, slug]);
					}}
					onClose={() => setPinChooserOpen(false)}
				/>
			) : null}

			{scheduleManagerOpen ? (
				<ScheduledWorkflowsDialog
					workflows={snapshot.scheduledWorkflows}
					updatingIds={scheduleUpdatingIds}
					errors={scheduleErrors}
					onToggle={toggleScheduledWorkflow}
					onClose={() => setScheduleManagerOpen(false)}
				/>
			) : null}

			{auditLogOpen ? (
				<AuditLogDialog
					records={auditLogRecords}
					loading={auditLogLoading}
					error={auditLogError}
					onRefresh={loadAuditLog}
					onClose={() => setAuditLogOpen(false)}
				/>
			) : null}

			{bindingRequestsOpen ? (
				<BindingRequestsDialog
					requests={bindingRequests}
					loading={bindingRequestsLoading}
					error={bindingRequestsError}
					onRefresh={loadBindingRequests}
					onClose={() => setBindingRequestsOpen(false)}
				/>
			) : null}

			{slashState ? (
				<SlashCommandMenu
					items={filteredSlashItems}
					selectedIndex={slashSelectedIndex}
					state={slashState}
					onSelect={(item) => {
						setSlashState(null);
						void item.run({ from: slashState.from, to: slashState.to });
					}}
					onHover={setSlashSelectedIndex}
				/>
			) : null}

			{paletteOpen && (
				<CommandPalette
					commands={filteredCommands}
					query={paletteQuery}
					selectedIndex={paletteSelectedIndex}
					onQuery={setPaletteQuery}
					onSelectedIndex={setPaletteSelectedIndex}
					onClose={closePalette}
					onRun={runCommand}
				/>
			)}
		</div>
	);
}

function BootstrapError({ message, onRetry }: { message: string; onRetry: () => void }) {
	return (
		<div {...stylex.props(shell.loadingShell)}>
			<section {...stylex.props(shell.loadingPanel)} aria-live="polite">
				<div {...stylex.props(shell.loadingErrorMark)}>
					<X size={18} />
				</div>
				<div {...stylex.props(shell.loadingCopy)}>
					<h1 {...stylex.props(shell.loadingTitle)}>Could not load Enchiridion</h1>
					<p {...stylex.props(shell.loadingMessage)}>{message}</p>
				</div>
				<button {...stylex.props(shell.controlBase, shell.interactiveHover, shell.primaryTextButton)} type="button" onClick={onRetry}>
					<RefreshCw size={14} />
					<span>Retry loading</span>
				</button>
			</section>
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

function SlashCommandMenu({
	items,
	selectedIndex,
	state,
	onSelect,
	onHover,
}: {
	items: SlashCommandItem[];
	selectedIndex: number;
	state: SlashMenuState;
	onSelect: (item: SlashCommandItem) => void;
	onHover: (index: number) => void;
}) {
	const left = typeof window === "undefined" ? state.left : Math.min(state.left, window.innerWidth - 360);
	const top = typeof window === "undefined" ? state.top : Math.min(state.top, window.innerHeight - 320);

	return (
		<div
			{...stylex.props(shell.slashMenu)}
			style={{ left, top }}
			role="listbox"
			aria-label="Slash commands"
		>
			<div {...stylex.props(shell.slashMenuHeader)}>
				<span>Commands</span>
				{state.query ? <code {...stylex.props(shell.inlineCode)}>/{state.query}</code> : <code {...stylex.props(shell.inlineCode)}>/</code>}
			</div>
			{items.length === 0 ? (
				<div {...stylex.props(shell.slashEmpty)}>No matching commands</div>
			) : items.map((item, index) => (
				<button
					key={item.id}
					{...stylex.props(
						shell.slashItem,
						index === selectedIndex ? shell.slashItemActive : null,
					)}
					type="button"
					role="option"
					aria-selected={index === selectedIndex}
					onMouseEnter={() => onHover(index)}
					onPointerDown={(event) => {
						event.preventDefault();
					}}
					onClick={() => {
						onSelect(item);
					}}
				>
					<span {...stylex.props(shell.slashIcon)}>
						<SlashItemIcon icon={item.icon} />
					</span>
					<span {...stylex.props(shell.paletteLabel)}>
						<strong>{item.label}</strong>
						<small {...stylex.props(shell.paletteMeta)}>{item.description}</small>
					</span>
					<em {...stylex.props(shell.paletteMeta)}>{item.app}</em>
				</button>
			))}
		</div>
	);
}

function SlashItemIcon({ icon }: { icon: SlashCommandItem["icon"] }) {
	if (icon === "agent") {
		return <Bot size={15} />;
	}
	if (icon === "heading-1") {
		return <Heading1 size={15} />;
	}
	if (icon === "heading-2") {
		return <Heading2 size={15} />;
	}
	if (icon === "bullet-list") {
		return <List size={15} />;
	}
	if (icon === "ordered-list") {
		return <ListOrdered size={15} />;
	}
	if (icon === "quote") {
		return <TextQuote size={15} />;
	}
	if (icon === "code") {
		return <Code2 size={15} />;
	}
	if (icon === "info") {
		return <Info size={15} />;
	}
	if (icon === "warning" || icon === "error") {
		return <TriangleAlert size={15} />;
	}
	if (icon === "success") {
		return <CheckCircle2 size={15} />;
	}
	if (icon === "kanban") {
		return <FolderKanban size={15} />;
	}
	return <Link size={15} />;
}

function PinAppsDialog({
	extensions,
	pinnedSlugs,
	onToggle,
	onClose,
}: {
	extensions: ExtensionManifest[];
	pinnedSlugs: string[];
	onToggle: (slug: string) => void;
	onClose: () => void;
}) {
	return (
		<div {...stylex.props(shell.paletteBackdrop)} role="presentation" onMouseDown={onClose}>
			<div {...stylex.props(shell.palette)} role="dialog" aria-label="Pin mini apps" onMouseDown={(event) => event.stopPropagation()}>
				<div {...stylex.props(shell.paletteInput)}>
					<Pin size={18} />
					<div {...stylex.props(shell.paletteLabel)}>
						<strong>Pin mini apps</strong>
						<small {...stylex.props(shell.paletteMeta)}>Pinned apps appear in the left navigation. Cmd-K still sees every app.</small>
					</div>
					<button {...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)} type="button" onClick={onClose} aria-label="Close pinned apps">
						<X size={15} />
					</button>
				</div>
				<div {...stylex.props(shell.pinList)}>
					{extensions.map((extension) => (
						<label key={extension.slug} {...stylex.props(shell.pinRow)}>
							<input
								type="checkbox"
								checked={pinnedSlugs.includes(extension.slug)}
								onChange={() => onToggle(extension.slug)}
							/>
							<span {...stylex.props(shell.paletteLabel)}>
								<strong>{extension.name}</strong>
								<small {...stylex.props(shell.paletteMeta)}>{extension.description}</small>
							</span>
						</label>
					))}
				</div>
			</div>
		</div>
	);
}

function ScheduledWorkflowsDialog({
	workflows,
	updatingIds,
	errors,
	onToggle,
	onClose,
}: {
	workflows: ScheduledWorkflow[];
	updatingIds: string[];
	errors: Record<string, string>;
	onToggle: (workflow: ScheduledWorkflow, enabled: boolean) => void | Promise<void>;
	onClose: () => void;
}) {
	const sortedWorkflows = [...workflows].sort((left, right) => left.name.localeCompare(right.name));

	return (
		<div {...stylex.props(shell.paletteBackdrop)} role="presentation" onMouseDown={onClose}>
			<div {...stylex.props(shell.palette, shell.workflowDialog)} role="dialog" aria-label="Manage scheduled workflows" onMouseDown={(event) => event.stopPropagation()}>
				<div {...stylex.props(shell.paletteInput)}>
					<Clock size={18} />
					<div {...stylex.props(shell.paletteLabel)}>
						<strong>Scheduled workflows</strong>
						<small {...stylex.props(shell.paletteMeta)}>Generated schedules stay off until you explicitly enable them.</small>
					</div>
					<button {...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)} type="button" onClick={onClose} aria-label="Close scheduled workflows">
						<X size={15} />
					</button>
				</div>
				<div {...stylex.props(shell.workflowList)}>
					{sortedWorkflows.length === 0 ? (
						<div {...stylex.props(shell.workflowEmpty)}>
							<strong>No scheduled workflows</strong>
							<span>Mini apps can declare scheduled work in their manifest. Enchiridion will show it here before it can run.</span>
						</div>
					) : sortedWorkflows.map((workflow) => {
						const updating = updatingIds.includes(workflow.id);
						const requiredHostApis = readWorkflowRequiredHostApis(workflow.payload);
						const error = errors[workflow.id];
						return (
							<section key={workflow.id} {...stylex.props(shell.workflowRow)}>
								<div {...stylex.props(shell.workflowMain)}>
									<div {...stylex.props(shell.workflowTitleRow)}>
										<div {...stylex.props(shell.paletteLabel)}>
											<strong>{workflow.name}</strong>
											<small {...stylex.props(shell.paletteMeta)}>{workflow.extensionSlug ?? "host"} · {workflow.id}</small>
										</div>
										<span {...stylex.props(shell.auditStatus, workflow.enabled ? shell.auditStatusSuccess : shell.auditStatusWarning)}>
											{workflow.enabled ? "Enabled" : "Disabled"}
										</span>
									</div>
									<div {...stylex.props(shell.workflowMetaGrid)}>
										<div {...stylex.props(shell.workflowMetaItem)}>
											<span {...stylex.props(shell.workflowMetaLabel)}>Cron</span>
											<span {...stylex.props(shell.workflowMetaValue)}><code {...stylex.props(shell.inlineCode)}>{workflow.cron}</code></span>
										</div>
										<div {...stylex.props(shell.workflowMetaItem)}>
											<span {...stylex.props(shell.workflowMetaLabel)}>Last run</span>
											<span {...stylex.props(shell.workflowMetaValue)}>{formatWorkflowTimestamp(workflow.lastRunAt)}</span>
										</div>
										<div {...stylex.props(shell.workflowMetaItem)}>
											<span {...stylex.props(shell.workflowMetaLabel)}>Flue workflow</span>
											<span {...stylex.props(shell.workflowMetaValue)}>{workflow.workflowName}</span>
										</div>
										<div {...stylex.props(shell.workflowMetaItem)}>
											<span {...stylex.props(shell.workflowMetaLabel)}>Host scopes</span>
											<span {...stylex.props(shell.workflowMetaValue)}>{requiredHostApis.length > 0 ? requiredHostApis.join(", ") : "None"}</span>
										</div>
									</div>
									{error ? <p {...stylex.props(shell.workflowError)}>{error}</p> : null}
								</div>
								<label {...stylex.props(shell.workflowToggle)}>
									<input
										{...stylex.props(shell.workflowCheckbox)}
										type="checkbox"
										checked={workflow.enabled}
										disabled={updating}
										onChange={(event) => {
											void onToggle(workflow, event.currentTarget.checked);
										}}
									/>
									<span>{updating ? "Updating" : workflow.enabled ? "Disable" : "Enable"}</span>
								</label>
							</section>
						);
					})}
				</div>
			</div>
		</div>
	);
}

function AuditLogDialog({
	records,
	loading,
	error,
	onRefresh,
	onClose,
}: {
	records: MiniAppAuditRecord[];
	loading: boolean;
	error: string | null;
	onRefresh: () => void | Promise<void>;
	onClose: () => void;
}) {
	return (
		<div {...stylex.props(shell.paletteBackdrop)} role="presentation" onMouseDown={onClose}>
			<div {...stylex.props(shell.palette, shell.workflowDialog)} role="dialog" aria-label="Audit log" onMouseDown={(event) => event.stopPropagation()}>
				<div {...stylex.props(shell.paletteInput)}>
					<ScrollText size={18} />
					<div {...stylex.props(shell.paletteLabel)}>
						<strong>Audit log</strong>
						<small {...stylex.props(shell.paletteMeta)}>Agent, mini app, and scheduled workflow activity.</small>
					</div>
					<button
						{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
						type="button"
						disabled={loading}
						onClick={() => {
							void onRefresh();
						}}
					>
						<RefreshCw size={14} />
						<span>{loading ? "Refreshing" : "Refresh"}</span>
					</button>
					<button {...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)} type="button" onClick={onClose} aria-label="Close audit log">
						<X size={15} />
					</button>
				</div>
				<div {...stylex.props(shell.auditList)}>
					{error ? <p {...stylex.props(shell.workflowError)}>{error}</p> : null}
					{records.length === 0 && !loading ? (
						<div {...stylex.props(shell.workflowEmpty)}>
							<strong>No audit records</strong>
							<span>Mini app generation, scheduled work, and host workflow changes will appear here.</span>
						</div>
					) : records.map((record) => {
						const summary = auditDetailSummary(record.details, record.status) || "No details recorded.";
						return (
							<section key={record.id} {...stylex.props(shell.resourceRow, shell.auditRow)}>
								<div {...stylex.props(shell.auditHeader)}>
									<div {...stylex.props(shell.paletteLabel)}>
										<strong {...stylex.props(shell.auditTitle)}>{record.slug} · {record.action}</strong>
										<small {...stylex.props(shell.paletteMeta)}>{formatWorkflowTimestamp(record.createdAt)}</small>
									</div>
									<span {...stylex.props(shell.auditStatus, auditStatusStyle(record.status))}>{record.status}</span>
								</div>
								<p {...stylex.props(shell.auditSummary)}>{summary}</p>
							</section>
						);
					})}
				</div>
			</div>
		</div>
	);
}

function BindingRequestsDialog({
	requests,
	loading,
	error,
	onRefresh,
	onClose,
}: {
	requests: ExtensionBindingRequest[];
	loading: boolean;
	error: string | null;
	onRefresh: () => void | Promise<void>;
	onClose: () => void;
}) {
	const sortedRequests = [...requests].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

	return (
		<div {...stylex.props(shell.paletteBackdrop)} role="presentation" onMouseDown={onClose}>
			<div {...stylex.props(shell.palette, shell.workflowDialog)} role="dialog" aria-label="Binding requests" onMouseDown={(event) => event.stopPropagation()}>
				<div {...stylex.props(shell.paletteInput)}>
					<Database size={18} />
					<div {...stylex.props(shell.paletteLabel)}>
						<strong>Binding requests</strong>
						<small {...stylex.props(shell.paletteMeta)}>Mini apps waiting for isolated Cloudflare storage before dispatch deploy.</small>
					</div>
					<button
						{...stylex.props(shell.controlBase, shell.interactiveHover, shell.toolbarButton)}
						type="button"
						disabled={loading}
						onClick={() => {
							void onRefresh();
						}}
					>
						<RefreshCw size={14} />
						<span>{loading ? "Refreshing" : "Refresh"}</span>
					</button>
					<button {...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)} type="button" onClick={onClose} aria-label="Close binding requests">
						<X size={15} />
					</button>
				</div>
				<div {...stylex.props(shell.workflowList)}>
					{error ? <p {...stylex.props(shell.workflowError)}>{error}</p> : null}
					{sortedRequests.length === 0 && !loading ? (
						<div {...stylex.props(shell.workflowEmpty)}>
							<strong>No binding requests</strong>
							<span>Storage-backed generated apps will appear here instead of failing as opaque agent errors.</span>
						</div>
					) : sortedRequests.map((request) => (
						<section key={request.id} {...stylex.props(shell.workflowRow)}>
							<div {...stylex.props(shell.workflowMain)}>
								<div {...stylex.props(shell.workflowTitleRow)}>
									<div {...stylex.props(shell.paletteLabel)}>
										<strong>{request.extensionName}</strong>
										<small {...stylex.props(shell.paletteMeta)}>{request.extensionSlug} · {request.id}</small>
									</div>
									<span {...stylex.props(shell.auditStatus, auditStatusStyle(request.status))}>{request.status}</span>
								</div>
								<div {...stylex.props(shell.bindingChipList)}>
									{request.bindings.map((binding) => (
										<span key={`${request.id}-${binding.name}`} {...stylex.props(shell.bindingChip)}>
											<strong>{binding.name}</strong>
											<span>{formatBindingType(binding.type)}</span>
											<small>{binding.purpose}</small>
										</span>
									))}
								</div>
								<div {...stylex.props(shell.workflowMetaGrid)}>
									<div {...stylex.props(shell.workflowMetaItem)}>
										<span {...stylex.props(shell.workflowMetaLabel)}>Operation</span>
										<span {...stylex.props(shell.workflowMetaValue)}>{request.operation}</span>
									</div>
									<div {...stylex.props(shell.workflowMetaItem)}>
										<span {...stylex.props(shell.workflowMetaLabel)}>Requested</span>
										<span {...stylex.props(shell.workflowMetaValue)}>{formatWorkflowTimestamp(request.createdAt)}</span>
									</div>
									<div {...stylex.props(shell.workflowMetaItem)}>
										<span {...stylex.props(shell.workflowMetaLabel)}>Primary route</span>
										<span {...stylex.props(shell.workflowMetaValue)}>{primaryRouteForExtension(request.manifest)}</span>
									</div>
									<div {...stylex.props(shell.workflowMetaItem)}>
										<span {...stylex.props(shell.workflowMetaLabel)}>Status</span>
										<span {...stylex.props(shell.workflowMetaValue)}>{request.status}</span>
									</div>
								</div>
								{request.issues.length > 0 ? <p {...stylex.props(shell.auditSummary)}>{request.issues.join(" ")}</p> : null}
							</div>
						</section>
					))}
				</div>
			</div>
		</div>
	);
}

function WorkspaceTabs({
	tabs,
	activeTabId,
	noteTitle,
	onSelectNote,
	onSelectTab,
	onCloseTab,
}: {
	tabs: AppPanelTab[];
	activeTabId: string | null;
	noteTitle: string;
	onSelectNote: () => void;
	onSelectTab: (tabId: string) => void;
	onCloseTab: (tabId: string) => void;
}) {
	return (
		<div {...stylex.props(shell.workspaceTabs)} role="tablist" aria-label="Workspace tabs">
			<button
				{...stylex.props(
					shell.controlBase,
					shell.interactiveHover,
					shell.workspaceTab,
					activeTabId === null ? shell.workspaceTabActive : null,
				)}
				type="button"
				role="tab"
				aria-selected={activeTabId === null}
				onClick={onSelectNote}
			>
				<FileText size={14} />
				<span>{noteTitle}</span>
			</button>
			{tabs.map((tab) => (
				<span key={tab.id} {...stylex.props(shell.workspaceTabGroup)}>
					<button
						{...stylex.props(
							shell.controlBase,
							shell.interactiveHover,
							shell.workspaceTab,
							shell.workspaceTabJoined,
							tab.id === activeTabId ? shell.workspaceTabActive : null,
						)}
						type="button"
						role="tab"
						aria-selected={tab.id === activeTabId}
						onClick={() => onSelectTab(tab.id)}
					>
						<ExternalLink size={14} />
						<span>{tab.title}</span>
					</button>
					<button
						{...stylex.props(shell.controlBase, shell.interactiveHover, shell.workspaceTabClose)}
						type="button"
						onClick={() => onCloseTab(tab.id)}
						aria-label={`Close ${tab.title}`}
					>
						<X size={13} />
					</button>
				</span>
			))}
		</div>
	);
}

function WorkspaceAppView({ tab }: { tab: AppPanelTab }) {
	return (
		<section {...stylex.props(shell.workspaceApp)}>
			<header {...stylex.props(shell.workspaceHeader)}>
				<div>
					<h1 {...stylex.props(shell.pageTitle)}>{tab.title}</h1>
				</div>
			</header>
			<iframe {...stylex.props(shell.workspaceFrame)} src={tab.route} title={tab.title} />
		</section>
	);
}

function DocumentPanel({
	tabs,
	activeTab,
	onSelect,
	onClose,
	onCloseAll,
}: {
	tabs: AppPanelTab[];
	activeTab: AppPanelTab;
	onSelect: (tabId: string) => void;
	onClose: (tabId: string) => void;
	onCloseAll: () => void;
}) {
	return (
		<aside {...stylex.props(shell.documentPanel)} aria-label="Document app panel">
			<header {...stylex.props(shell.documentPanelHeader)}>
				<div {...stylex.props(shell.documentTabs)} role="tablist" aria-label="Open app tabs">
					{tabs.map((tab) => (
						<button
							key={tab.id}
							{...stylex.props(
								shell.controlBase,
								shell.interactiveHover,
								shell.documentTab,
								tab.id === activeTab.id ? shell.documentTabActive : null,
							)}
							type="button"
							role="tab"
							aria-selected={tab.id === activeTab.id}
							onClick={() => onSelect(tab.id)}
						>
							<span>{tab.title}</span>
							<X size={13} onClick={(event) => {
								event.stopPropagation();
								onClose(tab.id);
							}} />
						</button>
					))}
				</div>
				<button {...stylex.props(shell.controlBase, shell.interactiveHover, shell.iconButton)} type="button" onClick={onCloseAll} aria-label="Close app panel">
					<X size={15} />
				</button>
			</header>
			<iframe {...stylex.props(shell.documentFrame)} src={activeTab.route} title={activeTab.title} />
		</aside>
	);
}

function openAppInShell(input: { mode: AppPanelMode; route: string; title: string }) {
	window.dispatchEvent(new CustomEvent("enchiridion:open-app", { detail: input }));
}

function primaryRouteForExtension(extension: ExtensionManifest): string {
	const preferred = extension.routes.find((route) => route.mode === "worker-page")
		?? extension.routes.find((route) => route.path.startsWith(`/apps/${extension.slug}`))
		?? extension.routes[0];
	return preferred?.path ?? `/apps/${extension.slug}`;
}

function CommandPalette({
	commands,
	query,
	selectedIndex,
	onQuery,
	onSelectedIndex,
	onClose,
	onRun,
}: {
	commands: ExtensionCommand[];
	query: string;
	selectedIndex: number;
	onQuery: (value: string) => void;
	onSelectedIndex: (index: number) => void;
	onClose: () => void;
	onRun: (command: ExtensionCommand) => void;
}) {
	const runSelected = () => {
		const selected = commands[Math.min(selectedIndex, commands.length - 1)];
		if (selected) {
			onRun(selected);
		}
	};

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
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								onClose();
								return;
							}
							if (event.key === "ArrowDown") {
								event.preventDefault();
								onSelectedIndex(commands.length === 0 ? 0 : (selectedIndex + 1) % commands.length);
								return;
							}
							if (event.key === "ArrowUp") {
								event.preventDefault();
								onSelectedIndex(commands.length === 0 ? 0 : (selectedIndex - 1 + commands.length) % commands.length);
								return;
							}
							if (event.key === "Enter") {
								event.preventDefault();
								runSelected();
							}
						}}
						placeholder="Run a command"
					/>
				</div>
				<div {...stylex.props(shell.paletteList)}>
					{commands.length === 0 ? (
						<div {...stylex.props(shell.slashEmpty)}>No matching commands</div>
					) : commands.map((command, index) => (
						<button
							{...stylex.props(
								shell.controlBase,
								shell.interactiveHover,
								shell.paletteButton,
								index === selectedIndex ? shell.paletteButtonActive : null,
							)}
							key={`${command.app}-${command.id}`}
							type="button"
							aria-current={index === selectedIndex ? "true" : undefined}
							onMouseEnter={() => onSelectedIndex(index)}
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

function emitSlashMenuState(view: EditorView) {
	if (typeof window === "undefined") {
		return;
	}
	window.dispatchEvent(new CustomEvent(slashStateEvent, {
		detail: readSlashMenuState(view),
	}));
}

function readSlashMenuState(view: EditorView): SlashMenuState | null {
	const range = findSlashRange(view.state);
	if (!range) {
		return null;
	}
	const coords = view.coordsAtPos(range.from);
	return {
		...range,
		top: coords.bottom + 6,
		left: coords.left,
	};
}

function findSlashRange(state: EditorState): (SlashRange & { query: string }) | null {
	const { selection } = state;
	if (!selection.empty) {
		return null;
	}
	const $from = selection.$from;
	const textBefore = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
	const slashIndex = textBefore.lastIndexOf("/");
	if (slashIndex < 0) {
		return null;
	}
	if (slashIndex > 0 && !/\s/.test(textBefore.charAt(slashIndex - 1))) {
		return null;
	}
	const query = textBefore.slice(slashIndex + 1);
	if (query.includes("\n") || query.length > 80) {
		return null;
	}
	return {
		from: $from.pos - query.length - 1,
		to: $from.pos,
		query,
	};
}

function isSlashMenuKey(key: string): key is SlashCommandKeyEvent["detail"]["key"] {
	return key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === "Escape";
}

function isAgentRequestMode(value: unknown): value is AgentRequestMode {
	return value === "ask" || value === "build" || value === "update";
}

function promoteBlockToDocumentBody(
	editor: ReactNodeViewProps["editor"],
	getPos: ReactNodeViewProps["getPos"],
	nodeSize: number,
	text: string,
) {
	const position = getPos();
	if (typeof position !== "number") {
		return;
	}
	editor.chain().focus().insertContentAt({
		from: position,
		to: position + nodeSize,
	}, textToTiptapBlocks(text)).run();
}

function insertFollowUpRequestAfterBlock(
	editor: ReactNodeViewProps["editor"],
	getPos: ReactNodeViewProps["getPos"],
	nodeSize: number,
	contextPrompt: unknown,
	contextResponse: string,
) {
	const position = getPos();
	if (typeof position !== "number") {
		return;
	}
	editor.chain().focus().insertContentAt(position + nodeSize, {
		type: "extensionBlock",
		attrs: {
			app: "agent",
			block: "request-input",
			version: "0.1.0",
			props: {
				id: createClientId(),
				actionLabel: "Ask follow-up",
				contextPrompt: typeof contextPrompt === "string" ? contextPrompt : "",
				contextResponse,
				mode: "ask",
				placeholder: "Ask a follow-up...",
				status: "draft",
				summary: "This request includes the previous prompt and response as context.",
				title: "Follow up",
			},
		},
	}).run();
}

function insertRetryRequestAfterBlock(
	editor: ReactNodeViewProps["editor"],
	getPos: ReactNodeViewProps["getPos"],
	nodeSize: number,
	props: ExtensionBlockProps,
	mode: Exclude<AgentRequestMode, "ask">,
	errorSummary: string,
) {
	const position = getPos();
	if (typeof position !== "number") {
		return;
	}
	const prompt = typeof props.prompt === "string" && props.prompt.trim() ? props.prompt.trim() : "";
	const targetSlug = typeof props.targetSlug === "string" && props.targetSlug.trim() ? props.targetSlug.trim() : "";
	editor.chain().focus().insertContentAt(position + nodeSize, {
		type: "extensionBlock",
		attrs: {
			app: "agent",
			block: "request-input",
			version: "0.1.0",
			props: {
				id: createClientId(),
				actionLabel: mode === "update" ? "Retry update" : "Retry build",
				draftPrompt: prompt,
				mode,
				placeholder: mode === "update" ? "Describe what should change..." : "Describe the mini app to build...",
				status: "draft",
				summary: errorSummary
					? `Previous attempt: ${errorSummary}`
					: "Retry this mini app build.",
				targetSlug: targetSlug || undefined,
				title: mode === "update" ? "Retry mini app update" : "Retry mini app build",
			},
		},
	}).run();
}

function readAgentTargetOptions(value: unknown): AgentTargetOption[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			return [];
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.slug !== "string" || !record.slug.trim()) {
			return [];
		}
		return [{
			name: typeof record.name === "string" && record.name.trim() ? record.name : humanizeSlug(record.slug),
			slug: record.slug,
		}];
	});
}

function readWorkflowRequiredHostApis(payload: JsonObject): string[] {
	const value = payload.requiredHostApis;
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function auditStatusStyle(status: string) {
	const tone = auditToneForStatus(status);
	if (tone === "success") {
		return shell.auditStatusSuccess;
	}
	if (tone === "warning") {
		return shell.auditStatusWarning;
	}
	if (tone === "danger") {
		return shell.auditStatusDanger;
	}
	return null;
}

function formatBindingType(type: ExtensionBindingRequest["bindings"][number]["type"]): string {
	if (type === "kv_namespace") {
		return "KV";
	}
	if (type === "d1_database") {
		return "D1";
	}
	return "R2";
}

function formatWorkflowTimestamp(value: string | null): string {
	if (!value) {
		return "Never";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat("en-GB", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC",
	}).format(date);
}

function readAdmonitionKind(value: unknown): AdmonitionKind {
	return typeof value === "string" && (admonitionKinds as readonly string[]).includes(value)
		? value as AdmonitionKind
		: "info";
}

async function fetchMiniAppBuild(buildId: string): Promise<MiniAppBuildRecord> {
	const response = await fetch(`/api/mini-app-builds/${encodeURIComponent(buildId)}`);
	const body = await readJsonBody<Partial<MiniAppBuildRecord> & { error?: unknown }>(response);
	if (!response.ok) {
		throw new Error(formatMiniAppBuildError(body.error, `Mini app build ${buildId} could not be loaded.`));
	}

	if (
		typeof body.id !== "string"
		|| body.id !== buildId
		|| !isMiniAppBuildStatus(body.status)
		|| typeof body.deadlineAt !== "string"
	) {
		throw new Error(`Mini app build ${buildId} returned invalid build metadata.`);
	}

	return {
		attemptCount: Number(body.attemptCount ?? 0),
		autonomousDeploy: body.autonomousDeploy ?? true,
		completedAt: typeof body.completedAt === "string" ? body.completedAt : null,
		createdAt: typeof body.createdAt === "string" ? body.createdAt : "",
		currentRunId: typeof body.currentRunId === "string" ? body.currentRunId : null,
		deadlineAt: body.deadlineAt,
		error: body.error ?? null,
		id: body.id,
		maxAttempts: Number(body.maxAttempts ?? 3),
		operation: body.operation === "update" ? "update" : "create",
		prompt: typeof body.prompt === "string" ? body.prompt : "",
		result: body.result ?? null,
		status: body.status,
		targetSlug: typeof body.targetSlug === "string" ? body.targetSlug : null,
		slugHint: typeof body.slugHint === "string" ? body.slugHint : null,
		updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : "",
	};
}

function formatMiniAppBuildProgress(build: MiniAppBuildRecord): string {
	const attempt = Math.max(build.attemptCount, 1);
	const deadline = formatBuildDeadline(build.deadlineAt);
	if (build.status === "interrupted") {
		return `Interrupted during attempt ${attempt}. Enchiridion will re-admit the durable builder while the build is before ${deadline}.`;
	}
	if (build.currentRunId) {
		return `Attempt ${attempt}/${build.maxAttempts} is running as durable builder submission ${build.currentRunId}. Deadline ${deadline}.`;
	}
	return `Queued for attempt ${attempt}/${build.maxAttempts}. Deadline ${deadline}.`;
}

function formatBuildDeadline(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(date);
}

function findPendingMiniAppBuildRuns(documentJson: JsonObject): PendingMiniAppBuildRun[] {
	const pending: PendingMiniAppBuildRun[] = [];

	visitTiptapNodes(documentJson, (node) => {
		if (node.type !== "extensionBlock") {
			return;
		}

		const attrs = asRecord(node.attrs);
		const props = asExtensionBlockProps(attrs.props);
		if (
			props.status !== "running"
			|| props.workflowName !== generateMiniAppWorkflowName
			|| typeof props.id !== "string"
			|| typeof props.buildId !== "string"
			|| !props.buildId.trim()
		) {
			return;
		}

		pending.push({
			buildId: props.buildId,
			blockId: props.id,
			intent: {
				operation: readMiniAppOperation(props.operation),
				shouldBuild: true,
				...(typeof props.slugHint === "string" && props.slugHint.trim() ? { slugHint: props.slugHint } : {}),
				...(typeof props.targetSlug === "string" && props.targetSlug.trim() ? { targetSlug: props.targetSlug } : {}),
			},
			prompt: typeof props.prompt === "string" ? props.prompt : "",
			runId: typeof props.runId === "string" && props.runId.trim() ? props.runId : undefined,
		});
	});

	return pending;
}

function visitTiptapNodes(value: unknown, visitor: (node: Record<string, unknown>) => void) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return;
	}

	const node = value as Record<string, unknown>;
	visitor(node);
	if (!Array.isArray(node.content)) {
		return;
	}

	for (const child of node.content) {
		visitTiptapNodes(child, visitor);
	}
}

function isMiniAppBuildStatus(value: unknown): value is MiniAppBuildStatus {
	return value === "pending"
		|| value === "running"
		|| value === "interrupted"
		|| value === "completed"
		|| value === "failed"
		|| value === "expired";
}

function readMiniAppOperation(value: unknown): MiniAppOperation {
	return value === "update" ? "update" : "create";
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function asExtensionBlockProps(value: unknown): ExtensionBlockProps {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as ExtensionBlockProps;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function createClientId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function humanizeSlug(value: string): string {
	return value
		.split(/[-_]/g)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ") || "Mini app";
}

function titleForExtensionRoute(app: string, fallback: string): string {
	if (app === "agent") {
		return fallback;
	}
	return humanizeSlug(app);
}

function normalizeSearch(value: string): string {
	return value.trim().toLowerCase();
}

function splitTags(value: string): string[] {
	return Array.from(new Set(value
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean)));
}

function readPinnedApps(): string[] {
	if (typeof window === "undefined") {
		return [];
	}
	try {
		const raw = window.localStorage.getItem("enchiridion:pinned-mini-apps");
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

function writePinnedApps(slugs: string[]) {
	if (typeof window === "undefined") {
		return;
	}
	window.localStorage.setItem("enchiridion:pinned-mini-apps", JSON.stringify(slugs));
}

import { evictDurableObject } from "cloudflare:test";
import * as Schema from "effect/Schema";
import {
	LoroDoc,
	LoroList,
	LoroMap,
	LoroText,
	VersionVector,
} from "loro-crdt/bundler";
import { describe, expect, it } from "vitest";
import {
	CommitLoroPageContentInput,
	CommitLoroPageContentOutput,
	CreateLoroPageInput,
	CreateLoroPageOutput,
	CreateNodeInput,
	CreateWorkspaceInput,
	CreateWorkspaceOutput,
	CreationIntent,
	HumanUiMutationAttribution,
	ListStandupPublicationsInput,
	ListStandupPublicationsOutput,
	LoroMutationIntentV1,
	StartLoroPageSyncInput,
	StartLoroPageSyncOutput,
	canonicalStandupPublicationText,
	type EntityId,
} from "@athenaeum/domain";
import {
	STANDUP_PRIVATE_GRANT_VERSION,
	STANDUP_PRIVATE_REQUEST_VERSION,
	canonicalDailyNoteIdForCivilDate,
	resolvePrivatePublicationIntent,
	type OpaqueStandupRunGrantToken,
	type StandupPublicationPrivateIntentV1,
	type StandupRunGrantResolver,
} from "../src/standup-publication-private-contract.js";
import {
	InMemoryStandupPublicationAuthorityStore,
	type PreparedStandupCompanionPage,
	type StandupPublicationAuthorityRequestV1,
	type StandupPublicationCompanionAdapter,
	type StandupPublicationCompanionLinkV1,
	type StandupPublicationCompanionPageV1,
	type StandupPublicationEventV1,
	type StandupPublicationGrantConsumptionV1,
	type StandupPublicationOutboxIntentV1,
	type StandupPublicationRecordV1,
} from "../src/standup-publication-collections.js";
import { StandupPublicationService } from "../src/standup-publication-service-live.js";
import {
	connectToWorkspace,
	connectToWorkspaceAsTestUser,
	connectToWorkspaceWithSocketAs,
	connectToUserAs,
	devSignIn,
	freshWorkspaceId,
	rejectionToDomainError,
	workspaceDurableObjectStub,
} from "./support.js";

const civilDate = "2026-08-29";
const prosemirrorRoot = "athenaeum-prosemirror-v1";

type PublicationFixture = Readonly<{
	readonly intent: StandupPublicationPrivateIntentV1;
	readonly grantConsumption: StandupPublicationGrantConsumptionV1;
	readonly publication: StandupPublicationRecordV1;
	readonly companionPage: StandupPublicationCompanionPageV1;
	readonly companion: StandupPublicationCompanionLinkV1;
	readonly request: StandupPublicationAuthorityRequestV1;
	readonly event: StandupPublicationEventV1;
	readonly outbox: StandupPublicationOutboxIntentV1;
}>;

type DebugStandupPublicationStageResult =
	| Readonly<{ status: "staged" }>
	| Readonly<{ status: "rejected"; message: string }>;

type NativeStandupPublicationHarness = Readonly<{
	debugStageStandupPublication: (
		input: Omit<PublicationFixture, "intent"> & Readonly<{ failAt?: string }>,
	) => Promise<DebugStandupPublicationStageResult>;
}>;

type WorkspaceStub = Awaited<ReturnType<typeof connectToWorkspace>>;

const humanAttribution = () =>
	new HumanUiMutationAttribution({
		version: "athenaeum.mutation-attribution.v1",
		kind: "humanUi",
		surface: "rich-text-editor",
	});

const asNativeHarness = (
	workspaceId: EntityId,
): NativeStandupPublicationHarness =>
	workspaceDurableObjectStub(
		workspaceId,
	) as unknown as NativeStandupPublicationHarness;

const stageInput = (fixture: PublicationFixture, failAt?: string) => {
	const { intent: _intent, ...staged } = fixture;
	return failAt === undefined ? staged : { ...staged, failAt };
};

const expectStaged = (result: DebugStandupPublicationStageResult): void => {
	expect(result).toEqual({ status: "staged" });
};

const expectStageRejected = (
	result: DebugStandupPublicationStageResult,
	message: string,
): void => {
	expect(result).toEqual({
		status: "rejected",
		message: expect.stringContaining(message),
	});
};

const only = <T>(record: Record<string, T>, label: string): T => {
	const values = Object.values(record);
	if (values.length !== 1 || values[0] === undefined)
		throw new Error(`expected one ${label}`);
	return values[0];
};

const companionAdapter = (): StandupPublicationCompanionAdapter => ({
	prepare: ({ childNodeId, originalText, originalTextDigest }) => {
		const canonical = canonicalStandupPublicationText(originalText);
		return {
			format: "loro-v1",
			childNodeId,
			originalTextDigest,
			preparedDescriptor: `loro:${originalTextDigest}`,
			contentUtf8: originalText,
			contentDigest: canonical.sha256,
			contentByteLength: canonical.byteLength,
		};
	},
	restore: ({ link, page }) => ({
		format: "loro-v1",
		childNodeId: link.childNodeId,
		originalTextDigest: link.originalTextDigest,
		preparedDescriptor: link.preparedDescriptor,
		contentUtf8: page.contentUtf8,
		contentDigest: page.contentDigest,
		contentByteLength: page.contentByteLength,
	}),
	publishAfterCommit: (_prepared: PreparedStandupCompanionPage) => undefined,
});

const makeFixture = (
	workspaceId: EntityId,
	options: Readonly<{
		originalText?: string;
		runId?: string;
		occurrenceId?: string;
		grantId?: string;
	}> = {},
): PublicationFixture => {
	const dailyNoteId = canonicalDailyNoteIdForCivilDate(civilDate);
	const originalText =
		options.originalText ?? "Reviewed the daily workforce priorities.";
	const rawGrant = {
		version: STANDUP_PRIVATE_GRANT_VERSION,
		issuerId: "test-workforce-issuer",
		grantId:
			options.grantId ??
			`grant:${options.runId ?? "run-1"}:${options.occurrenceId ?? "occurrence-1"}`,
		grantRecordVersion: "1",
		workspaceId,
		civilDate,
		dailyNoteId,
		runIdentityVersion: "workforce-run-v1",
		microEmployee: { kind: "microEmployee", id: "executive", version: "v1" },
		job: { kind: "job", id: "daily-standup", version: "v1" },
		workflow: { kind: "workflow", id: "morning-review", version: "v1" },
		schedule: { kind: "schedule", id: "weekdays", version: "v1" },
		councilRefs: [{ kind: "council", id: "operations", version: "v1" }],
		runId: options.runId ?? "run-1",
		occurrenceId: options.occurrenceId ?? "occurrence-1",
		microEmployeeLabel: "Executive",
		jobLabel: "Daily standup",
		workflowLabel: "Morning review",
		scheduleLabel: "Weekdays",
		subject: "system:workforce-scheduler",
		replayAudience: `system:workforce-scheduler:${workspaceId}`,
		actorKind: "system" as const,
		authorityGeneration: "generation-1",
		revocationId: "revocation-set-1",
		revocationGeneration: "1",
		policyVersion: "workforce-policy-v1",
		issuedAt: "2026-08-29T08:00:00.000Z",
		expiresAt: "2026-08-29T09:00:00.000Z",
		oneUseBudget: 1 as const,
	};
	const request = { version: STANDUP_PRIVATE_REQUEST_VERSION, originalText };
	const grantToken = {} as OpaqueStandupRunGrantToken;
	const resolver: StandupRunGrantResolver = {
		resolve: (candidate) => (candidate === grantToken ? rawGrant : undefined),
		recheckFresh: () => ({ status: "admitted" }),
	};
	const store = new InMemoryStandupPublicationAuthorityStore();
	const service = new StandupPublicationService({
		resolver,
		store,
		companion: companionAdapter(),
		clock: { now: () => "2026-08-29T08:30:00.000Z" },
	});
	service.publish(grantToken, request);
	const intent = resolvePrivatePublicationIntent(rawGrant, request);
	const state = store.snapshot();
	return Object.freeze({
		intent,
		grantConsumption: only(state.grantConsumptionsById, "grant consumption"),
		publication: only(state.publicationsById, "publication"),
		companionPage: only(state.companionPagesByPublication, "companion page"),
		companion: only(state.companionsByPublication, "companion link"),
		request: only(state.requestsBySlot, "authority request"),
		event: only(state.eventsById, "event"),
		outbox: only(state.outboxById, "outbox intent"),
	});
};

const publicInput = (workspaceId: EntityId, dailyNoteId: string) =>
	Schema.encodeSync(ListStandupPublicationsInput)(
		new ListStandupPublicationsInput({ workspaceId, dailyNoteId }),
	);

const listPublications = async (
	stub: WorkspaceStub,
	workspaceId: EntityId,
	dailyNoteId: string,
) =>
	Schema.decodeUnknownSync(ListStandupPublicationsOutput)(
		await stub.listStandupPublications(publicInput(workspaceId, dailyNoteId)),
	);

const seedLoroPage = async (
	stub: WorkspaceStub,
	workspaceId: EntityId,
	nodeId: string,
	text: string,
): Promise<void> => {
	await stub.createNode(
		Schema.encodeSync(CreateNodeInput)(
			new CreateNodeInput({
				workspaceId,
				id: nodeId as EntityId,
				title: "Published workforce standup",
			}),
		),
	);
	const created = Schema.decodeUnknownSync(CreateLoroPageOutput)(
		await stub.createLoroPage(
			Schema.encodeSync(CreateLoroPageInput)(
				new CreateLoroPageInput({
					workspaceId,
					nodeId: nodeId as EntityId,
					creationIntent: new CreationIntent({
						requestId: crypto.randomUUID(),
						commitMessage: "Create workforce standup companion",
						attribution: humanAttribution(),
					}),
				}),
			),
		),
	);
	if (
		created.descriptor.activeFormat !== "loro-v1" ||
		created.descriptor.loro === undefined
	) {
		throw new Error("expected a newly created Loro page");
	}
	const started = Schema.decodeUnknownSync(StartLoroPageSyncOutput)(
		await stub.startLoroPageSync(
			Schema.encodeSync(StartLoroPageSyncInput)(
				new StartLoroPageSyncInput({
					workspaceId,
					nodeId: nodeId as EntityId,
					sessionId: crypto.randomUUID(),
				}),
			),
		),
	);
	const document = new LoroDoc();
	document.import(started.message);
	const children = document.getMap(prosemirrorRoot).get("children");
	if (!(children instanceof LoroList))
		throw new Error("missing Loro root children");
	const paragraph = children.get(0);
	if (!(paragraph instanceof LoroMap))
		throw new Error("missing Loro paragraph");
	const paragraphChildren = paragraph.get("children");
	if (!(paragraphChildren instanceof LoroList))
		throw new Error("missing Loro paragraph children");
	const leaf = paragraphChildren.get(0);
	if (!(leaf instanceof LoroText)) throw new Error("missing Loro text leaf");
	leaf.insert(0, text);
	document.commit();
	Schema.decodeUnknownSync(CommitLoroPageContentOutput)(
		await stub.commitLoroPageContent(
			Schema.encodeSync(CommitLoroPageContentInput)(
				new CommitLoroPageContentInput({
					workspaceId,
					nodeId: nodeId as EntityId,
					intent: new LoroMutationIntentV1({
						requestId: crypto.randomUUID(),
						commitMessage: "Seed workforce standup companion content",
						attribution: humanAttribution(),
					}),
					expectedStorageVersion: created.descriptor.storageVersion,
					expectedSnapshotSha256: created.descriptor.loro.snapshotSha256,
					expectedVersionVector: started.serverVersion,
					update: document.export({
						mode: "update",
						from: VersionVector.decode(started.serverVersion),
					}),
				}),
			),
		),
	);
};

const createGovernedWorkspace = async (): Promise<
	Readonly<{ workspaceId: EntityId; credential: string }>
> => {
	const { credential } = await devSignIn(
		`standup-publication-owner-${crypto.randomUUID()}@example.com`,
	);
	const user = await connectToUserAs(credential);
	try {
		const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
			await user.stub.createWorkspace(
				Schema.encodeSync(CreateWorkspaceInput)(
					new CreateWorkspaceInput({ title: "Governed standup publication" }),
				),
			),
		);
		return { workspaceId: created.workspace.workspaceId, credential };
	} finally {
		user.stub[Symbol.dispose]();
		user.socket.close();
	}
};

describe.sequential("durable standup publication authority adapter", () => {
	it("rolls back all seven durable stages and permits the same bundle to be staged once afterward", async () => {
		const stages = [
			"grant-consumption",
			"publication",
			"companion-page",
			"companion",
			"receipt",
			"event",
			"outbox",
		] as const;
		for (const failAt of stages) {
			const workspaceId = freshWorkspaceId();
			const fixture = makeFixture(workspaceId, {
				runId: `rollback-${failAt}`,
				occurrenceId: `occurrence-${failAt}`,
			});
			const native = asNativeHarness(workspaceId);
			expectStageRejected(
				await native.debugStageStandupPublication(stageInput(fixture, failAt)),
				`fixture failure at ${failAt}`,
			);

			// Reaching the final insert with the exact same seven keys proves that every previous
			// staged row (including grant consumption) rolled back with the native SQL transaction.
			expectStaged(
				await native.debugStageStandupPublication(stageInput(fixture)),
			);
			expectStageRejected(
				await native.debugStageStandupPublication(stageInput(fixture)),
				"UNIQUE constraint failed",
			);
		}
	});

	it("reconstructs the durable bundle after eviction and projects the live Loro companion status", async () => {
		const workspaceId = freshWorkspaceId();
		const fixture = makeFixture(workspaceId);
		let stub = await connectToWorkspaceAsTestUser(workspaceId);
		try {
			await seedLoroPage(
				stub,
				workspaceId,
				fixture.intent.childNodeId,
				fixture.intent.originalText,
			);
			expectStaged(
				await asNativeHarness(workspaceId).debugStageStandupPublication(
					stageInput(fixture),
				),
			);

			const beforeEviction = await listPublications(
				stub,
				workspaceId,
				fixture.intent.grant.dailyNoteId,
			);
			expect(beforeEviction.publications).toEqual([
				expect.objectContaining({
					id: fixture.intent.publicationId,
					civilDate,
					childNodeId: fixture.intent.childNodeId,
					originalText: fixture.intent.originalText,
					microEmployeeLabel: "Executive",
					jobLabel: "Daily standup",
					companionStatus: "verified-original",
				}),
			]);

			stub[Symbol.dispose]();
			await evictDurableObject(workspaceDurableObjectStub(workspaceId));
			stub = await connectToWorkspaceAsTestUser(workspaceId);
			const afterEviction = await listPublications(
				stub,
				workspaceId,
				fixture.intent.grant.dailyNoteId,
			);
			expect(afterEviction).toEqual(beforeEviction);
		} finally {
			stub[Symbol.dispose]();
		}
	});

	it("projects modified and missing companions through the real RPC, without cross-workspace leakage", async () => {
		const modifiedWorkspaceId = freshWorkspaceId();
		const modifiedFixture = makeFixture(modifiedWorkspaceId, {
			originalText: "Original workforce report.",
			runId: "modified-run",
			occurrenceId: "modified-occurrence",
		});
		const modifiedStub =
			await connectToWorkspaceAsTestUser(modifiedWorkspaceId);
		try {
			await seedLoroPage(
				modifiedStub,
				modifiedWorkspaceId,
				modifiedFixture.intent.childNodeId,
				"A collaborator changed this report.",
			);
			expectStaged(
				await asNativeHarness(modifiedWorkspaceId).debugStageStandupPublication(
					stageInput(modifiedFixture),
				),
			);
			const modified = await listPublications(
				modifiedStub,
				modifiedWorkspaceId,
				modifiedFixture.intent.grant.dailyNoteId,
			);
			expect(modified.publications).toHaveLength(1);
			expect(modified.publications[0]?.companionStatus).toBe("modified");

			const missingWorkspaceId = freshWorkspaceId();
			const missingFixture = makeFixture(missingWorkspaceId, {
				runId: "missing-run",
				occurrenceId: "missing-occurrence",
			});
			expectStaged(
				await asNativeHarness(missingWorkspaceId).debugStageStandupPublication(
					stageInput(missingFixture),
				),
			);
			const missingStub =
				await connectToWorkspaceAsTestUser(missingWorkspaceId);
			const isolatedWorkspaceId = freshWorkspaceId();
			const isolatedStub =
				await connectToWorkspaceAsTestUser(isolatedWorkspaceId);
			try {
				const missing = await listPublications(
					missingStub,
					missingWorkspaceId,
					missingFixture.intent.grant.dailyNoteId,
				);
				expect(missing.publications).toHaveLength(1);
				expect(missing.publications[0]?.companionStatus).toBe("missing");

				const isolated = await listPublications(
					isolatedStub,
					isolatedWorkspaceId,
					modifiedFixture.intent.grant.dailyNoteId,
				);
				expect(isolated.publications).toEqual([]);
			} finally {
				isolatedStub[Symbol.dispose]();
				missingStub[Symbol.dispose]();
			}
		} finally {
			modifiedStub[Symbol.dispose]();
		}
	});

	it("requires a current governed-workspace member for the public projection", async () => {
		const { workspaceId, credential } = await createGovernedWorkspace();
		const fixture = makeFixture(workspaceId, {
			runId: "governed-run",
			occurrenceId: "governed-occurrence",
		});
		expectStaged(
			await asNativeHarness(workspaceId).debugStageStandupPublication(
				stageInput(fixture),
			),
		);
		const owner = await connectToWorkspaceWithSocketAs(workspaceId, credential);
		const anonymous = await connectToWorkspace(workspaceId);
		try {
			const ownerProjection = await listPublications(
				owner.stub,
				workspaceId,
				fixture.intent.grant.dailyNoteId,
			);
			expect(ownerProjection.publications).toHaveLength(1);
			expect(ownerProjection.publications[0]?.companionStatus).toBe("missing");

			const denied = await rejectionToDomainError(
				anonymous.listStandupPublications(
					publicInput(workspaceId, fixture.intent.grant.dailyNoteId),
				),
			);
			expect(denied._tag).toBe("Unauthorized");
		} finally {
			anonymous[Symbol.dispose]();
			owner.stub[Symbol.dispose]();
			owner.socket.close();
		}
	});

	it("fails closed rather than projecting cross-record civil-date, descriptor, or receipt-output corruption", async () => {
		const cases = [
			{
				name: "civil date",
				mutate: (fixture: PublicationFixture) => ({
					...fixture,
					companion: { ...fixture.companion, civilDate: "2026-08-30" },
				}),
			},
			{
				name: "prepared descriptor",
				mutate: (fixture: PublicationFixture) => ({
					...fixture,
					companion: {
						...fixture.companion,
						preparedDescriptor: "loro:substituted-descriptor",
					},
				}),
			},
			{
				name: "receipt output",
				mutate: (fixture: PublicationFixture) => ({
					...fixture,
					request: {
						...fixture.request,
						receipt: {
							...fixture.request.receipt,
							output: {
								...fixture.request.receipt.output,
								publicationId: crypto.randomUUID(),
							},
						},
					},
				}),
			},
		] as const;

		for (const { name, mutate } of cases) {
			const workspaceId = freshWorkspaceId();
			const fixture = makeFixture(workspaceId, {
				runId: `corrupt-${name}`,
				occurrenceId: `corrupt-${name}`,
			});
			const candidate = mutate(fixture);
			const native = asNativeHarness(workspaceId);
			const authenticated = await connectToWorkspaceAsTestUser(workspaceId);
			try {
				expectStaged(
					await native.debugStageStandupPublication(stageInput(candidate)),
				);
				const failure = await rejectionToDomainError(
					authenticated.listStandupPublications(
						publicInput(workspaceId, fixture.intent.grant.dailyNoteId),
					),
				);
				expect(failure._tag).toBe("UnexpectedError");
			} finally {
				authenticated[Symbol.dispose]();
			}
		}
	});
});

import type { ApiContext, IntegrationSchema } from "../../api/src/context.ts";

export const documentsGraphql: IntegrationSchema = {
	typeDefs: `
  scalar NoteDocument
  extend type User { document(id: ID!): Document documentFeed(prefix: String!, limit: Int = 50): [DocumentSummary!]! entityBacklinks(entityId: ID!, limit: Int = 50): [DocumentBacklink!]! }
  type Document { id: ID! note: NoteDocument! revision: Int! createdAt: String! updatedAt: String! }
  type DocumentSummary { id: ID! revision: Int! createdAt: String! updatedAt: String! }
  type DocumentBacklink { id: ID! entityId: ID! revision: Int! createdAt: String! updatedAt: String! }
 `,
	fields: {
		"User.document": async (_source, args, context: ApiContext) => {
			context.consume();
			if (!context.env.DOCUMENTS_ADMIN) {
				throw new Error("Documents are not configured.");
			}
			using documents = await context.env.DOCUMENTS_ADMIN.admin(
				context.identity.ownerId,
			);
			return await documents.get(String(args.id));
		},
		"User.documentFeed": async (_source, args, context: ApiContext) => {
			context.consume();
			if (!context.env.DOCUMENTS_ADMIN) {
				throw new Error("Documents are not configured.");
			}
			const prefix = String(args.prefix);
			if (
				prefix !== "capture:" &&
				!/^event(?:-series)?:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+){1,2}:$/.test(
					prefix,
				)
			) {
				throw new Error("Only event and capture document feeds are available.");
			}
			using documents = await context.env.DOCUMENTS_ADMIN.admin(
				context.identity.ownerId,
			);
			return await documents.list(prefix, Number(args.limit ?? 50));
		},
		"User.entityBacklinks": async (_source, args, context: ApiContext) => {
			context.consume();
			if (!context.env.DOCUMENTS_ADMIN) {
				throw new Error("Documents are not configured.");
			}
			const requestedId = String(args.entityId);
			let entityIds: readonly string[] = [requestedId];
			if (context.env.ENTITIES_ADMIN) {
				using entities = await context.env.ENTITIES_ADMIN.admin(
					context.identity.ownerId,
				);
				const entity = await entities.getEntity(requestedId);
				if (entity) entityIds = entity.mergedEntityIds;
			}
			using documents = await context.env.DOCUMENTS_ADMIN.admin(
				context.identity.ownerId,
			);
			return await documents.backlinks(
				entityIds,
				Number(args.limit ?? 50),
			);
		},
	},
};

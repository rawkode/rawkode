import {
	buildSchema,
	defaultFieldResolver,
	type GraphQLFieldResolver,
} from "graphql";
import type { ApiContext, IntegrationSchema } from "./context.ts";

export const composeSchema = (modules: readonly IntegrationSchema[]) => {
	const schema = buildSchema(
		`type Query { me: User! } type User { id: ID! email: String! } type Today { id: ID! date: String! from: String! to: String! } extend type User { today(date: String!, from: String, to: String): Today! }\n${
			modules.map((module) => module.typeDefs).join("\n")
		}`,
	);
	const fields = Object.assign(
		{},
		...modules.map((module) => module.fields),
	) as IntegrationSchema["fields"];
	const fieldResolver: GraphQLFieldResolver<unknown, ApiContext> = (
		source,
		args,
		context,
		info,
	) => {
		if (info.parentType.name === "Query" && info.fieldName === "me") {
			return { id: context.identity.ownerId, email: context.identity.email };
		}
		const resolver = fields[`${info.parentType.name}.${info.fieldName}`];
		return resolver
			? resolver(source, args, context)
			: defaultFieldResolver(source, args, context, info);
	};
	return { schema, fieldResolver };
};

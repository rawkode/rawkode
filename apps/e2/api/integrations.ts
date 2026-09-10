import { todayGraphql } from "./src/today.ts";
import { documentsGraphql } from "../core/documents/graphql.ts";
import { googleGraphql } from "../integrations/google/graphql.ts";
import { githubGraphql } from "../integrations/github/graphql.ts";

/** Deployment composition: each integration owns its schema and resolvers. */
export const integrations = [
	todayGraphql,
	documentsGraphql,
	googleGraphql,
	githubGraphql,
];

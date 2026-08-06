import * as AST from "effect/SchemaAST";
import {
  DeviceIDSchema,
  SHA256DigestSchema,
  SignedRequestHeaderValueSchema,
  httpOperations,
  protocolSchemaDefinitions,
  protocolVersion,
  supportedProtocolVersions,
  websocketContract,
} from "./contracts";

/** Canonical JSON avoids artifact churn across Node/Bun versions. */
export function stableJSONStringify(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSONStringify).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("Protocol artifacts may only contain JSON values.");
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJSONStringify(child)}`)
    .join(",")}}`;
}

function refinementBase(value: AST.AST): {
  readonly base: AST.AST;
  readonly refinements: readonly AST.Refinement[];
} {
  const refinements: AST.Refinement[] = [];
  let base = value;
  while (AST.isRefinement(base)) {
    refinements.push(base);
    base = base.from;
  }
  return { base, refinements };
}

function withAnnotations(output: object, refinements: readonly AST.Refinement[]): object {
  for (const refinement of [...refinements].reverse()) {
    const annotation = refinement.annotations[AST.JSONSchemaAnnotationId];
    if (annotation !== null && typeof annotation === "object" && !Array.isArray(annotation))
      Object.assign(output, annotation);
  }
  return output;
}

/** Converts the actual Effect Schema AST into its wire JSON Schema projection. */
export function openAPISchema(schema: { readonly ast: AST.AST }): object {
  const { base, refinements } = refinementBase(schema.ast);
  let output: object;
  if (AST.isStringKeyword(base)) output = { type: "string" };
  else if (AST.isNumberKeyword(base)) output = { type: "number" };
  else if (AST.isBooleanKeyword(base)) output = { type: "boolean" };
  else if (AST.isLiteral(base)) output = { const: base.literal };
  else if (AST.isTupleType(base))
    output = {
      type: "array",
      items: base.rest[0] === undefined ? {} : openAPISchemaFromAST(base.rest[0].type),
    };
  else if (AST.isTypeLiteral(base)) {
    const properties: Record<string, object> = {};
    const required: string[] = [];
    for (const property of base.propertySignatures) {
      if (typeof property.name !== "string") continue;
      properties[property.name] = openAPISchemaFromAST(property.type);
      if (!property.isOptional) required.push(property.name);
    }
    output = {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length === 0 ? {} : { required }),
    };
  } else if (AST.isUnion(base)) {
    const types = base.types.filter((member) => !AST.isUndefinedKeyword(member));
    if (types.every(AST.isLiteral)) output = { enum: types.map((member) => member.literal) };
    else if (types.length === 1 && types[0] !== undefined) output = openAPISchemaFromAST(types[0]);
    else output = { oneOf: types.map(openAPISchemaFromAST) };
  } else throw new TypeError(`Unsupported Effect Schema AST node: ${base._tag}`);
  return withAnnotations(output, refinements);
}

function openAPISchemaFromAST(schemaAST: AST.AST): object {
  return openAPISchema({ ast: schemaAST });
}

export const openAPISchemas = Object.fromEntries(
  Object.entries(protocolSchemaDefinitions).map(([name, schema]) => [name, openAPISchema(schema)]),
);

export const openAPIV2 = {
  openapi: "3.1.0",
  info: { title: "Enchiridion Protocol", version: `v${protocolVersion}` },
  paths: httpOperations.reduce<Record<string, Record<string, object>>>((paths, operation) => {
    const parameterSchema = operation.path.includes("{deviceId}")
      ? DeviceIDSchema
      : operation.path.includes("{sha256}")
        ? SHA256DigestSchema
        : undefined;
    const parameterName = operation.path.includes("{deviceId}") ? "deviceId" : "sha256";
    const pathParameter =
      parameterSchema === undefined
        ? []
        : [
            {
              name: parameterName,
              in: "path",
              required: true,
              description:
                "RFC 3986 URI-component encoded exactly once; only ASCII unreserved characters remain literal.",
              schema: openAPISchema(parameterSchema),
            },
          ];
    const signedRequestHeaderParameter =
      operation.signedRequestHeader === true
        ? [
            {
              name: "Enchiridion-Signed-Request",
              in: "header",
              required: true,
              description:
                "Exactly one case-insensitive canonical base64url signed-device envelope, bounded to 8192 encoded characters.",
              schema: openAPISchema(SignedRequestHeaderValueSchema),
            },
          ]
        : [];
    const requestContent =
      operation.body === "binary"
        ? { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
        : operation.body === "none"
          ? undefined
          : {
              "application/json": {
                schema: { $ref: `#/components/schemas/${operation.requestSchema}` },
              },
            };
    const operationDefinition = {
      operationId: operation.operationID,
      ...(pathParameter.length === 0 && signedRequestHeaderParameter.length === 0
        ? {}
        : { parameters: [...pathParameter, ...signedRequestHeaderParameter] }),
      responses: {
        "200": {
          description: "Success",
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${operation.successSchema}` },
            },
          },
        },
        "400": {
          description: "Stable protocol error",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } },
          },
        },
        "401": {
          description: "Stable protocol error",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } },
          },
        },
        "409": {
          description: "Stable protocol error",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } },
          },
        },
        "426": {
          description: "Version negotiation failed",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } },
          },
        },
      },
      ...(requestContent === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: requestContent,
            },
          }),
      ...(operation.body === "binary"
        ? {
            "x-enchiridion-signed-envelope":
              "SignedDeviceRequestEnvelope; bodySHA256 is SHA-256 of exact octets and equals path {sha256}.",
          }
        : {}),
    };
    paths[operation.path] = {
      ...paths[operation.path],
      [operation.method.toLowerCase()]: operationDefinition,
    };
    return paths;
  }, {}),
  components: { schemas: openAPISchemas },
} as const;

export const protocolManifestV2 = {
  protocolVersion,
  supportedProtocolVersions,
  httpOperations,
  schemas: openAPISchemas,
  websocket: websocketContract,
  errorEnvelope: { schema: "ErrorEnvelope", mediaType: "application/json" },
} as const;

/** Testable projection seam: replacement still passes through the canonical AST projector. */
export function protocolManifestWithSchemaOverride(
  name: string,
  schema: { readonly ast: AST.AST },
): object {
  return {
    ...protocolManifestV2,
    schemas: { ...openAPISchemas, [name]: openAPISchema(schema) },
  };
}
function formattedArtifact(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stableJSONStringify(value)), null, 2)}\n`;
}
export function openAPIArtifact(): string {
  return formattedArtifact(openAPIV2);
}
export function protocolManifestArtifact(): string {
  return formattedArtifact(protocolManifestV2);
}

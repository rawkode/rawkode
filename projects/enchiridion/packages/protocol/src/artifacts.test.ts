import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";
import {
  openAPIArtifact,
  openAPISchema,
  openAPISchemas,
  protocolManifestArtifact,
  protocolManifestV2,
  protocolManifestWithSchemaOverride,
} from "./artifacts";
import {
  DeviceRegisterRequestSchema,
  DeviceRegisterRequestShapeSchema,
  SignedRequestHeaderValueSchema,
  errorCodes,
  protocolSchemaDefinitions,
  signedRequestHeaderName,
} from "./contracts";
import { generatedSwiftAPI, generatedSwiftModel } from "./swift";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("generated protocol artifacts", () => {
  test("checked-in OpenAPI, manifest, and Swift client are deterministic", async () => {
    const openAPI = JSON.parse(
      await readFile(resolve(packageRoot, "artifacts/openapi.v2.json"), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "artifacts/protocol.v2.json"), "utf8"),
    );
    expect(openAPI).toEqual(JSON.parse(openAPIArtifact()));
    expect(manifest).toEqual(JSON.parse(protocolManifestArtifact()));
    await expect(
      readFile(resolve(packageRoot, "generated/swift/EnchiridionProtocol.swift"), "utf8"),
    ).resolves.toBe(generatedSwiftAPI());
  });

  test("OpenAPI preserves the Effect error-code enumeration", () => {
    expect(JSON.stringify(openAPISchemas.ErrorEnvelope)).toContain(JSON.stringify(errorCodes));
  });

  test("OpenAPI and manifest expose the explicit low-S P-256 signature profile", () => {
    expect(JSON.stringify(openAPISchemas.DeviceChallengeProof)).toContain("p256-ecdsa-der-low-s");
    expect(JSON.stringify(protocolManifestV2.schemas.DeviceChallengeProof)).toContain(
      "p256-ecdsa-der-low-s",
    );
    expect(generatedSwiftAPI()).toContain("p256HalfOrder");
  });

  test("OpenAPI requires the bounded canonical signed-envelope header for raw blobs", () => {
    const openAPI = JSON.parse(openAPIArtifact());
    const expected = {
      name: signedRequestHeaderName,
      in: "header",
      required: true,
      description:
        "Exactly one case-insensitive canonical base64url signed-device envelope, bounded to 8192 encoded characters.",
      schema: openAPISchema(SignedRequestHeaderValueSchema),
    };
    for (const method of ["put", "delete"])
      expect(openAPI.paths["/v2/blobs/{sha256}"][method].parameters).toContainEqual(expected);
  });

  test("a canonical registry schema mutation changes every generated boundary", () => {
    expect(protocolSchemaDefinitions.DeviceRegisterRequest).toBe(DeviceRegisterRequestSchema);
    const changed = DeviceRegisterRequestShapeSchema.pipe(Schema.omit("idempotencyKey"));
    const originalOpenAPI = openAPISchemas.DeviceRegisterRequest;
    const changedOpenAPI = openAPISchema(changed);
    const changedManifest = protocolManifestWithSchemaOverride("DeviceRegisterRequest", changed);
    const originalSwift = generatedSwiftModel("DeviceRegisterRequest", DeviceRegisterRequestSchema);
    const changedSwift = generatedSwiftModel("DeviceRegisterRequest", changed);
    expect(changedOpenAPI).not.toEqual(originalOpenAPI);
    expect(changedManifest).not.toEqual(protocolManifestV2);
    expect(changedSwift).not.toEqual(originalSwift);
    expect(generatedSwiftAPI()).toContain(originalSwift);
  });
});

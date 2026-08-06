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
  errorCodes,
  protocolSchemaDefinitions,
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

  test("a canonical registry schema mutation changes every generated boundary", () => {
    expect(protocolSchemaDefinitions.DeviceRegisterRequest).toBe(DeviceRegisterRequestSchema);
    const changed = DeviceRegisterRequestShapeSchema.pipe(Schema.omit("challengeAudience"));
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

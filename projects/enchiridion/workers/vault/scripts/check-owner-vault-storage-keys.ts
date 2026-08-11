import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { unregisteredOwnerVaultStorageKeys } from "../src/v2/owner-vault/storage-key-check";

const root = "src/v2/owner-vault";
const files = [...new Glob("**/*.ts").scanSync(root)].filter((path) => !path.endsWith(".test.ts"));
const failures = files.flatMap((relative) => {
  const path = `${root}/${relative}`;
  const keys = unregisteredOwnerVaultStorageKeys(readFileSync(path, "utf8"));
  return keys.map((key) => `${path}: unregistered OwnerVault storage key ${JSON.stringify(key)}`);
});
if (failures.length > 0) throw new Error(failures.join("\n"));

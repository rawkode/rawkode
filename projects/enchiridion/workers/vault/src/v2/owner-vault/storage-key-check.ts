import { ownerVaultStorageDefinitionForKey } from "./storage-registry";

/**
 * A deliberately small source gate for the future physical repository.  Raw
 * literal storage keys are permitted only when the registry recognizes them;
 * dynamic keys must be constructed by a registry definition and are therefore
 * not matchable as literals here.
 */
export const unregisteredOwnerVaultStorageKeys = (source: string): readonly string[] => {
  const failures: string[] = [];
  const expression = /\bstorage\s*\.\s*(?:get|put|delete)\s*\(\s*(["'])([^"']+)\1/gu;
  for (const match of source.matchAll(expression)) {
    const key = match[2];
    if (key === undefined) continue;
    try {
      ownerVaultStorageDefinitionForKey(key);
    } catch {
      failures.push(key);
    }
  }
  return failures;
};

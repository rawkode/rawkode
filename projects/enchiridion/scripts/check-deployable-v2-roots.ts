export const deployableTypeScriptRoots = [
  { path: "packages/runtime", packageName: "@enchiridion/runtime" },
  { path: "packages/protocol", packageName: "@enchiridion/protocol" },
  {
    path: "workers/vault",
    sourcePath: "src/v2",
    packageName: "@enchiridion/worker-vault",
  },
] as const;

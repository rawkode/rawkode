export default defineModule("podman")
  .description("Container runtime")
  .tags(["terminal", "development"])
  .when(not(commandExists("podman")))
  .actions([
    executeCommand({
      command: "bash",
      args: ["-c", 'echo "rawkode:524288:65536" | sudo tee -a /etc/subuid'],
      escalate: true,
    }),
    executeCommand({
      command: "bash",
      args: ["-c", 'echo "rawkode:524288:65536" | sudo tee -a /etc/subgid'],
      escalate: true,
    }),
    packageInstall({
      names: ["podman"],
    }),
  ]);

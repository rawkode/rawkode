export default defineModule("github")
  .description("GitHub CLI and configuration")
  .tags(["terminal", "development"])
  .dependsOn(["podman", "onepassword"])
  .actions([
    packageInstall({
      names: ["github-cli"],
    }),
    linkFile({
      target: "github.nu",
      source: "nushell/autoload/github.nu",
      force: true,
    }),
    linkFile({
      target: "mcp.container",
      source: "~/.config/containers/systemd/github-mcp.container",
      force: true,
    }),
    skipIf(
      executeCommand({
        command: "bash",
        args: [
          "-c",
          'echo "$GITHUB_TOKEN" | podman secret create github-token -',
        ],
        environment: {
          GITHUB_TOKEN: "op://Private/GitHub/api-tokens/mcp",
        },
      }),
      [commandSucceeds("podman", ["secret", "exists", "github-token"])],
    ),
    executeCommand({
      command: "bash",
      args: [
        "-c",
        "mkdir -p ~/.config/systemd/user && /usr/lib/systemd/system-generators/podman-system-generator --user ~/.config/systemd/user",
      ],
    }),
    executeCommand({
      command: "systemctl",
      args: ["--user", "daemon-reload"],
    }),
    systemdManage({
      name: "github-mcp.service",
      operation: "enable",
      scope: "user",
    }),
  ]);

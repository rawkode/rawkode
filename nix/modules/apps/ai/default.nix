{
  flake.homeModules.ai =
    { inputs, pkgs, ... }:
    {
      home.packages =
        with inputs;
        pkgs.lib.optionals pkgs.stdenv.isLinux [
          pkgs.code-cursor-fhs

          nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.codex
          nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.cursor-agent
          nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.gemini-cli
          nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.qwen-code
        ];

      programs.fish.shellAbbrs = {
        codex = {
          position = "command";
          setCursor = true;
          expansion = "codex --search --full-auto";
        };
      };
    };

  # Darwin-specific AI tools (Homebrew casks)
  flake.darwinModules.ai =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [
          "chatgpt"
          "claude-code"
          "codex"
          "cursor"
          "cursor-cli"
        ];
      };
    };
}

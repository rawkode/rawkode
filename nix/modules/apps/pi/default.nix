{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "pi";

  common.home = _: {
    home.file = {
      ".pi/AGENTS.md".source = ./AGENTS.md;

      ".pi/agent/settings.json".source = ./settings.json;
      ".pi/agent/workflows.yaml".source = ./workflows.yaml;

      ".pi/agent/extensions" = {
        source = ./extensions;
        force = true;
      };
      ".pi/agent/agents" = {
        source = ./agents;
        force = true;
      };
      ".pi/agent/skills" = {
        source = ./skills;
        force = true;
      };
    };
  };
}

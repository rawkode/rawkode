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

      ".pi/agent/extensions/modes/index.ts".source = ./extensions/modes/index.ts;
      ".pi/agent/extensions/modes/package.json".source = ./extensions/modes/package.json;

      ".pi/agent/extensions/subagent/index.ts".source = ./extensions/subagent/index.ts;
      ".pi/agent/extensions/subagent/agents.ts".source = ./extensions/subagent/agents.ts;

      ".pi/agent/agents/council-claude.md".source = ./agents/council-claude.md;
      ".pi/agent/agents/council-google.md".source = ./agents/council-google.md;
      ".pi/agent/agents/council-openai.md".source = ./agents/council-openai.md;

      ".pi/agent/skills/comma-dns/SKILL.md".source = ./skills/comma-dns/SKILL.md;
      ".pi/agent/skills/comma-dns/lookup.sh" = {
        source = ./skills/comma-dns/lookup.sh;
        executable = true;
      };

      ".pi/agent/skills/nixpkgs-search/SKILL.md".source = ./skills/nixpkgs-search/SKILL.md;
      ".pi/agent/skills/nixpkgs-search/search.sh" = {
        source = ./skills/nixpkgs-search/search.sh;
        executable = true;
      };
    };
  };
}

{
  flake.homeModules.nushell = {
    programs.nushell = {
      enable = true;

      configFile.source = ./nushell/config.nu;

      shellAliases = {
        ai = ''GEMINI_API_KEY="op://Private/Google Gemini/password" op run --account my.1password.eu -- aichat'';
        ghb = "cd ~/Code/src/github.com";
      };

      environmentVariables = {
        NIX_LINK = ''"/nix/var/nix/profiles/default"'';
        NIX_PROFILES = ''"/nix/var/nix/profiles/default ($env.NIX_LINK)"'';
        OP_PLUGIN_ALIASES_SOURCED = "1";
        PATH = "($env.PATH | split row (char esep) | prepend $'($env.HOME)/.nix-profile/bin' | append $'($env.NIX_LINK)/bin')";
        SSH_AUTH_SOCK = ''"($env.HOME | path join '1password' 'agent.sock')"'';
      };

      extraConfig = ''
        source /home/rawkode/.config/nushell/auto-ls.nu
      '';
    };

    xdg.configFile."nushell/auto-ls.nu".source = ./nushell/auto-ls.nu;
  };
}

{
  programs.nushell = {
    enable = true;

		shellAliases = {
			ghb = "cd ~/Code/src/github.com";
			ai = "op run --account my.1password.eu -- aichat";
		};

    environmentVariables = {
      GEMINI_API_KEY = ''"op://Private/Google Gemini/password"'';
			NIX_LINK = ''"/nix/var/nix/profiles/default"'';
			NIX_PROFILES = ''"/nix/var/nix/profiles/default ($env.NIX_LINK)"'';
			PATH = "($env.PATH | split row (char esep) | prepend $'($env.HOME)/.nix-profile/bin' | append $'($env.NIX_LINK)/bin')";
      SSH_AUTH_SOCK = ''"($env.HOME | path join '1password' 'agent.sock')"'';
    };
  };
}

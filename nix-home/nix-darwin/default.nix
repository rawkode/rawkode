{ overlays, pkgs }:

{
  fonts = {
    fontDir.enable = true;
    fonts = with pkgs; [
      monaspace
    ];
  };

  nixpkgs = {
    config = {
      allowBroken = true;
      allowUnfree = true;
      allowUnsupportedSystem = true;
    };
    inherit overlays;
  };

  nix = {
    package = pkgs.nix;
    gc = {
      automatic = true;
      interval.Day = 7;
      options = "--delete-older-than 7d";
    };
    extraOptions = ''
      auto-optimise-store = true
      experimental-features = nix-command flakes
    '';
  };

  security.pam.enableSudoTouchIdAuth = true;
  services.nix-daemon.enable = true;

	homebrew = {
		enable = true;
		casks = [
			"1password"
			"1password-cli"
			"alt-tab"
			"arc"
			"bartender"
			"descript"
			"discord"
			"docker"
			"fantastical"
			"mimestream"
			"raycast"
			"slack"
			"visual-studio-code-insiders"
			"warp"
			"wezterm"
		];
	};

  users.users.${pkgs.username} = {
    name = pkgs.username;
    home = pkgs.homeDirectory;
    shell = pkgs.nushell;
  };

  environment = {
    shells = with pkgs; [ nushell ];
    systemPackages = with pkgs; [
      nushell
      zellij
    ];
    variables = { };
  };

  system = import ./macos.nix { inherit pkgs; }
    // {
    activationScripts.postActivation.text = ''sudo chsh -s ${pkgs.nushell}/bin/nu'';
  };

}

{ pkgs, ... }: {
  home.packages = with pkgs; [
    carapace
    fish
  ];

  programs = {
    carapace = {
      enable = true;
    };

    nushell = {
      enable = true;

      shellAliases = {
        k = "kubectl";
      };

      configFile.source = ./config/config.nu;
      envFile.source = ./config/env.nu;

      extraConfig = ''
        source ~/.cache/carapace/init.nu
      '';

      extraEnv = ''
        $env.PATH = (
        	$env.PATH
        	| split row (char esep)
        	| prepend $"${pkgs.wezterm}/Applications/WezTerm.app/Contents/MacOS"
        )

        mkdir ~/.cache/carapace
        carapace _carapace nushell | save --force ~/.cache/carapace/init.nu
      '';
    };
  };
}

{ pkgs, ... }: {
  home = {
    packages = with pkgs;
      [
        wezterm
      ];
  };

  xdg.configFile = {
    wezterm.source = ./config;
  };

  programs.nushell.extraEnv = ''
    $env.PATH = (
    	$env.PATH
    	| split row (char esep)
    	| prepend $"${pkgs.wezterm}/Applications/WezTerm.app/Contents/MacOS"
    )
  '';
}

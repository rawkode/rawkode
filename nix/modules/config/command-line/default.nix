{
  flake.homeModules.command-line =
    { inputs, ... }:
    {
      imports = with inputs.self.homeModules; [
        atuin
        bat
        btop
        carapace
        comma
        cue
        direnv
        eza
        fish
        git
        github
        google-cloud
        helix
        htop
        jj
        jq
        just
        lazyjournal
        misc
        nushell
        ripgrep
        starship
        television
        zellij
        zoxide
      ];
    };
}

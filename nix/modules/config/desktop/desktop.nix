{
  flake.homeModules.desktop =
    { inputs, ... }:
    {
      imports = with inputs.self.homeModules; [
        alacritty
        clickup
        dconf-editor
        flatpak
        ghostty
        niri
        onepassword
        ptyxis
        rquickshare
        slack
        spotify
        tana
        visual-studio-code
        wayland
        wezterm
        zed
        zoom
        zulip
      ];
    };
}

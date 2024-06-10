{ inputs, ... }:
{
  programs.ghostty = {
    enable = true;
    package = inputs.ghostty.packages.x86_64-linux.default;
    settings = {
      theme = "catppuccin-macchiato";
      font-family = "Monaspace Neon";
      font-size = 16;
      cursor-style = "bar";
      gtk-single-instance = true;
      window-decoration = false;
      window-vsync = true;
      window-padding-x = 4;
      window-padding-y = 4;
      confirm-close-surface = false;
    };
  };
}

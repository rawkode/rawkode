{ inputs, ... }:
{
  programs.ghostty = {
    enable = true;
    package = inputs.ghostty.packages.x86_64-linux.default;
    settings = {
      theme = "catppuccin-macchiato";
      font-family = "Monaspace Neon";
      font-size = 24;
      cursor-style = "bar";

      command = "zellij";

      gtk-single-instance = true;
      window-decoration = false;
      window-vsync = true;
      window-padding-x = 8;
      window-padding-y = 8;

      confirm-close-surface = false;
    };
  };
}

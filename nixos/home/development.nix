{ config, pkgs, ... }:

{
  imports = [
    ./development/containers.nix
    ./development/git.nix
    ./development/vscode.nix
  ];

  programs.zoxide = {
    enable = true;
    enableFishIntegration = true;
  };

  programs.zellij = {
    enable = true;

    settings = {
      default_mode = "normal";
      default_layout = "compact";
      simplified_ui = true;
      ui = {
        pane_frames = {
          hide_session_name = true;
        };
      };
    };
  };

  home.packages = (
    with pkgs;
    [
      rustup
      wezterm
      zed-editor
      zellij
    ]
  );
}

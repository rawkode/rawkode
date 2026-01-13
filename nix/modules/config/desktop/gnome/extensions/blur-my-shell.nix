{
  flake.homeModules.gnome-blur-my-shell =
    { pkgs, ... }:
    {
      programs.gnome-shell.extensions = with pkgs.gnomeExtensions; [
        {
          package = blur-my-shell;
        }
      ];
    };
}

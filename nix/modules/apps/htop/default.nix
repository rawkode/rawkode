{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "htop";

  common.home =
    { pkgs, lib, ... }:
    {
      programs.htop = {
        enable = true;
        package = lib.mkDefault pkgs.htop-vim;

        settings = {
          tree_view = true;
          hide_userland_threads = true;
          highlight_changes = true;
          show_cpu_frequency = true;
          show_cpu_temperature = true;
          highlight_base_name = true;

          show_program_path = false;
        };
      };
    };
}

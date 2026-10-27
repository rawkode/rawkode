{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "antarctical";

  linux.home = {
    imports = [ inputs.antarctical.homeModules.default ];

    programs.antarctical = {
      enable = true;
      service.enable = true;
      # Serves Dux's calendar over the dankcal socket and adds the next-event widget.
      dux = {
        enable = true;
        # modules/linux/dux already makes Dux's settings.json Home Manager-managed.
        setCalendarBackend = true;
      };
    };
  };
}

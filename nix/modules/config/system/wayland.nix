{
  flake.nixosModules.wayland = _: {
    environment.sessionVariables = {
      NIXOS_OZONE_WL = "1";
      QT_QPA_PLATFORM = "wayland";
    };
  };

  flake.homeModules.wayland =
    {
      pkgs,
      ...
    }:
    {
      home.sessionVariables = {
        ELECTRON_OZONE_PLATFORM_HINT = "auto";
      };

      home.packages = with pkgs; [
        wl-clipboard
      ];
    };
}

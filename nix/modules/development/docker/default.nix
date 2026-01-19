_: {
  flake.nixosModules.development-docker =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        docker-client
        docker-compose
      ];

      xdg.configFile."docker/config.json".text = ''
        {
          "auths": {},
          "credsStore": "secretservice"
        }
      '';
    };

  flake.darwinModules.docker =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "docker-desktop" ];
      };
    };
}

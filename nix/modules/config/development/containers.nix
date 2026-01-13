{
  flake.nixosModules.containers =
    { pkgs, ... }:
    {
      virtualisation = {
        containers = {
          enable = true;
        };

        # I keep trying podman, but
        # there are too many problems.
        docker.enable = true;
        podman.enable = true;
      };

      environment.systemPackages = with pkgs; [
        dive
        docker-compose
        podman-tui
      ];
    };
}

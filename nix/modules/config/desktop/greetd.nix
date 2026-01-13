{
  flake.nixosModules.greetd =
    { pkgs, ... }:
    {
      services.greetd = {
        enable = true;
        settings = {
          default_session = {
            command = "${pkgs.tuigreet}/bin/tuigreet --time --remember --remember-user-session --asterisks --cmd niri-session";
            user = "greeter";
          };
        };
      };

      users.users.greeter = {
        isSystemUser = true;
        group = "greeter";
      };

      users.groups.greeter = { };

      environment.etc."greetd/environments".text = ''
        niri-session
        fish
      '';
    };
}

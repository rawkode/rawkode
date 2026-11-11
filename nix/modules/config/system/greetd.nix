{ inputs, ... }:
{
  flake.nixosModules.greetd =
    { config, lib, ... }:
    {
      imports = [ inputs.noctalia-greeter.nixosModules.default ];

      # Enables greetd and lists every session registered through
      # services.displayManager.sessionPackages (Umbriel).
      services.displayManager.noctalia-greeter = {
        enable = true;
        # Lets each login user's shell push its wallpaper and palette to the
        # login screen without an administrator prompt.
        passwordless-sync-users = lib.attrNames (lib.filterAttrs (_: u: u.isNormalUser) config.users.users);
      };

      services.greetd.settings.default_session.user = "greeter";

      users.users.greeter = {
        isSystemUser = true;
        group = "greeter";
      };

      users.groups.greeter = { };
    };
}

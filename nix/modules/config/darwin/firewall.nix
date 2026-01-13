{
  flake.darwinModules.firewall =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.firewall;
    in
    {
      options.rawkOS.darwin.firewall = {
        enable = lib.mkEnableOption "macOS application firewall";

        stealthMode = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable stealth mode (don't respond to ICMP ping requests or connection attempts)";
        };

        blockAllIncoming = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Block all incoming connections except those required for basic internet services";
        };

        allowSigned = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Allow built-in signed applications to receive incoming connections automatically";
        };

        allowSignedApp = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Allow downloaded signed applications to receive incoming connections automatically";
        };

        logging = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Enable firewall logging";
        };
      };

      config = lib.mkIf cfg.enable {
        networking.applicationFirewall = {
          enable = true;
          enableStealthMode = cfg.stealthMode;
          blockAllIncoming = cfg.blockAllIncoming;
          allowSigned = cfg.allowSigned;
          allowSignedApp = cfg.allowSignedApp;
        };
      };
    };
}

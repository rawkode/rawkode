{
  flake.nixosModules.tpm2 =
    { config, pkgs, ... }:
    let
      cfg = config.rawkOS.user;
    in
    {
      environment.systemPackages = with pkgs; [
        tpm2-pkcs11
        tpm2-tools
        tpm2-tss
      ];

      programs.ssh.agentPKCS11Whitelist = "${config.security.tpm2.pkcs11.package}/lib/libtpm_pkcs11.so";

      security = {
        tpm2 = {
          enable = true;

          pkcs11 = {
            enable = true;
            package = pkgs.tpm2-pkcs11.override { fapiSupport = false; };
          };

          abrmd.enable = true;

          tctiEnvironment = {
            enable = true;
            interface = "tabrmd";
          };
        };
      };

      users.users.${cfg.username} = {
        extraGroups = [ "tss" ];
      };
    };
}

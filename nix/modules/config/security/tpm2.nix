{
  flake.nixosModules.tpm2 =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      userCfg = config.rawkOS.user;
      cfg = config.rawkOS.tpm2;
    in
    {
      options.rawkOS.tpm2.enable = lib.mkEnableOption "TPM2 user tooling and SSH integration" // {
        default = true;
      };

      config = lib.mkIf cfg.enable {
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

        users.users.${userCfg.username} = {
          extraGroups = [ "tss" ];
        };
      };
    };
}

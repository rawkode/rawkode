{ lib, pkgs, ... }:
{
  services.espanso.enable = true;
  systemd.user.services.espanso.serviceConfig.ExecStart =
    lib.mkForce "${pkgs.espanso-wayland}/bin/espanso worker";

  # I'd love for this to live in home-manager,
  # but espanso on wayland needs this additional
  # capability
  security.wrappers.espanso = {
    source = "${pkgs.espanso-wayland}/bin/espanso";
    capabilities = "cap_dac_override+p";
    owner = "root";
    group = "root";
  };

  services.udev.extraRules = ''
    KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput", GROUP="input", MODE="0660"
  '';
}

{ pkgs, ... }:
{
  environment.systemPackages = with pkgs; [
    (vivaldi.override {
      isSnapshot = true;
      mesa = pkgs.mesa;
    })
  ];

  environment.etc = {
    "1password/custom_allowed_browsers" = {
      text = ''
        vivaldi-bin
      '';
      mode = "0755";
    };
  };
}

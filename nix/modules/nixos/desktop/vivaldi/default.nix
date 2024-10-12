{ pkgs, ... }:
{
  environment.systemPackages = with pkgs; [
    (vivaldi.override {
      isSnapshot = true;
      mesa = pkgs.mesa;
    })
  ];
}

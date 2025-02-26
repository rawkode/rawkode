{ pkgs, ... }:
{
  services.kmscon = {
    enable = true;
    hwRender = true;
    useXkbConfig = true;
    fonts = [
      {
        name = "Monaspace Argon";
        package = pkgs.monaspace;
      }
    ];
    extraConfig = ''
      font-size=24
    '';
  };
}

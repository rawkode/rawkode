{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "kubernetes";

  common.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      home.packages = with pkgs; [
        kubectl
        kubernetes-helm
        kubectx
        stern
        kubecolor
        kustomize
      ];

      programs.bash.shellAliases = lib.mkIf config.programs.bash.enable {
        k = "kubectl";
        kctx = "kubectx";
        kns = "kubens";
      };

      programs.fish.shellAliases = lib.mkIf config.programs.fish.enable {
        k = "kubectl";
        kctx = "kubectx";
        kns = "kubens";
      };

      programs.zsh.shellAliases = lib.mkIf config.programs.zsh.enable {
        k = "kubectl";
        kctx = "kubectx";
        kns = "kubens";
      };

      home.file.".kube/.keep".text = "";
    };
}

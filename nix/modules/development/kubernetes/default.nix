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
      };

      programs.fish.shellAbbrs = lib.mkIf config.programs.fish.enable {
        kns = {
          expansion = "kubectl config set-context --current --namespace=%";
          position = "command";
          setCursor = true;
        };
      };

      programs.zsh.shellAliases = lib.mkIf config.programs.zsh.enable {
        k = "kubectl";
        kctx = "kubectx";
        kns = "kubens";
      };

      home.file.".kube/.keep".text = "";
    };
}

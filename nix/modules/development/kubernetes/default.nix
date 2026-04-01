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
    let
      kubectlKrew = pkgs.symlinkJoin {
        name = "kubectl-krew";
        paths = [ pkgs.krew ];
        postBuild = ''
          ln -s $out/bin/krew $out/bin/kubectl-krew
        '';
      };
    in
    {
      home.packages = with pkgs; [
        kubectl
        kubectlKrew
        kubernetes-helm
        kubectx
        stern
        kubecolor
        kustomize
      ];

      home.sessionPath = [
        "${config.home.homeDirectory}/.krew/bin"
      ];

      programs.bash.shellAliases = lib.mkIf config.programs.bash.enable {
        k = "kubectl";
        kctx = "kubectx";
        kns = "kubens";
      };

      programs.fish.interactiveShellInit = lib.mkIf config.programs.fish.enable ''
        set -q KREW_ROOT; and set -gx PATH $PATH $KREW_ROOT/.krew/bin; or set -gx PATH $PATH $HOME/.krew/bin
      '';

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

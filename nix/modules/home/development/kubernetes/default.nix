{ config, lib, pkgs, ... }:
{
  home.packages = with pkgs; [
    kubectl
    kubernetes-helm
    k9s
    kubectx
    stern
    kubecolor
    kubernetes-helm
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
}

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.kubernetes;
in
{
  options.programs.kubernetes = {
    enable = lib.mkEnableOption "Kubernetes development tools";
    
    includeHelm = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to include Helm package manager";
    };
    
    includeKustomize = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to include Kustomize";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = with pkgs; lib.mkMerge [
      [
        kubectl
        kubernetes-helm
        k9s
        kubectx
        stern
        kubecolor
      ]
      (lib.mkIf cfg.includeHelm [ kubernetes-helm ])
      (lib.mkIf cfg.includeKustomize [ kustomize ])
    ];

    # kubectl aliases
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

    # kubectl configuration directory
    home.file.".kube/.keep".text = "";
  };
}
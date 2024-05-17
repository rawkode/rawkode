{ config, pkgs, ... }:

{
  home.packages = (with pkgs; [
    containerd
    kind
    kubectl
    kubernetes-helm
    podman
    runc
  ]);
}

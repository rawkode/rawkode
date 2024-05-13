{ config, pkgs, ... }:

{
  home.packages = (with pkgs; [
    containerd
    docker_compose
    kind
    kubectl
    kubernetes-helm
    podman
    runc
  ]);
}

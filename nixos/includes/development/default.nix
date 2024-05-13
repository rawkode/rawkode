{ config, pkgs, ... }:

{
  imports =
    [
      ./containers.nix
      ./git.nix
      ./vscode.nix
    ];

  nixpkgs.config = {
    android_sdk = {
      accept_license = true;
    };
  };

  home.packages = (with pkgs; [
    # Crystal
    crystal
    shards

    # Dart
    dart

    # Flutter
    # flutter

    # Go
    go

    # Google Cloud
    google-cloud-sdk

    # JavaScript
    nodejs
    yarn

    # Pony
    ponyc
    pony-stable

    # Pulumi
    pulumi-bin

    # Python
    pipenv
    python
    pythonPackages.virtualenv

    # Rust
    rustup

    # Terraform
    terraform_0_12
  ]);
}

#!/usr/bin/env sh
mkdir -p $HOME/.config/nixpkgs

if ! [ -x "$(command -v home-manager)" ]; then
    nix-channel --add https://nixos.org/channels/nixpkgs-unstable nixpkgs
    nix-channel --add https://github.com/rycee/home-manager/archive/master.tar.gz home-manager
    nix-channel --update

    nix-shell '<home-manager>' -A install
fi

if [[ ! -d $HOME/.zplug ]]; then
    export ZPLUG_HOME=$HOME/.zplug
    git clone https://github.com/zplug/zplug $ZPLUG_HOME
fi

cp ./rawkode.nix $HOME/.config/nixpkgs/home.nix
cp -R includes $HOME/.config/nixpkgs/

nix-channel --update

home-manager switch

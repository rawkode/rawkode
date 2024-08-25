{ config, pkgs, lib, ... }:

with lib;
with lib.internal;
{
  snowfallorg.user.enable = true;
  home.stateVersion = "23.05";

  # mimics top-level environment.etc
  puppet.enable = true;

  united = {
    system = {
      acpi-handler.enable = true;
      auto-cpufreq.enable = true;
      fstrim.enable = true;
      sysctl.enable = true;
    };

    cli = {
      bat.enable = true;
      fish.enable = true;
      inxi.enable = true;
      just.enable = true;
      kitty.enable = true;
      ranger.enable = true;
      starship.enable = true;

      nix = {
        enable = true;
        pinInputs = true;
        setupComma = true;
      };

      git = {
        enable = true;
        user = "Animesh Sahu";
        email = "animeshsahu19@yahoo.com";
        signingkey = "541C03D55917185E";
      };
    };

    editors = {
      nvim.enable = true;

      emacs = {
        enable = true;
        config = "https://github.com/Animeshz/.emacs.d";
      };
    };

    apps = {
      brave.enable = true;
    };

    languages = {
      android.enable = true;
      go.enable = true;
      ruby.enable = true;
    };

    desktop = {
      herbstluftwm.enable = true;
      eww.enable = true;

      gtk.enable = true;

      fonts = with pkgs; [
        (nerdfonts.override { fonts = [ "CascadiaCode" ]; })
        noto-fonts
        noto-fonts-emoji
        unifont
        custom.phosphor-icons
      ];

      xorg = {
        enable = true;
        hidpi.enable = true;
        scale = 1.5;
        cursorSize = 50;
        autoRepeat.delay = 300;
        autoRepeat.rate = 50;

        installOnHost = true;
        wallpaper = ./wallpaper.jpg;
      };
    };
  };

  # direct home-manager modules
  programs = {
    bash = {
      enable = true;
      enableCompletion = true;
    };

    zoxide = {
      enable = true;
      enableBashIntegration = true;
      enableFishIntegration = true;
    };
  };

  # General packages which require zero-to-no configurations
  # They _are_ general and not project-specific
  home.packages = with pkgs; [
    # archives
    p7zip

    # monitoring
    btop
    du-dust
    tree

    # utils
    fd
    ffmpeg
    maim
    moreutils
    ripgrep
    wget
    xclip

    # extras
    nushell
    pandoc
    xdg-utils
    rofi
  ];

  xdg.mimeApps = {
    enable = true;
    defaultApplications = {
      "application/pdf" = "brave-browser.desktop";
      "inode/directory" = "ranger.desktop";
      "text/plain" = "emacs.desktop";
      "x-scheme-handler/http" = "brave-browser.desktop";
      "x-scheme-handler/https" = "brave-browser.desktop";
      "x-scheme-handler/mailto" = "brave-browser.desktop";
      "x-scheme-handler/unknown" = "brave-browser.desktop";
      "x-scheme-handler/element" = "element-desktop.desktop";
      "x-scheme-handler/irc" = "element-desktop.desktop";
      "x-scheme-handler/logseq" = "logseq.desktop";
    };
    # TODO: do sth about default browser and xorg, fish module cleanup
  };
}

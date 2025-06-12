#!/usr/bin/env nu
niri msg action do-screen-transition;
gsettings set org.gnome.desktop.interface color-scheme 'prefer-light'
notify-send --app-name="darkman" --urgency=low --icon=weather-clear-night "switching to light mode"

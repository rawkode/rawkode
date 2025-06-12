#!/usr/bin/env bash

# Update Zellij config to use dark theme
# Zellij doesn't support runtime theme switching, so we need to update the config file
sed -i 's/theme "catppuccin-latte"/theme "catppuccin-macchiato"/' "$HOME/.config/zellij/config.kdl"

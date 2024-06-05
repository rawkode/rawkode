{ ... }:

{
  programs.nixvim = {
    enable = true;
    defaultEditor = true;
    vimdiffAlias = true;

    globals.mapleader = ",";
    clipboard.providers.wl-copy.enable = true;

    options = {
      number = true;
      relativenumber = true;
      shiftwidth = 2;
    };

    colorschemes.catppuccin.enable = true;
    plugins = {
      airline = {
        enable = true;
        settings = {
          theme = "catppuccin";
        };
      };

      copilot-chat.enable = true;
      copilot-vim.enable = true;
      dressing.enable = true;
      gitblame.enable = true;
      gitgutter.enable = true;
      lightline.enable = true;
      lsp.enable = true;
      lsp-format.enable = true;
      lsp.servers.nixd.enable = true;
      lsp.servers.cssls.enable = true;
      lsp.servers.jsonls.enable = true;
      lsp.servers.lua-ls.enable = true;
      lsp.servers.rust-analyzer.enable = true;
      lsp.servers.rust-analyzer.installCargo = true;
      lsp.servers.rust-analyzer.installRustc = true;
      lsp.servers.tsserver.enable = false;
      lsp.servers.yamlls.enable = true;
      lsp-lines.enable = true;
      lspkind.enable = true;
      neogit.enable = true;
      neo-tree.enable = true;
      nix.enable = true;
      rust-tools.enable = true;

      telescope = {
        enable = true;

        enabledExtensions = [ "ui-select" ];
        extensions.ui-select.enable = true;
        extensions.frecency.enable = false;
        extensions.fzf-native.enable = true;

        extensions.file-browser = {
          enable = true;
          settings.hidden = true;
          settings.depth = 9999999999;
          settings.auto_depth = true;
        };
        keymaps = {
          "<leader>ff" = "find_files";
          "<leader>fs" = "grep_string";
          "<leader>fg" = "live_grep";
        };
        settings = {
          pickers = {
            find_files = {
              hidden = true;
            };
          };
        };
      };

      which-key.enable = true;
    };
  };
}

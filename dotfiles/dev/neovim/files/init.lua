local fn = vim.fn
local install_path = fn.stdpath('data')..'/site/pack/packer/start/packer.nvim'
if fn.empty(fn.glob(install_path)) > 0 then
  packer_bootstrap = fn.system({'git', 'clone', '--depth', '1', 'https://github.com/wbthomason/packer.nvim', install_path})
end

require('plugins')


local map_opts = { noremap = true, silent = true }

vim.cmd('command Update :PackerSync')


vim.g.mapleader = ','
vim.api.nvim_set_keymap('n', '<leader>t', ':NERDTreeToggle<CR>', map_opts)
vim.g['NERDTreeMinimalUI'] = true

vim.api.nvim_set_keymap('n', '<C-p>', ':Telescope find_files<cr>', map_opts)

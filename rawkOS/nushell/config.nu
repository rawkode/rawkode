$env.config = {
  show_banner: false

	use_grid_icons: true
  use_ansi_coloring: true

  # I use Atuin
  history: {
      max_size: 0
  }

  completions: {
      case_sensitive: false
      quick: true
      algorithm: prefix
      partial: true
  }

  rm: {
      always_trash: true
  }

  buffer_editor: [
      "zeditor",
      "--wait",
      "--add"
  ]

  ls: {
      clickable_links: true
  }

  table: {
      mode: "rounded"
  }
}


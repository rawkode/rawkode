source aliases.nu
source open.nu

use starship.nu


let direnv_installed = not (which direnv | is-empty)

$env.config = {
	show_banner: false

	table: {
		mode: compact
		index_mode: auto
	}

	rm: {
		always_trash: true
	}

	hooks: {
    pre_prompt: {
      if not $direnv_installed {
        return
      }

      direnv export json | from json | default {} | load-env
    }
	}
}

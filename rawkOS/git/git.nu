def --env gr [] {
	cd (git rev-parse --show-toplevel)
}

def is-git-repo []: [ nothing -> bool] {
	git rev-parse --is-inside-work-tree out+err> /dev/null
	if ($env.LAST_EXIT_CODE != 0) {
		return false
	}
	return true
}

$env.config = (
		$env.config | update hooks.pre_execution {|config|
			let hook = {||
				if (commandline | is-empty) {
						if (is-git-repo ) {
								git status --short
						}
				}
			}
			if ($config.hooks.pre_execution? | is-empty) {
				[$hook]
			} else {
				$config.hooks.pre_execution | append $hook
			}
		}
)

$env.config = (
		$env.config | update hooks.env_change {|config|
			let hook = {|before, after| if (is-git-repo) { git status --short } }
			if ($config.hooks.env_change? | is-empty) {
				{ PWD: [$hook] }
			} else if ($config.hooks.env_change.PWD? | is-empty) {
				$config.hooks.env_change | insert PWD [$hook]
			} else {
				$config.hooks.env_change | update PWD {|pwd_hooks| $pwd_hooks | append $hook}
			}
		}
)

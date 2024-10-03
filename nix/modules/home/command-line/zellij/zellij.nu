def start_zellij [] {
	if 'ZELLIJ' not-in ($env | columns) {
		$env.ZELLIJ_AUTO_EXIT = true
		zellij attach --create

		if 'ZELLIJ_AUTO_EXIT' in ($env | columns) and $env.ZELLIJ_AUTO_EXIT == true {
			exit
		}
	}
}

$env.config = ($env.config? | default {})
$env.config = ($env.config | upsert hooks {
	env_change: {
		PWD: [{
			code: {|before, after|
				if 'ZELLIJ' in ($env | columns) {
					if ($after == $env.HOME) {
						zellij action rename-tab "~"
					} else {
						zellij action rename-tab (basename $after)
					}
				}
			}
		}]
	}
})

start_zellij

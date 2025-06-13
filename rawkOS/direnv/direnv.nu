$env.config = (
    $env.config | update hooks.pre_prompt {|config|
        let hook = {||
            if (which direnv | is-empty) {
                return
            }
            direnv export json | from json | default {} | load-env
        }
        if ($config.hooks.pre_prompt? | is-empty) {
            [$hook]
        } else {
            $config.hooks.pre_prompt | append $hook
        }
    }
)

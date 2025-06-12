$env.config = (
    $env.config | upsert hooks.pre_prompt [ {||
        if (which direnv | is-empty) {
            return
        }
        direnv export json | from json | default {} | load-env
    }]
)

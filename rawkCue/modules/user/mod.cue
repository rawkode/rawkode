package user

import "github.com/rawkode/rawkcue/schema/helpers"

// Use the user helper to set the default shell
user: (helpers.#User & {opts: {shell: "fish"}}).out

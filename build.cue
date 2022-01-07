package main

import "alpha.dagger.io/dagger"
import "rawkode.dev/svelte:svelte"

src: dagger.#Artifact & dagger.#Input

websites: {
  "opengraph.rawkode.dev": svelte.#Build & {
    src,
    path: "./websites/opengraph.rawkode.dev"
  },
  "rawkode.dev": svelte.#Build & {
    src,
    path: "./websites/rawkode.dev"
  },
}

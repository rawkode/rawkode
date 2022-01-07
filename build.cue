package main

import "alpha.dagger.io/dagger"
import "alpha.dagger.io/os"

import "rawkode.dev/websites/opengraph.rawkode.dev:opengraphrawkodedev"
import "rawkode.dev/websites/rawkode.dev:rawkodedev"

src: dagger.#Artifact & dagger.#Input

websites: {
  "rawkode.dev": rawkodedev.#Build & {
    dir: os.#Dir & {
      from: src,
      path: "websites/opengraph.rawkode.dev"
    }
  },
  "opengraph.rawkode.dev": opengraphrawkodedev.#Build & {
    dir: os.#Dir & {
      from: src,
      path: "websites/opengraph.rawkode.dev"
    }
  },
}

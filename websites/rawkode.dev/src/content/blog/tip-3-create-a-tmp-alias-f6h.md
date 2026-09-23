---
title: "Tip 3: Create a `tmp` Alias"
description: "Nobody ever tells you this, but it's true for everyone ... you'll need to trust me...  There's going..."
pubDate: "2020-01-03T13:35:13Z"
authorName: "David Flanagan"
updatedDate: "2020-01-03T13:35:50Z"
image: "/images/devto/231174-cover.webp"
imageAlt: "Cover image for Tip 3: Create a `tmp` Alias"
tags: ["linux", "dotfiles"]
---

Nobody ever tells you this, but it's true for everyone ... you'll need to trust me...

There's going to be a time in your life when you create a directory called `stuff` (or `things`, or `tmp`, or `delete-me`, and so forth) to perform some random crappy test.

You'll **never** delete this directory. Honestly. You'll end up putting it in some `archive` directory and it'll live forever.

Well, enough is enough.

Create this alias. Now.

Use it with the same glutenous desire you feel when you're reaching for that last piece of chocolate, from the bag you opened three and a half minutes ago.

You're welcome


```shell
alias tmp=' cd $(mktemp -d)'
```

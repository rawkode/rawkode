---
title: "Tip 6: Bat, Rip, & Skim"
description: "Consider this the \"Embrace Rust\" tip post. If an app can be rewritten in Rust, then someone's probabl..."
pubDate: "2020-01-08T23:20:10Z"
authorName: "David Flanagan"
image: "/images/devto/234834-cover.webp"
imageAlt: "Cover image for Tip 6: Bat, Rip, & Skim"
tags: ["linux", "dotfiles"]
---

Consider this the "Embrace Rust" tip post. If an app can be rewritten in Rust, then someone's probably done it already.

Here are my top 3 (Besides `exa`, as I covered that [yesterday](/read/tip-5-replacing-ls-with-exa-3o5n))

## Bat

[Bat](https://github.com/sharkdp/bat) is a `cat` rewrite, in Rust. It has colours. Lots of colours.


![Alt Text](/images/devto/234834-inline-1.png)

## Ripgrep

Ripgrep, as one can imagine, is a `grep` rewrite in Rust. Now, it's not got as many colours (Well, why would it?), but it's **crazy** fast.

![Alt Text](/images/devto/234834-inline-2.png)

## Skim

Finally, one without a rusted name. Skim is a `fzf` alternative. It's good for presenting lists of content in a filterable fashion. Lets take a look at `kill -9` followed by <kbd>Tab</kbd>

<iframe title="Terminal recording" src="https://asciinema.org/a/292521/iframe" loading="lazy" allowfullscreen></iframe>

---

Thanks for tuning in,
Until next time 🤘

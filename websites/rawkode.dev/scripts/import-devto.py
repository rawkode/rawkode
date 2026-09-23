#!/usr/bin/env python3
"""Import the rawkode DEV archive into Astro's Markdown collection.

Run from this directory with `python3 scripts/import-devto.py`. Pass --data
with a saved JSON array of article detail responses to repeat an import offline.
"""

import argparse
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
POSTS = ROOT / "src/content/blog"
IMAGES = ROOT / "public/images/devto"
API = "https://dev.to/api/articles"


def fetch(url: str) -> bytes:
    return subprocess.check_output(
        ["curl", "-fsSL", "--retry", "5", "--retry-delay", "2", url],
        timeout=120,
    )


def articles(data: str | None):
    if data:
        return json.loads(Path(data).read_text())
    listing = json.loads(fetch(f"{API}?username=rawkode&per_page=100"))
    # Sequential detail requests avoid DEV's API rate limit.
    return [json.loads(fetch(f"{API}/{article['id']}")) for article in listing if not article.get("organization")]


def slug(article):
    return urlparse(article["url"]).path.rsplit("/", 1)[-1]


def save_image(url: str, name: str):
    IMAGES.mkdir(parents=True, exist_ok=True)
    existing = list(IMAGES.glob(name + ".*"))
    data = existing[0].read_bytes() if existing else fetch(url)
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        suffix = ".webp"
    elif data.startswith(b"\x89PNG"):
        suffix = ".png"
    elif data.startswith(b"\xff\xd8"):
        suffix = ".jpg"
    elif data.startswith(b"GIF8"):
        suffix = ".gif"
    else:
        raise RuntimeError(f"Unknown image format for {url}")
    destination = IMAGES / (name + suffix)
    if existing and existing[0] != destination:
        existing[0].rename(destination)
    elif not existing:
        destination.write_bytes(data)
    return f"/images/devto/{destination.name}"


def metadata(article, image):
    date = article["published_at"]
    author = "David McKay" if date[:4] < "2020" else "David Flanagan"
    fields = {
        "title": article["title"],
        "description": article["description"],
        "pubDate": date,
        "authorName": author,
    }
    if article.get("edited_at"):
        fields["updatedDate"] = article["edited_at"]
    if image:
        fields["image"] = image
        fields["imageAlt"] = f"Cover image for {article['title']}"
    fields["tags"] = article.get("tags", [])
    lines = [f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in fields.items()]
    return "---\n" + "\n".join(lines) + "\n---\n\n"


def content(article, links, next_image_index):
    body = article["body_markdown"].strip()
    # Some older DEV exports include their own frontmatter inside body_markdown.
    body = re.sub(r"\A---\r?\n.*?\r?\n---\r?\n", "", body, flags=re.S).strip()
    body = re.sub(
        r"{% youtube ([\w-]+) %}",
        lambda m: f'<iframe title="YouTube video" src="https://www.youtube-nocookie.com/embed/{m[1]}" loading="lazy" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>',
        body,
    )
    body = re.sub(
        r"{% asciinema (\d+) %}",
        lambda m: f'<iframe title="Terminal recording" src="https://asciinema.org/a/{m[1]}/iframe" loading="lazy" allowfullscreen></iframe>',
        body,
    )
    body = re.sub(
        r"!\[([^]]*)\]\((https?://[^)]+)\)",
        lambda m: f"![{m[1]}]({save_image(m[2], str(article['id']) + '-inline-' + str(next_image_index()))})",
        body,
    )
    for old_url, new_url in links.items():
        body = body.replace(old_url, new_url)
    # Resolve a relative link from the former rawkode.com archive.
    if article["id"] == 417066:
        body = body.replace("./saltstack-on-packet-with-pulumi", links["https://dev.to/rawkode/saltstack-on-packet-with-pulumi-c7p"])
    return body + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", help="JSON array of DEV article detail responses")
    args = parser.parse_args()
    posts = [a for a in articles(args.data) if not a.get("organization")]
    if len(posts) != 17:
        raise RuntimeError(f"Expected 17 personal articles from rawkode, got {len(posts)}")
    links = {a["url"]: f"/read/{slug(a)}" for a in posts}
    for article in posts:
        path = POSTS / f"{slug(article)}.md"
        if path.exists():
            raise RuntimeError(f"Refusing to overwrite an existing article: {path}")
        image = save_image(article["cover_image"], str(article["id"]) + "-cover") if article.get("cover_image") else None
        index = 0

        def next_image_index():
            nonlocal index
            index += 1
            return index

        path.write_text(metadata(article, image) + content(article, links, next_image_index), encoding="utf-8")
        print(f"{article['published_at'][:10]} {path.name}")


if __name__ == "__main__":
    main()

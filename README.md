# astro-formatter

A Node.js CLI tool that converts [Ghost](https://ghost.org/) blog export files (JSON + HTML) into [Astro](https://astro.build/)-compatible `.mdx` files, ready to drop into an Astro content collection. Optionally uses a local [Ollama](https://ollama.com/) model to automatically generate tags and pick a category for each post.

## Features

- Parses Ghost JSON export files (supports both fully-parsed and large/malformed exports via a fallback bracket-matching parser)
- Converts Ghost HTML post bodies to Markdown using [Turndown](https://github.com/mixmark-io/turndown)
- Emits `.mdx` files with rich YAML front matter (title, date, description, image, author, category, tags, read time, slug, status)
- Replaces `__GHOST_URL__` placeholders with a real base URL
- Filters posts by publish status (`all` / `published` / `draft`)
- Limits output to the first *N* posts
- **Optional AI enrichment** – calls a locally running Ollama model to generate 3–5 tags and choose the best category for every post

## Requirements

- Node.js 18+
- `npm install` (installs `turndown` and `deasync`)
- *(Optional)* [Ollama](https://ollama.com/) running on `localhost:11434` with your chosen model pulled

## Installation

```bash
git clone https://github.com/jussiroine/astro-formatter.git
cd astro-formatter
npm install
```

## Usage

```bash
node ghost-to-astro.js [options]
```

### Options

| Option | Default | Description |
|---|---|---|
| `--input <path>` | `ghost-posts.json` | Path to the Ghost JSON export file |
| `--outDir <path>` | `posts` | Output directory for generated `.mdx` files |
| `--status <value>` | `all` | Filter by post status: `all`, `published`, or `draft` |
| `--ghostUrl <url>` | *(empty)* | Replace `__GHOST_URL__` placeholders in content and image paths |
| `--category <value>` | `General` | Default front matter category when Ollama is not used |
| `--authorName <value>` | `Jussi Roine` | Author name written to every post's front matter |
| `--authorRole <value>` | *(empty)* | Author role / job title |
| `--authorBio <value>` | *(empty)* | Short author biography |
| `--authorImage <value>` | *(empty)* | URL or path to the author avatar image |
| `--authorAlt <value>` | *(empty)* | Alt text for the author image |
| `--limit <number>` | `0` (all) | Convert only the first *N* matching posts |
| `--useOllama` | `false` | Enable Ollama AI to generate tags and categories |
| `--ollamaModel <value>` | `gemma4:e4b` | Ollama model to use for tag/category generation |
| `--help` | | Print help and exit |

### Examples

Convert all posts from a Ghost export, replacing the Ghost base URL:

```bash
node ghost-to-astro.js \
  --input ghost-posts.json \
  --outDir src/content/posts \
  --ghostUrl https://myblog.com \
  --authorName "Jane Doe" \
  --authorRole "Staff Engineer"
```

Convert only published posts with AI-generated tags and categories:

```bash
node ghost-to-astro.js \
  --input ghost-posts.json \
  --outDir src/content/posts \
  --status published \
  --useOllama \
  --ollamaModel llama3.2
```

Convert the first 10 posts as a quick preview:

```bash
node ghost-to-astro.js --limit 10
```

## Output format

Each post is written as `<slug>.mdx` with the following front matter:

```yaml
---
title: "My Blog Post Title"
date: "2024-03-15"
description: "Auto-extracted excerpt or first sentence of the post."
image: "/img/2024/03/cover.jpg"
alt: "My Blog Post Title"
author:
  name: "Jane Doe"
  role: "Staff Engineer"
  bio: "Short bio."
  image: "/img/author.jpg"
  alt: "Jane Doe"
category: "Azure"
readTime: "4 min read"
tags: ["cloud", "devops", "architecture"]
slug: "my-blog-post-title"
status: "published"
views: 1
---

Post body in Markdown …
```

### Category choices (used with Ollama)

When `--useOllama` is set, the model picks exactly one category from the following list:

`Azure` · `Security` · `Productivity` · `Architecture` · `Integration` · `Automation` · `Development` · `Networking` · `Identity` · `Cloud` · `Data` · `AI` · `Career` · `Leadership` · `Strategy` · `Wellness` · `General`

## How it works

1. **Parse** – reads the Ghost JSON export and extracts the `posts` array.
2. **Filter** – removes pages (only `type: "post"` entries are kept) and applies the `--status` and `--limit` filters.
3. **Enrich** *(optional)* – for each post, calls Ollama twice: once for tags, once for a category.
4. **Convert** – turns Ghost HTML into Markdown with Turndown, then prepends the YAML front matter block.
5. **Write** – saves each post as `<outDir>/<slug>.mdx`.

## Ghost export file

Export your content from Ghost Admin → **Settings → Labs → Export your content**. The downloaded `.json` file is the input this tool expects.

## License

ISC

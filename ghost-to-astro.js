#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const TurndownService = require("turndown");

function parseArgs(argv) {
  const args = {
    input: "ghost-posts.json",
    outDir: "posts",
    status: "all",
    ghostUrl: "",
    category: "General",
    authorName: "Jussi Roine",
    authorRole: "",
    authorBio: "",
    authorImage: "",
    authorAlt: "",
    limit: 0,
    useOllama: false,
    ollamaModel: "gemma4:e4b",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=");
    let value = inlineValue;
    if (value === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      value = argv[i + 1];
      i += 1;
    }

    if (key === "help") {
      printHelp();
      process.exit(0);
    }

    if (key === "useOllama") {
      args[key] = true;
    } else if (key in args && value !== undefined) {
      if (key === "limit") {
        args[key] = Number(value) || 0;
      } else {
        args[key] = value;
      }
    }
  }

  return args;
}

function printHelp() {
  console.log(`Ghost to Astro MDX converter

Usage:
  node ghost-to-astro.js [options]

Options:
  --input <path>         Ghost export file (default: ghost-posts.json)
  --outDir <path>        Output directory for .mdx files (default: posts)
  --status <value>       all | published | draft (default: all)
  --ghostUrl <url>       Replace __GHOST_URL__ placeholders in content
  --category <value>     Default front matter category
  --authorName <value>   Default author name
  --authorRole <value>   Default author role
  --authorBio <value>    Default author bio
  --authorImage <value>  Default author image URL/path
  --authorAlt <value>    Default author alt text
  --limit <number>       Convert only first N matching posts
  --useOllama            Use Ollama (localhost:11434) to generate tags
  --ollamaModel <value>  Ollama model to use (default: gemma4:e4b)
  --help                 Show this help
`);
}

function readGhostPosts(inputPath) {
  const raw = fs.readFileSync(inputPath, "utf8");

  try {
    const parsed = JSON.parse(raw);
    const posts = parsed?.db?.[0]?.data?.posts;
    if (Array.isArray(posts)) {
      return posts;
    }
  } catch (_err) {
    // Continue to fallback parser
  }

  const keyIndex = raw.indexOf('"posts"');
  if (keyIndex === -1) {
    throw new Error('Could not find "posts" in input file.');
  }

  const arrayStart = raw.indexOf("[", keyIndex);
  if (arrayStart === -1) {
    throw new Error('Could not find "[" after "posts" key.');
  }

  let depth = 0;
  let arrayEnd = -1;
  let inString = false;
  let prevChar = "";

  for (let i = arrayStart; i < raw.length; i += 1) {
    const ch = raw[i];

    // Track string state (ignore brackets inside strings)
    if (ch === '"' && prevChar !== "\\") {
      inString = !inString;
    }

    if (!inString) {
      if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          arrayEnd = i;
          break;
        }
      }
    }

    prevChar = ch;
  }

  if (arrayEnd === -1) {
    throw new Error("Could not find end of posts array.");
  }

  const postsJson = raw.slice(arrayStart, arrayEnd + 1);
  const posts = JSON.parse(postsJson);
  if (!Array.isArray(posts)) {
    throw new Error("Posts payload is not an array.");
  }

  return posts;
}

function yamlEscape(value) {
  const v = String(value ?? "");
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function toIsoDate(value) {
  if (!value) {
    return "";
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toISOString().slice(0, 10);
}

function estimateReadTime(text) {
  const words = (text || "").split(/\s+/).length;
  const minutes = Math.ceil(words / 200);
  return `${minutes} min read`;
}

function firstSentence(text) {
  if (!text) {
    return "";
  }
  const match = text.match(/^(.+?[.!?])/);
  if (!match) {
    return text.substring(0, 180);
  }
  const sentence = match[1];
  return sentence.length > 180 ? sentence.substring(0, 180) : sentence;
}

function sanitizeSlug(slug, title) {
  const base = (slug || title || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "post";
}

function normalizeImageUrls(text, ghostUrl = "") {
  if (!text) {
    return text;
  }

  let value = String(text);
  const ghostBase = (ghostUrl || "").replace(/\/$/, "");

  if (ghostBase) {
    const escapedGhostBase = ghostBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ghostUploadsRe = new RegExp(`${escapedGhostBase}/wp-content/uploads/(\\d{4})/(\\d{2})/([^\\s)\"']+)`, "gi");
    value = value.replace(ghostUploadsRe, "/img/$1/$2/$3");
  }

  value = value.replace(/https?:\/\/[^\s)"']+\/wp-content\/uploads\/(\d{4})\/(\d{2})\/([^\s)"']+)/gi, "/img/$1/$2/$3");
  value = value.replace(/https?:\/\/[^\s)"']+\/content\/images\/wordpress\/(\d{4})\/(\d{2})\/([^\s)"']+)/gi, "/img/$1/$2/$3");
  value = value.replace(/https?:\/\/[^\s)"']+\/content\/images\/(\d{4})\/(\d{2})\/([^\s)"']+)/gi, "/img/$1/$2/$3");
  value = value.replace(/__GHOST_URL__\/content\/images\/(\d{4})\/(\d{2})\/([^\s)"']+)/g, "/img/$1/$2/$3");
  value = value.replace(/__GHOST_URL__\/content\/images/g, "/img");

  return value;
}

function buildFrontMatter(post, defaults, tags = [], category = defaults.category) {
  const date = toIsoDate(post.published_at) || toIsoDate(post.created_at) || "1970-01-01";
  const description = post.custom_excerpt || firstSentence(post.plaintext) || post.title || "";
  let image = post.feature_image || "";
  image = normalizeImageUrls(image, defaults.ghostUrl);
  const alt = post.title || "";
  const readTime = estimateReadTime(post.plaintext || "");

  return [
    "---",
    `title: ${yamlEscape(post.title || "Untitled")}`,
    `date: ${yamlEscape(date)}`,
    `description: ${yamlEscape(description)}`,
    `image: ${yamlEscape(image)}`,
    `alt: ${yamlEscape(alt)}`,
    "author:",
    `  name: ${yamlEscape(defaults.authorName)}`,
    `  role: ${yamlEscape(defaults.authorRole)}`,
    `  bio: ${yamlEscape(defaults.authorBio)}`,
    `  image: ${yamlEscape(defaults.authorImage)}`,
    `  alt: ${yamlEscape(defaults.authorAlt || defaults.authorName)}`,
    `category: ${yamlEscape(category)}`,
    `readTime: ${yamlEscape(readTime)}`,
    `tags: [${tags.map((t) => yamlEscape(t)).join(", ")}]`,
    `slug: ${yamlEscape(post.slug || "")}`,
    `status: ${yamlEscape(post.status || "")}`,
    "---",
  ].join("\n");
}

function buildContent(post, ghostUrl) {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  let html = (post.html || "").trim();
  if (!html && post.plaintext) {
    return post.plaintext.trim();
  }

  if (!html) {
    return "_No content available._";
  }

  let markdown = turndownService.turndown(html);
  if (ghostUrl) {
    markdown = markdown.replace(/__GHOST_URL__/g, ghostUrl.replace(/\/$/, ""));
  }
  return normalizeImageUrls(markdown, ghostUrl);
}

function matchesStatus(post, status) {
  if (status === "all") {
    return true;
  }
  return (post.status || "").toLowerCase() === status.toLowerCase();
}

function processTerminalOutput(str) {
  // Interpret VT100 escape sequences rather than just stripping them.
  // ESC[nD (cursor back n) removes the last n characters from the buffer so
  // partial words written before a correction are not left behind.
  // ESC[K (erase to end of line) is a no-op here since cursor-back already
  // trimmed the buffer.  All other escape sequences are discarded.
  // Carriage returns (\r) rewind to the start of the current line.
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\x1B" && str[i + 1] === "[") {
      let j = i + 2;
      while (j < str.length && !/[@-~]/.test(str[j])) {
        j += 1;
      }
      const params = str.slice(i + 2, j);
      const cmd = str[j];
      i = j + 1;
      if (cmd === "D") {
        // Cursor back n — trim that many characters from the buffer
        const n = parseInt(params, 10) || 1;
        result = result.slice(0, -n);
      }
      // ESC[K and all other sequences are intentionally ignored
    } else if (str[i] === "\r") {
      // Carriage return — rewind to start of the current line
      const lastNewline = result.lastIndexOf("\n");
      result = result.slice(0, lastNewline + 1);
      i += 1;
    } else {
      result += str[i];
      i += 1;
    }
  }
  return result;
}

function runOllamaPrompt(model, prompt) {
  const raw = execFileSync(
    "ollama",
    ["run", "--hidethinking", "--think=false", model, prompt],
    {
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true,
    }
  );
  return processTerminalOutput(raw);
}

const CATEGORY_CHOICES = [
  "Azure",
  "Security",
  "Productivity",
  "Architecture",
  "Integration",
  "Automation",
  "Development",
  "Networking",
  "Identity",
  "Cloud",
  "Data",
  "AI",
  "Career",
  "Leadership",
  "Strategy",
  "Wellness",
  "General",
];

const TAG_CHOICES = [
  "Azure",
  "Microsoft 365",
  "SharePoint",
  "Power Platform",
  "PowerShell",
  "Azure OpenAI",
  "Productivity",
  "Cloud Computing",
  "Security",
  "Networking",
  "Microsoft Teams",
  "Docker",
  "IoT",
  "Raspberry Pi",
  ".NET",
  "Web Development",
  "Remote Work",
  "Professional Development",
  "Software Development",
  "Automation",
  "AI",
  "Power Automate",
  "Azure Functions",
  "Identity",
  "DevOps",
];

function generateTagsWithOllama(post, model) {
  try {
    const prompt = [
      "Choose 3 to 5 tags for this blog post from the allowed list below.",
      "Return only the chosen tags as a comma-separated list.",
      "Do not include any tags not in the allowed list.",
      "Do not include explanations, bullets, prefixes, or hashtags.",
      `Allowed tags: ${TAG_CHOICES.join(", ")}.`,
      `Title: ${post.title || ""}`,
      `Content: ${(post.plaintext || "").substring(0, 1200)}`,
      "Tags:",
    ].join("\n");

    const output = runOllamaPrompt(model, prompt);

    const tags = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .split(",")
      .map((tag) => tag.replace(/^tags:\s*/i, "").trim())
      .map((tag) => tag.replace(/^[-*]\s*/, ""))
      .filter((tag) => TAG_CHOICES.includes(tag))
      .slice(0, 5);

    return tags;
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    console.log(`  (Ollama error: ${detail})`);
    return [];
  }
}

function generateCategoryWithOllama(post, model, fallbackCategory) {
  try {
    const prompt = [
      "Choose exactly one category for this blog post title.",
      `Allowed categories: ${CATEGORY_CHOICES.join(", ")}.`,
      "Return only the category word, nothing else.",
      "Do not explain your choice.",
      `Title: ${post.title || ""}`,
      "Category:",
    ].join("\n");

    const output = runOllamaPrompt(model, prompt);
    const rawCategory = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/^category:\s*/i, "")
      .split(/\s+/)[0]
      .replace(/[^A-Za-z]/g, "");

    if (!rawCategory) {
      return fallbackCategory;
    }

    const category = CATEGORY_CHOICES.find(
      (choice) => choice.toLowerCase() === rawCategory.toLowerCase()
    );

    if (!category) {
      return fallbackCategory;
    }

    return category;
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    console.log(`  (Ollama error: ${detail})`);
    return fallbackCategory;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(process.cwd(), args.input);
  const outDir = path.resolve(process.cwd(), args.outDir);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const posts = readGhostPosts(inputPath)
    .filter((p) => p && p.type === "post")
    .filter((p) => matchesStatus(p, args.status));

  const limitedPosts = args.limit > 0 ? posts.slice(0, args.limit) : posts;

  fs.mkdirSync(outDir, { recursive: true });

  let written = 0;
  for (const post of limitedPosts) {
    const slug = sanitizeSlug(post.slug, post.title);
    const fileName = `${slug}.mdx`;
    const target = path.join(outDir, fileName);

    let tags = [];
    let category = args.category;
    if (args.useOllama) {
      category = generateCategoryWithOllama(post, args.ollamaModel, args.category);
      tags = generateTagsWithOllama(post, args.ollamaModel);
      console.log(`  Generated category: ${category}`);
      if (tags.length > 0) {
        console.log(`  Generated tags: ${tags.join(", ")}`);
      }
    }

    const frontMatter = buildFrontMatter(post, args, tags, category);
    const body = buildContent(post, args.ghostUrl);
    const output = `${frontMatter}\n\n${body}\n`;

    fs.writeFileSync(target, output, "utf8");
    written += 1;
    console.log(`Wrote ${fileName}`);
  }

  console.log(`Done. Converted ${written} post(s) to ${outDir}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    postsDir: "astro-posts",
    outDir: "out",
    model: "qwen3.6:27b",
    limit: 0,
    dryRun: false,
    tagFile: "tags.json",
    abstract: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const [key, inlineValue] = arg.slice(2).split("=");
    let value = inlineValue;
    if (value === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      value = argv[i + 1];
      i += 1;
    }

    if (key === "help") {
      printHelp();
      process.exit(0);
    } else if (key === "dryRun") {
      args.dryRun = true;
    } else if (key === "noAbstract") {
      args.abstract = false;
    } else if (key === "limit") {
      args.limit = Number(value) || 0;
    } else if (key in args && value !== undefined) {
      args[key] = value;
    }
  }

  return args;
}

function printHelp() {
  console.log(`retag-posts — Re-tag Astro MDX posts using a local Ollama instance

Usage:
  node retag-posts.js [options]

Options:
  --postsDir <path>   Input folder with .mdx files      (default: astro-posts)
  --outDir   <path>   Output folder for updated files    (default: out)
  --model    <name>   Ollama model name                  (default: qwen3.6:27b)
  --tagFile  <path>   JSON file to load/save taxonomy    (default: tags.json)
                      If the file exists, Phase 1 is skipped and the existing
                      taxonomy is used directly.
  --limit    <n>      Process only first N files
  --dryRun            Print proposed changes, do not write files
  --noAbstract        Skip abstract generation (tags only)
  --help              Show this help
`);
}

// ---------------------------------------------------------------------------
// Ollama helpers (mirrors ghost-to-astro.js approach)
// ---------------------------------------------------------------------------
function processTerminalOutput(str) {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\x1B" && str[i + 1] === "[") {
      let j = i + 2;
      while (j < str.length && !/[@-~]/.test(str[j])) j += 1;
      const params = str.slice(i + 2, j);
      const cmd = str[j];
      i = j + 1;
      if (cmd === "D") {
        const n = parseInt(params, 10) || 1;
        result = result.slice(0, -n);
      }
    } else if (str[i] === "\r") {
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
      timeout: 180000,
      windowsHide: true,
    }
  );
  return processTerminalOutput(raw).trim();
}

// ---------------------------------------------------------------------------
// Frontmatter parsing / updating
// ---------------------------------------------------------------------------

/**
 * Split an MDX file into { frontmatter: string, body: string }.
 * Returns null if the file does not start with a --- block.
 */
function splitFrontmatter(content) {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  return {
    frontmatter: content.slice(3, end).trimStart(),
    body: content.slice(end + 4), // skip the closing ---
  };
}

/**
 * Extract a single scalar YAML value from a frontmatter string.
 * Handles: `key: value`, `key: "value"`, `key: 'value'`, and block scalars
 * that span lines (only the first line value is returned for simplicity).
 */
function extractFrontmatterValue(frontmatter, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const m = frontmatter.match(re);
  if (!m) return "";
  const raw = m[1].trim();
  // Unwrap quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Block scalar indicator (|, >, >-)
  if (raw === "" || raw === "|" || raw === ">" || raw === ">-") return "";
  return raw;
}

/**
 * Replace (or insert) the tags section in a YAML frontmatter string.
 * Handles both:
 *   tags: ["a", "b"]               ← single-line inline array
 *   tags:                          ← multi-line sequence
 *     - a
 *     - b
 * Writes back as a multi-line YAML sequence:
 *   tags:
 *     - a
 *     - b
 */
function setTagsInFrontmatter(frontmatter, tags) {
  const lines = tags.map((t) => `  - ${t.toLowerCase()}`).join("\n");
  const blockValue = `tags:\n${lines}`;

  // Match multi-line tags block: "tags:" followed by indented "- ..." lines
  const multiLineRe = /^tags:[ \t]*\r?\n(?:[ \t]+-[^\r\n]*\r?\n?)*/m;
  if (multiLineRe.test(frontmatter)) {
    return frontmatter.replace(multiLineRe, blockValue + "\n");
  }

  // Match single-line tags: "tags: [...]" or "tags: anything"
  const singleLineRe = /^tags:[ \t]*.*$/m;
  if (singleLineRe.test(frontmatter)) {
    return frontmatter.replace(singleLineRe, blockValue);
  }

  // No existing tags key — append
  return frontmatter.trimEnd() + "\n" + blockValue + "\n";
}

// ---------------------------------------------------------------------------
// Phase 1: taxonomy generation
// ---------------------------------------------------------------------------

/**
 * Send all titles (in batches if needed) to Ollama and gather a flat list of
 * 25-30 unique tag strings.
 */
function generateTaxonomy(titles, model) {
  const BATCH_SIZE = 80; // ~80 titles per prompt to stay well within context
  const allSuggested = [];

  const batches = [];
  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    batches.push(titles.slice(i, i + BATCH_SIZE));
  }

  console.log(`\nPhase 1 — generating taxonomy from ${titles.length} titles in ${batches.length} batch(es)...\n`);

  for (let b = 0; b < batches.length; b += 1) {
    const batch = batches[b];
    const titleList = batch.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const prompt = [
      "You are helping categorize a technical blog.",
      `Review these ${batch.length} blog post titles and suggest broad, reusable tags.`,
      "Rules:",
      "- Return ONLY a comma-separated list of tags, nothing else.",
      "- No numbering, bullets, explanations, or extra punctuation.",
      "- Tags should be broad enough to apply to multiple posts (e.g. 'Azure', 'Security', 'Productivity').",
      "- Each tag should be 1-4 words, title-cased.",
      "- Suggest 20-30 tags that collectively cover all the topics below.",
      "",
      "Blog post titles:",
      titleList,
      "",
      "Tags:",
    ].join("\n");

    console.log(`  Batch ${b + 1}/${batches.length}: sending ${batch.length} titles to Ollama...`);
    const output = runOllamaPrompt(model, prompt);
    const parsed = output
      .split(",")
      .map((t) => t.replace(/^[-*\d.)\s]+/, "").trim())
      .filter((t) => t.length > 0 && t.length < 60);
    console.log(`  Batch ${b + 1} returned ${parsed.length} raw tags.`);
    allSuggested.push(...parsed);
  }

  // Deduplicate (case-insensitive merge, keep first casing seen)
  const seen = new Map();
  for (const tag of allSuggested) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
  }
  let unique = Array.from(seen.values());

  if (unique.length < 20 || unique.length > 35) {
    console.warn(`\nWarning: taxonomy has ${unique.length} tags (expected 20-35). You may want to edit tags.json before proceeding.\n`);
  }

  // If we got too many, trim to 30
  if (unique.length > 30) {
    console.log(`  Trimming ${unique.length} tags down to 30 most common ones via a second Ollama pass...`);
    unique = trimTaxonomy(unique, 30, model);
  }

  return unique;
}

/**
 * When the first-pass taxonomy is too large, ask Ollama to distil it down.
 */
function trimTaxonomy(tags, targetCount, model) {
  const prompt = [
    `The following is a list of ${tags.length} tags for a technical blog.`,
    `Reduce this to the ${targetCount} most broadly useful tags.`,
    "Return ONLY a comma-separated list of tags, nothing else.",
    "Do not add new tags — only keep tags from the list below.",
    "",
    `Tags: ${tags.join(", ")}`,
    "",
    `Best ${targetCount} tags:`,
  ].join("\n");

  const output = runOllamaPrompt(model, prompt);
  const trimmed = output
    .split(",")
    .map((t) => t.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((t) => t.length > 0 && t.length < 60);

  // Validate: keep only tags that exist in the original list (case-insensitive)
  const tagMap = new Map(tags.map((t) => [t.toLowerCase(), t]));
  const validated = trimmed
    .map((t) => tagMap.get(t.toLowerCase()))
    .filter(Boolean)
    .slice(0, targetCount);

  // Fallback: if validation lost too many, top up from original list
  if (validated.length < targetCount) {
    const existing = new Set(validated.map((t) => t.toLowerCase()));
    for (const t of tags) {
      if (validated.length >= targetCount) break;
      if (!existing.has(t.toLowerCase())) validated.push(t);
    }
  }

  return validated;
}

// ---------------------------------------------------------------------------
// Abstract generation
// ---------------------------------------------------------------------------

function generateAbstractForPost(title, excerpt, model) {
  const prompt = [
    "Write a 2-3 sentence abstract for the blog post below, written in first person from the author's perspective.",
    "Start with a phrase that explains what might interest readers about this post.",
    "Base the abstract on the actual content provided, not just the title.",
    "Return ONLY the abstract text — no title, no label, no extra formatting.",
    "",
    `Title: ${title}`,
    `Content: ${excerpt}`,
    "",
    "Abstract:",
  ].join("\n");

  try {
    const output = runOllamaPrompt(model, prompt);
    return output
      .replace(/^abstract:\s*/i, "")
      .replace(/\r?\n/g, " ")
      .replace(/  +/g, " ")
      .trim();
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    console.warn(`    Ollama error (abstract): ${detail}`);
    return "";
  }
}

/**
 * Replace the description field in a YAML frontmatter string.
 * Handles single-line values and multi-line block scalars (|, >, >-).
 * Writes back as a double-quoted single-line value.
 */
function setDescriptionInFrontmatter(frontmatter, description) {
  const escaped = description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const inlineValue = `description: "${escaped}"`;

  // Multi-line block scalar: description: >- (or > or |) followed by indented lines
  const blockRe = /^description:[ \t]*[|>][^\r\n]*\r?\n(?:[ \t][^\r\n]*\r?\n?)*/m;
  if (blockRe.test(frontmatter)) {
    return frontmatter.replace(blockRe, inlineValue + "\n");
  }

  // Single-line value
  const singleLineRe = /^description:[ \t]*.*$/m;
  if (singleLineRe.test(frontmatter)) {
    return frontmatter.replace(singleLineRe, inlineValue);
  }

  return frontmatter.trimEnd() + "\n" + inlineValue + "\n";
}

// ---------------------------------------------------------------------------
// Phase 2: per-post tag assignment
// ---------------------------------------------------------------------------

function assignTagsToPost(title, excerpt, taxonomy, model) {
  const prompt = [
    "Choose 2 to 4 tags for this blog post from the allowed list below.",
    "Return ONLY the chosen tags as a comma-separated list.",
    "Do not include tags not in the allowed list.",
    "Do not include explanations, bullets, numbers, or hashtags.",
    "",
    `Allowed tags: ${taxonomy.join(", ")}`,
    "",
    `Title: ${title}`,
    `Excerpt: ${excerpt}`,
    "",
    "Tags:",
  ].join("\n");

  try {
    const output = runOllamaPrompt(model, prompt);
    const tagMap = new Map(taxonomy.map((t) => [t.toLowerCase(), t]));
    const tags = output
      .split(/[\r\n,]+/)
      .map((t) => t.replace(/^[-*\d.)\s]+/, "").replace(/^tags:\s*/i, "").trim())
      .map((t) => tagMap.get(t.toLowerCase()))
      .filter(Boolean)
      .slice(0, 4);
    return tags;
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    console.warn(`    Ollama error: ${detail}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  const postsDir = path.resolve(process.cwd(), args.postsDir);
  const outDir = path.resolve(process.cwd(), args.outDir);
  const tagFilePath = path.resolve(process.cwd(), args.tagFile);

  if (!fs.existsSync(postsDir)) {
    throw new Error(`Posts directory not found: ${postsDir}`);
  }

  // Enumerate .mdx files
  let files = fs.readdirSync(postsDir)
    .filter((f) => f.endsWith(".mdx"))
    .sort();

  if (args.limit > 0) {
    files = files.slice(0, args.limit);
  }

  console.log(`Found ${files.length} .mdx file(s) in ${postsDir}`);
  if (args.dryRun) console.log("(dry-run mode — no files will be written)\n");

  // ------------------------------------------------------------------
  // Phase 1: Taxonomy
  // ------------------------------------------------------------------
  let taxonomy;

  if (fs.existsSync(tagFilePath)) {
    console.log(`\nLoading existing taxonomy from ${tagFilePath} (skip Phase 1)...`);
    try {
      taxonomy = JSON.parse(fs.readFileSync(tagFilePath, "utf8"));
      if (!Array.isArray(taxonomy) || taxonomy.length === 0) {
        throw new Error("Tag file must be a non-empty JSON array.");
      }
      console.log(`  Loaded ${taxonomy.length} tags: ${taxonomy.join(", ")}\n`);
    } catch (err) {
      throw new Error(`Failed to parse ${tagFilePath}: ${err.message}`);
    }
  } else {
    // Collect all titles from all .mdx files (not just the limited set)
    const allFiles = fs.readdirSync(postsDir).filter((f) => f.endsWith(".mdx")).sort();
    const titles = allFiles.map((f) => {
      const content = fs.readFileSync(path.join(postsDir, f), "utf8");
      const split = splitFrontmatter(content);
      if (!split) return path.basename(f, ".mdx").replace(/-/g, " ");
      const title = extractFrontmatterValue(split.frontmatter, "title");
      return title || path.basename(f, ".mdx").replace(/-/g, " ");
    });

    taxonomy = generateTaxonomy(titles, args.model);

    console.log(`\nGenerated taxonomy (${taxonomy.length} tags):`);
    console.log(`  ${taxonomy.join(", ")}\n`);

    if (!args.dryRun) {
      fs.writeFileSync(tagFilePath, JSON.stringify(taxonomy, null, 2), "utf8");
      console.log(`Taxonomy saved to ${tagFilePath}\n`);
    }
  }

  // ------------------------------------------------------------------
  // Phase 2: Per-post tag assignment
  // ------------------------------------------------------------------
  console.log(`\nPhase 2 — assigning tags to ${files.length} post(s)...\n`);

  if (!args.dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let written = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const srcPath = path.join(postsDir, file);
    const destPath = path.join(outDir, file);
    const content = fs.readFileSync(srcPath, "utf8");

    const split = splitFrontmatter(content);
    if (!split) {
      console.warn(`  [SKIP] ${file} — no frontmatter found`);
      skipped += 1;
      continue;
    }

    const title = extractFrontmatterValue(split.frontmatter, "title");
    // Strip markdown syntax from body for use in Ollama prompts
    const cleanBody = split.body
      .replace(/^---/, "")
      .replace(/!\[.*?\]\(.*?\)/g, "")         // images
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → text
      .replace(/#{1,6}\s/g, "")                // headings
      .replace(/[*_`]/g, "")                   // bold/italic/code
      .replace(/\s+/g, " ")
      .trim();
    const excerpt = cleanBody.slice(0, 1200);      // for tag assignment
    const abstractExcerpt = cleanBody.slice(0, 2500); // richer context for abstract

    console.log(`  [${i + 1}/${files.length}] ${file}`);

    const tags = assignTagsToPost(title, excerpt, taxonomy, args.model);

    if (tags.length === 0) {
      console.warn(`    Warning: no valid tags returned — file will have empty tags.`);
      skipped += 1;
    } else {
      console.log(`    Tags: ${tags.join(", ")}`);
    }

    let abstract = "";
    if (args.abstract) {
      abstract = generateAbstractForPost(title, abstractExcerpt, args.model);
      if (abstract) {
        console.log(`    Abstract: ${abstract.slice(0, 80)}${abstract.length > 80 ? "..." : ""}`);
      } else {
        console.warn(`    Warning: no abstract returned — description field unchanged.`);
      }
    }

    if (!args.dryRun) {
      let newFrontmatter = setTagsInFrontmatter(split.frontmatter, tags);
      if (args.abstract && abstract) {
        newFrontmatter = setDescriptionInFrontmatter(newFrontmatter, abstract);
      }
      const raw = `---\n${newFrontmatter}---${split.body}`;
      // Normalise to CRLF (\r\n) line endings
      const newContent = raw.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      fs.writeFileSync(destPath, newContent, "utf8");
      written += 1;
    }
  }

  console.log(`\nDone. ${written} file(s) written to ${outDir}, ${skipped} skipped.`);
}

main();

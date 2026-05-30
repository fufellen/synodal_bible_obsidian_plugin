const { Plugin } = require("obsidian");

const BIBLE_ROOT = "Церковь/Библия/Библия/";
const EMBED_SELECTOR = ".internal-embed, .markdown-embed";
const TARGET_ATTRIBUTES = [
  "src",
  "data-src",
  "href",
  "data-href",
  "alt",
  "aria-label",
  "title",
];

module.exports = class BibleEmbedStylePlugin extends Plugin {
  async onload() {
    this.refreshTimer = null;

    this.registerMarkdownPostProcessor((el, ctx) => {
      const sourcePath = ctx.sourcePath || "";

      if (!this.isBibleFile(sourcePath)) {
        this.processRoot(el, sourcePath);
      }

      this.scheduleProcessViews();
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.scheduleProcessViews())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.scheduleProcessViews())
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.scheduleProcessViews())
    );

    this.scheduleProcessViews();
  }

  onunload() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    document.querySelectorAll(".bible-embed").forEach((el) => {
      el.classList.remove("bible-embed", "bible-embed-repeated-title");
      delete el.dataset.bibleTitle;
      delete el.dataset.bibleBook;
      delete el.dataset.bibleChapter;
      delete el.dataset.bibleVerse;
      delete el.dataset.bibleReference;
      delete el.dataset.biblePath;
      this.clearVerseBlocks(el);
    });

    document.querySelectorAll(".bible-page").forEach((el) => {
      el.classList.remove("bible-page");
    });
    this.clearVerseBlocks(document, "bible-page-verse-row");
  }

  scheduleProcessViews() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.processMarkdownViews();
    }, 80);
  }

  processMarkdownViews() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!view || !view.containerEl) continue;

      const sourcePath = view.file ? view.file.path : "";
      this.processRoot(view.containerEl, sourcePath);
    }
  }

  processRoot(root, sourcePath) {
    if (
      this.isBibleFile(sourcePath) &&
      this.isMarkdownViewRoot(root) &&
      !this.isInsideEmbed(root)
    ) {
      this.applyBiblePage(root);
    } else {
      this.clearBiblePage(root);
    }

    const bibleEmbeds = [];

    for (const el of this.getTopLevelEmbeds(root)) {
      const info = this.getBibleEmbedInfo(el, sourcePath);

      if (!info) {
        this.clearBibleEmbed(el);
        continue;
      }

      this.applyBibleEmbedInfo(info);
      bibleEmbeds.push(info);
    }

    this.markRepeatedTitles(bibleEmbeds);
  }

  applyBiblePage(root) {
    this.getBiblePageRoots(root).forEach((el) => {
      el.classList.add("bible-page");
    });

    this.decorateVerseBlocks(root, {
      excludeEmbeds: true,
      rowClass: "bible-page-verse-row",
    });
  }

  clearBiblePage(root) {
    this.getBiblePageRoots(root).forEach((el) => {
      el.classList.remove("bible-page");
    });

    this.clearVerseBlocks(root, "bible-page-verse-row");
  }

  getBiblePageRoots(root) {
    const roots = [];

    if (root.classList) {
      roots.push(root);
    }

    root
      .querySelectorAll?.(".markdown-reading-view, .markdown-preview-view")
      .forEach((el) => roots.push(el));

    return roots;
  }

  isInsideEmbed(root) {
    return root.closest?.(EMBED_SELECTOR);
  }

  isMarkdownViewRoot(root) {
    return Boolean(
      root.classList?.contains("workspace-leaf-content") ||
        root.classList?.contains("markdown-reading-view") ||
        root.classList?.contains("markdown-preview-view") ||
        root.querySelector?.(".markdown-reading-view, .markdown-preview-view")
    );
  }

  getTopLevelEmbeds(root) {
    const embeds = Array.from(root.querySelectorAll(EMBED_SELECTOR));

    return embeds.filter((el, index) => {
      if (embeds.indexOf(el) !== index) return false;

      const parentEmbed = el.parentElement
        ? el.parentElement.closest(EMBED_SELECTOR)
        : null;

      return !parentEmbed;
    });
  }

  getBibleEmbedInfo(el, sourcePath) {
    const rawTarget = this.getRawTarget(el);
    if (!rawTarget) return null;

    const target = this.parseRawTarget(rawTarget);
    if (!target.linkpath) return null;

    const file = this.app.metadataCache.getFirstLinkpathDest(
      target.linkpath,
      sourcePath
    );

    if (!file || !this.isBibleFile(file.path)) return null;

    const title = file.basename;
    const titleNumbers = title.match(/\d+/g) || [];
    const subpathNumbers = target.subpath.match(/\d+/g) || [];
    const parsedChapter =
      subpathNumbers.length >= 2
        ? subpathNumbers[0]
        : titleNumbers[titleNumbers.length - 1] || "";
    const parsedVerse =
      subpathNumbers.length > 0 ? subpathNumbers[subpathNumbers.length - 1] : "";
    const book =
      title
        .replace(/\s+(?:[Гг]лава|[Пп]салом)\s+\d+\s*$/, "")
        .trim() || title;

    return {
      el,
      file,
      rawTarget,
      title,
      book,
      chapter: parsedChapter,
      verse: parsedVerse,
      reference:
        parsedChapter && parsedVerse ? `${parsedChapter}:${parsedVerse}` : "",
    };
  }

  getRawTarget(el) {
    for (const attr of TARGET_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (!value) continue;

      const normalized = this.normalizeTargetText(value);
      if (normalized) return normalized;
    }

    return "";
  }

  normalizeTargetText(value) {
    let text = String(value).trim();
    if (!text) return "";

    text = text.replace(/^\[\[/, "").replace(/\]\]$/, "");

    try {
      text = decodeURIComponent(text);
    } catch (_) {
      // Keep the original text if it is not URI encoded.
    }

    return text;
  }

  parseRawTarget(rawTarget) {
    const withoutAlias = rawTarget.split("|")[0].trim();
    const hashIndex = withoutAlias.indexOf("#");
    const linkpath =
      hashIndex >= 0 ? withoutAlias.slice(0, hashIndex) : withoutAlias;
    const subpath = hashIndex >= 0 ? withoutAlias.slice(hashIndex + 1) : "";

    return {
      linkpath: linkpath.replace(/\.md$/i, "").trim(),
      subpath: subpath.trim(),
    };
  }

  isBibleFile(path) {
    const normalized = path.replace(/\\/g, "/");
    return (
      normalized === BIBLE_ROOT.slice(0, -1) ||
      normalized.startsWith(BIBLE_ROOT)
    );
  }

  applyBibleEmbedInfo(info) {
    const { el } = info;

    el.classList.add("bible-embed");
    el.classList.remove("bible-embed-repeated-title");
    el.dataset.bibleTitle = info.title;
    el.dataset.bibleBook = info.book;
    el.dataset.bibleChapter = info.chapter;
    el.dataset.bibleVerse = info.verse;
    el.dataset.bibleReference = info.reference;
    el.dataset.biblePath = info.file.path;

    this.decorateVerseBlocks(el, {
      selector: '.markdown-embed-content h6[data-heading*=":"]',
    });
  }

  clearBibleEmbed(el) {
    if (!el.classList.contains("bible-embed")) return;

    el.classList.remove("bible-embed", "bible-embed-repeated-title");
    delete el.dataset.bibleTitle;
    delete el.dataset.bibleBook;
    delete el.dataset.bibleChapter;
    delete el.dataset.bibleVerse;
    delete el.dataset.bibleReference;
    delete el.dataset.biblePath;
    this.clearVerseBlocks(el);
  }

  decorateVerseBlocks(el, options = {}) {
    const selector = options.selector || 'h6[data-heading*=":"]';
    const rowClass = options.rowClass || "";

    this.clearVerseBlocks(el, rowClass);

    const headings = Array.from(el.querySelectorAll(selector)).filter(
      (heading) => !options.excludeEmbeds || !heading.closest(EMBED_SELECTOR)
    );

    headings.forEach((heading, index) => {
      const numberBlock = heading.parentElement;
      if (!numberBlock) return;

      const textBlock = numberBlock.nextElementSibling;
      const row = document.createElement("div");
      row.classList.add("bible-verse-row");
      if (index === 0) {
        row.classList.add("bible-verse-first-row");
      }
      if (rowClass) {
        row.classList.add(rowClass);
      }

      numberBlock.parentNode.insertBefore(row, numberBlock);
      row.appendChild(numberBlock);
      if (textBlock) {
        row.appendChild(textBlock);
      }

      numberBlock.classList.add("bible-verse-number-block");
      heading.classList.add("bible-verse-number");

      if (textBlock) {
        textBlock.classList.add("bible-verse-text-block");
      }
    });
  }

  clearVerseBlocks(el, rowClass = "") {
    const selector = rowClass
      ? `.bible-verse-row.${rowClass}`
      : ".bible-verse-row";
    const rows = Array.from(el.querySelectorAll(selector));
    const numberBlocks = new Set();
    const verseNumbers = new Set();
    const textBlocks = new Set();

    rows.forEach((row) => {
      row
        .querySelectorAll(".bible-verse-number-block")
        .forEach((block) => numberBlocks.add(block));
      row
        .querySelectorAll(".bible-verse-number")
        .forEach((heading) => verseNumbers.add(heading));
      row
        .querySelectorAll(".bible-verse-text-block")
        .forEach((block) => textBlocks.add(block));
    });

    rows.forEach((row) => {
      while (row.firstChild) {
        row.parentNode.insertBefore(row.firstChild, row);
      }
      row.remove();
    });

    const removeNumberBlocks = rowClass
      ? Array.from(numberBlocks)
      : Array.from(el.querySelectorAll(".bible-verse-number-block"));
    const removeVerseNumbers = rowClass
      ? Array.from(verseNumbers)
      : Array.from(el.querySelectorAll(".bible-verse-number"));
    const removeTextBlocks = rowClass
      ? Array.from(textBlocks)
      : Array.from(el.querySelectorAll(".bible-verse-text-block"));

    removeNumberBlocks.forEach((block) => {
      block.classList.remove("bible-verse-number-block");
    });
    removeVerseNumbers.forEach((heading) => {
      heading.classList.remove("bible-verse-number");
    });
    removeTextBlocks.forEach((block) => {
      block.classList.remove("bible-verse-text-block");
    });
  }

  markRepeatedTitles(infos) {
    infos.sort((a, b) => {
      if (a.el === b.el) return 0;
      const position = a.el.compareDocumentPosition(b.el);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    for (let index = 1; index < infos.length; index += 1) {
      const previous = infos[index - 1];
      const current = infos[index];
      const sameChapter = previous.file.path === current.file.path;
      const adjacent = this.areAdjacentEmbeds(previous.el, current.el);

      if (sameChapter && adjacent) {
        current.el.classList.add("bible-embed-repeated-title");
      }
    }
  }

  areAdjacentEmbeds(previousEmbed, currentEmbed) {
    const previousBlock = this.getRenderedBlock(previousEmbed);
    const currentBlock = this.getRenderedBlock(currentEmbed);

    if (!previousBlock || !currentBlock || previousBlock === currentBlock) {
      return false;
    }

    try {
      const range = document.createRange();
      range.setStartAfter(previousBlock);
      range.setEndBefore(currentBlock);
      const textBetween = range.cloneContents().textContent || "";
      range.detach();

      return textBetween.replace(/\s+/g, "").length === 0;
    } catch (_) {
      return false;
    }
  }

  getRenderedBlock(el) {
    return el.closest(".el-embed") || el;
  }
};

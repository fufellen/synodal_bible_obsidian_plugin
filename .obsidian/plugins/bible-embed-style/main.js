const { Plugin, PluginSettingTab, Setting } = require("obsidian");

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
const DEFAULT_SETTINGS = {
  bibleRoots: ["Церковь/Библия/Библия/"],
  markerClasses: ["bible-verses"],
};

module.exports = class BibleEmbedStylePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.refreshTimer = null;
    this.addSettingTab(new BibleEmbedStyleSettingTab(this.app, this));

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
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.scheduleProcessViews())
    );

    this.scheduleProcessViews();
  }

  onunload() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    document.querySelectorAll(".bible-embed").forEach((el) => {
      el.classList.remove(
        "bible-embed",
        "bible-embed-repeated-title",
        "bible-embed-has-next"
      );
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

  async loadSettings() {
    this.settings = this.normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    this.settings = this.normalizeSettings(this.settings);
    await this.saveData(this.settings);
    this.scheduleProcessViews();
  }

  normalizeSettings(data) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    const bibleRoots = this.normalizeList(settings.bibleRoots)
      .map((root) => this.normalizeRoot(root))
      .filter(Boolean);
    const markerClasses = this.normalizeList(settings.markerClasses)
      .map((className) => className.trim())
      .filter(Boolean);

    return {
      bibleRoots: bibleRoots.length ? bibleRoots : DEFAULT_SETTINGS.bibleRoots,
      markerClasses: markerClasses.length
        ? markerClasses
        : DEFAULT_SETTINGS.markerClasses,
    };
  }

  normalizeList(value) {
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.normalizeList(item));
    }

    if (typeof value === "string") {
      return value
        .split(/[\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  normalizeRoot(root) {
    const normalized = String(root || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .trim();

    return normalized ? `${normalized}/` : "";
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
    return this.isBiblePath(normalized) || this.hasBibleMarker(path);
  }

  isBiblePath(path) {
    const normalized = String(path || "").replace(/\\/g, "/");

    return this.settings.bibleRoots.some((root) => {
      return normalized === root.slice(0, -1) || normalized.startsWith(root);
    });
  }

  hasBibleMarker(pathOrFile) {
    const file =
      typeof pathOrFile === "string"
        ? this.app.vault.getAbstractFileByPath(pathOrFile)
        : pathOrFile;

    if (!file || file.extension !== "md") return false;

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache ? cache.frontmatter : null;
    if (!frontmatter) return false;

    const cssClasses = [
      ...this.extractCssClasses(frontmatter.cssclasses),
      ...this.extractCssClasses(frontmatter.cssclass),
      ...this.extractCssClasses(frontmatter["css-classes"]),
    ];

    return cssClasses.some((className) =>
      this.settings.markerClasses.includes(className)
    );
  }

  extractCssClasses(value) {
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.extractCssClasses(item));
    }

    if (typeof value === "string") {
      return value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  applyBibleEmbedInfo(info) {
    const { el } = info;

    el.classList.add("bible-embed");
    el.classList.remove("bible-embed-repeated-title", "bible-embed-has-next");
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

    el.classList.remove(
      "bible-embed",
      "bible-embed-repeated-title",
      "bible-embed-has-next"
    );
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
      if (index === headings.length - 1) {
        row.classList.add("bible-verse-last-row");
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
        previous.el.classList.add("bible-embed-has-next");
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

class BibleEmbedStyleSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Bible Embed Style" });

    new Setting(containerEl)
      .setName("Bible root folders")
      .setDesc(
        "One folder per line. Files under these folders are treated as Bible chapters."
      )
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.bibleRoots.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.bibleRoots = this.plugin.normalizeList(value);
            await this.plugin.saveSettings();
          });

        text.inputEl.rows = 4;
        text.inputEl.cols = 42;
      });

    new Setting(containerEl)
      .setName("Bible marker CSS classes")
      .setDesc(
        "Comma- or line-separated frontmatter cssclasses. Files with these classes are treated as Bible chapters even if their folder changes."
      )
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.markerClasses.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.markerClasses = this.plugin.normalizeList(value);
            await this.plugin.saveSettings();
          });

        text.inputEl.rows = 3;
        text.inputEl.cols = 42;
      });

    new Setting(containerEl)
      .setName("Reset defaults")
      .setDesc("Restore the default Bible folder and marker class.")
      .addButton((button) => {
        button.setButtonText("Reset").onClick(async () => {
          this.plugin.settings = this.plugin.normalizeSettings(DEFAULT_SETTINGS);
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }
}

import { join, posix, SEP } from "../deps/path.ts";
import SiteSource from "./source.ts";
import ScriptRunner from "./scripts.ts";
import PerformanceMetrics from "./metrics.ts";
import SiteRenderer from "./renderer.ts";
import SiteEmitter from "./emitter.ts";
import textLoader from "./loaders/text.ts";
import binaryLoader from "./loaders/binary.ts";
import {
  Command,
  CommandOptions,
  Emitter,
  Engine,
  Event,
  EventListener,
  EventType,
  Helper,
  HelperOptions,
  Loader,
  Metrics,
  Page,
  Plugin,
  Processor,
  Renderer,
  Scripts,
  Site,
  SiteOptions,
  Source,
} from "../core.ts";
import { concurrent, Exception, merge, normalizePath } from "./utils.ts";

const defaults: SiteOptions = {
  cwd: Deno.cwd(),
  src: "./",
  dest: "./_site",
  includes: "_includes",
  location: new URL("http://localhost"),
  metrics: false,
  quiet: false,
  dev: false,
  prettyUrls: true,
  flags: [],
  server: {
    port: 3000,
    open: false,
    page404: "/404.html",
  },
};

/**
 * This is the heart of Lume,
 * a class that contains everything needed to build the site
 */
export default class LumeSite implements Site {
  options: SiteOptions;
  source: Source;
  scripts: Scripts;
  metrics: Metrics;
  listeners: Map<EventType, Set<EventListener | string>> = new Map();
  renderer: Renderer;
  emitter: Emitter;
  pages: Page[] = [];

  constructor(options: Partial<SiteOptions> = {}) {
    this.options = merge(defaults, options);
    this.source = new SiteSource(this);
    this.scripts = new ScriptRunner(this);
    this.metrics = new PerformanceMetrics(this);
    this.renderer = new SiteRenderer(this);
    this.emitter = new SiteEmitter(this);

    // Ignore the dest directory if it's inside src
    if (this.dest().startsWith(this.src())) {
      this.ignore(this.options.dest);
    }
  }

  src(...path: string[]) {
    return join(this.options.cwd, this.options.src, ...path);
  }

  dest(...path: string[]) {
    return join(this.options.cwd, this.options.dest, ...path);
  }

  addEventListener(type: EventType, listener: EventListener | string) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return this;
  }

  async dispatchEvent(event: Event) {
    const type = event.type;
    const listeners = this.listeners.get(type);

    if (!listeners) {
      return true;
    }

    for (const listener of listeners) {
      if (typeof listener === "string") {
        const success = await this.run(listener);

        if (!success) {
          return false;
        }

        continue;
      }

      if (await listener(event) === false) {
        return false;
      }
    }
    return true;
  }

  get flags() {
    return this.options.flags || [];
  }

  use(plugin: Plugin) {
    plugin(this);
    return this;
  }

  script(name: string, ...scripts: Command[]) {
    this.scripts.set(name, ...scripts);
    return this;
  }

  loadData(extensions: string[], loader: Loader) {
    this.source.addDataLoader(extensions, loader);
    return this;
  }

  loadPages(extensions: string[], loader?: Loader, engine?: Engine) {
    this.source.addPageLoader(extensions, loader || textLoader, false);

    if (engine) {
      this.renderer.addEngine(extensions, engine);
    }

    return this;
  }

  loadAssets(extensions: string[], loader?: Loader) {
    this.source.addPageLoader(extensions, loader || textLoader, true);
    return this;
  }

  preprocess(extensions: string[], preprocessor: Processor) {
    this.renderer.addPreprocessor(extensions, preprocessor);
    return this;
  }

  process(extensions: string[], processor: Processor) {
    this.renderer.addProcessor(extensions, processor);
    return this;
  }

  filter(name: string, filter: Helper, async = false) {
    return this.helper(name, filter, { type: "filter", async });
  }

  helper(name: string, fn: Helper, options: HelperOptions) {
    this.renderer.addHelper(name, fn, options);
    return this;
  }

  data(name: string, data: unknown) {
    this.renderer.addData(name, data);
    return this;
  }

  copy(from: string, to = from) {
    this.source.addStaticFile(join("/", from), join("/", to));
    return this;
  }

  ignore(...paths: string[]) {
    paths.forEach((path) => this.source.addIgnoredPath(join("/", path)));
    return this;
  }

  async clear() {
    await this.emitter.clear();
  }

  async build() {
    const buildMetric = this.metrics.start("Build (entire site)");
    await this.dispatchEvent({ type: "beforeBuild" });
    await this.clear();

    let metric = this.metrics.start("Copy (all files)");
    for (const [from, to] of this.source.staticFiles) {
      await this.emitter.copyFile(from, to);
    }
    metric.stop();

    metric = this.metrics.start("Load (all pages)");
    await this.source.loadDirectory();
    metric.stop();

    metric = this.metrics.start(
      "Preprocess + render + process (all pages)",
    );
    await this.renderer.buildPages(this.source.pages);
    metric.stop();

    await this.dispatchEvent({ type: "beforeSave" });

    // Save the pages
    metric = this.metrics.start("Save (all pages)");
    await concurrent(
      this.pages,
      (page) => this.emitter.savePage(page),
    );
    metric.stop();

    buildMetric.stop();
    await this.dispatchEvent({ type: "afterBuild" });

    // Print or save the collected metrics
    const { metrics } = this.options;

    if (typeof metrics === "string") {
      await this.metrics.save(join(this.options.cwd, metrics));
    } else if (metrics) {
      this.metrics.print();
    }
  }

  async update(files: Set<string>) {
    await this.dispatchEvent({ type: "beforeUpdate", files });

    for (const file of files) {
      // It's a static file
      const entry = this.source.isStatic(file);

      if (entry) {
        const [from, to] = entry;

        await this.emitter.copyFile(file, join(to, file.slice(from.length)));
        continue;
      }

      // It's an ignored file
      if (this.source.isIgnored(file)) {
        continue;
      }

      const normalized = normalizePath(file);

      // It's inside a _data file or directory
      if (/\/_data(?:\.\w+$|\/)/.test(normalized)) {
        await this.source.loadFile(file);
        continue;
      }

      // Any path segment starts with _ or .
      if (normalized.includes("/_") || normalized.includes("/.")) {
        continue;
      }

      // Default
      await this.source.loadFile(file);
    }

    await this.renderer.buildPages(this.source.pages);
    await this.dispatchEvent({ type: "beforeSave" });
    await concurrent(
      this.pages,
      (page) => this.emitter.savePage(page),
    );
    await this.dispatchEvent({ type: "afterUpdate", files });
  }

  async run(name: string, options: CommandOptions = {}) {
    return await this.scripts.run(options, name);
  }

  url(path: string, absolute = false) {
    if (
      path.startsWith("./") || path.startsWith("../") ||
      path.startsWith("?") || path.startsWith("#") || path.startsWith("//")
    ) {
      return path;
    }

    // It's a source file
    if (path.startsWith("~/")) {
      path = path.slice(1).replaceAll("/", SEP);
      path = decodeURI(path);

      // It's a page
      const page = this.pages.find((page) =>
        page.src.path + page.src.ext === path
      );

      if (page) {
        path = page.data.url as string;
      } else {
        // It's a static file
        const entry = this.source.isStatic(path);

        if (entry) {
          const [from, to] = entry;
          path = normalizePath(join(to, path.slice(from.length)));
        } else {
          throw new Exception("Source file not found", { path });
        }
      }
    } else {
      // Absolute URLs are returned as is
      try {
        return new URL(path).href;
      } catch {
        // Ignore error
      }
    }

    if (!path.startsWith(this.options.location.pathname)) {
      path = posix.join(this.options.location.pathname, path);
    }

    return absolute ? this.options.location.origin + path : path;
  }

  /** Returns the content of a file or page */
  async getFileContent(url: string): Promise<string | Uint8Array> {
    // Is a loaded file
    const page = this.pages.find((page) => page.data.url === url);

    if (page) {
      return page.content as string | Uint8Array;
    }

    // Is a static file
    for (const entry of this.source.staticFiles) {
      const [from, to] = entry;

      if (url.startsWith(to)) {
        const file = this.src(from, url.slice(to.length));
        const content = await this.source.load(file, binaryLoader);
        return content.content as Uint8Array;
      }
    }

    // Is a source file
    const content = await this.source.load(this.src(url), binaryLoader);
    return content.content as Uint8Array;
  }
}

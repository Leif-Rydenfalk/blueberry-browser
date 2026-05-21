import { NativeImage, WebContentsView } from "electron";
import { join } from "path";

// Injected into the page to build a compact list of interactive elements.
// Uses only ES5 to stay compatible with any page environment.
const INTERACTIVE_ELEMENTS_SCRIPT = `(function(){
  var TAGS=['button','a[href]','input:not([type=hidden]):not([disabled])','select:not([disabled])','textarea:not([disabled])','[role=button]','[role=link]','[role=menuitem]','[role=tab]','[contenteditable=true]'];
  var seen=typeof WeakSet!=='undefined'?new WeakSet():null;
  var items=[];
  function esc(s){return s?String(s).replace(/\\s+/g,' ').trim().substring(0,50):'';}
  for(var ti=0;ti<TAGS.length;ti++){
    try{
      var els=document.querySelectorAll(TAGS[ti]);
      for(var ei=0;ei<els.length;ei++){
        var el=els[ei];
        if(seen){if(seen.has(el))continue;seen.add(el);}
        var r=el.getBoundingClientRect();
        if(!r.width&&!r.height)continue;
        if(r.bottom<-300||r.top>window.innerHeight+600)continue;
        var t=el.tagName.toLowerCase();
        var lbl=esc(el.innerText||el.value||el.placeholder||el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title'));
        var sel;
        if(el.id){sel='#'+el.id;}
        else if(el.getAttribute('name')){sel=t+'[name="'+el.getAttribute('name')+'"]';}
        else if(el.getAttribute('data-testid')){sel='[data-testid="'+el.getAttribute('data-testid')+'"]';}
        else{var cls=typeof el.className==='string'?el.className.split(' ').filter(Boolean).slice(0,2).join('.'):'';sel=t+(cls?'.'+cls:'');}
        var extra='';
        if(t==='select'){var opts=[];for(var oi=0;oi<Math.min(el.options.length,8);oi++){opts.push('"'+esc(el.options[oi].text||el.options[oi].value)+'"');}extra=' opts=['+opts.join(',')+']';}
        else if(el.type==='radio'||el.type==='checkbox'){extra=' checked='+el.checked;}
        items.push(t+' '+sel+' "'+lbl+'"'+extra+' ('+Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2)+')');
        if(items.length>=60)break;
      }
    }catch(e){}
    if(items.length>=60)break;
  }
  return items.join('\\n');
})()` as const;

export class Tab {
  private webContentsView: WebContentsView;
  private _id: string;
  private _title: string;
  private _url: string;
  private _isVisible: boolean = false;

  constructor(id: string, url: string = "https://www.google.com") {
    this._id = id;
    this._url = url;
    this._title = "New Tab";

    // Create the WebContentsView for web content only.
    // The tabRecorder preload runs in an isolated world and only emits events
    // while a workflow recording is active — see src/preload/tabRecorder.ts.
    this.webContentsView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, "../preload/tabRecorder.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });

    // Set up event listeners
    this.setupEventListeners();

    // Load the initial URL
    this.loadURL(url);
  }

  private setupEventListeners(): void {
    // Update title when page title changes
    this.webContentsView.webContents.on("page-title-updated", (_, title) => {
      this._title = title;
    });

    // Update URL when navigation occurs
    this.webContentsView.webContents.on("did-navigate", (_, url) => {
      this._url = url;
    });

    this.webContentsView.webContents.on("did-navigate-in-page", (_, url) => {
      this._url = url;
    });
  }

  // Getters
  get id(): string {
    return this._id;
  }

  get title(): string {
    return this._title;
  }

  get url(): string {
    return this._url;
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  get webContents(): Electron.WebContents {
    return this.webContentsView.webContents;
  }

  get view(): WebContentsView {
    return this.webContentsView;
  }

  get nativeWebContents(): Electron.WebContents {
    return this.webContentsView.webContents;
  }

  // Public methods
  show(): void {
    this._isVisible = true;
    this.webContentsView.setVisible(true);
  }

  hide(): void {
    this._isVisible = false;
    this.webContentsView.setVisible(false);
  }

  async screenshot(options?: { maxWidth?: number }): Promise<NativeImage> {
    const image = await this.webContentsView.webContents.capturePage();
    if (options?.maxWidth) {
      const { width } = image.getSize();
      if (width > options.maxWidth) {
        return image.resize({ width: options.maxWidth, quality: "good" });
      }
    }
    return image;
  }

  async runJs(code: string): Promise<unknown> {
    return await this.webContentsView.webContents.executeJavaScript(code);
  }

  async getTabHtml(): Promise<string> {
    return (await this.runJs(
      "return document.documentElement.outerHTML",
    )) as string;
  }

  async getTabText(): Promise<string> {
    return (await this.runJs(
      "return document.documentElement.innerText",
    )) as string;
  }

  async getTextViaCDP(): Promise<string | null> {
    try {
      const debug = this.webContentsView.webContents.debugger;

      if (!debug.isAttached()) {
        debug.attach("1.3");
      }

      // Evaluate script via CDP - this runs in a different context
      const { result } = await debug.sendCommand("Runtime.evaluate", {
        expression: "document.body.innerText",
        returnByValue: true,
      });

      if (result && result.value) {
        return result.value.substring(0, 8000);
      }

      return null;
    } catch (error) {
      console.error("[Tab] CDP text extraction failed:", error);
      return null;
    }
  }

  async getInteractiveElements(): Promise<string | null> {
    try {
      const debug = this.webContentsView.webContents.debugger;
      if (!debug.isAttached()) {
        debug.attach("1.3");
      }
      const { result } = await debug.sendCommand("Runtime.evaluate", {
        expression: INTERACTIVE_ELEMENTS_SCRIPT,
        returnByValue: true,
      });
      if (result?.value && typeof result.value === "string") {
        return result.value;
      }
    } catch {
      // fall through to JS injection
    }
    try {
      const result = await this.runJs(INTERACTIVE_ELEMENTS_SCRIPT);
      return typeof result === "string" ? result : null;
    } catch {
      return null;
    }
  }

  loadURL(url: string): Promise<void> {
    this._url = url;
    return this.webContentsView.webContents.loadURL(url);
  }

  goBack(): void {
    if (this.webContentsView.webContents.navigationHistory.canGoBack()) {
      this.webContentsView.webContents.navigationHistory.goBack();
    }
  }

  goForward(): void {
    if (this.webContentsView.webContents.navigationHistory.canGoForward()) {
      this.webContentsView.webContents.navigationHistory.goForward();
    }
  }

  reload(): void {
    this.webContentsView.webContents.reload();
  }

  stop(): void {
    this.webContentsView.webContents.stop();
  }

  destroy(): void {
    this.webContentsView.webContents.close();
  }
}

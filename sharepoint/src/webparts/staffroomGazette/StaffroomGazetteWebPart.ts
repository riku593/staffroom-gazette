import { DisplayMode, Version } from '@microsoft/sp-core-library';
import {
  type IPropertyPaneConfiguration,
  PropertyPaneDropdown,
  PropertyPaneSlider,
  PropertyPaneTextField
} from '@microsoft/sp-property-pane';
import { BaseClientSideWebPart } from '@microsoft/sp-webpart-base';

import { SharePointHost } from './SharePointHost';
import { boardMarkup } from './legacy/boardMarkup';
import { boardCss } from './legacy/boardCss';
import { tvMarkup } from './legacy/tvMarkup';
import { tvCss } from './legacy/tvCss';
import { startBoard } from './legacy/board';
import { startTv } from './legacy/tv';
import { startTheme } from './legacy/theme';

export interface IStaffroomGazetteWebPartProps {
  mode: 'board' | 'tv';
  listTitle: string;
  libraryTitle: string;
  tvPageUrl: string;
  tvInterval: number;
  tvCategories: string;
  tvPages: number;
  tvTheme: 'dark' | 'light';
}

interface IDisposable { dispose(): void }

declare global {
  interface Window {
    PdfView: { setBase(url: string): void };
    Ocr: { setBase(url: string): void };
  }
}

function injectStyle(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

export default class StaffroomGazetteWebPart extends BaseClientSideWebPart<IStaffroomGazetteWebPartProps> {
  private host: SharePointHost | undefined;
  private running: IDisposable[] = [];
  private restoreOverflow: string | null = null;

  protected async onInit(): Promise<void> {
    // PDF.js and Tesseract ship with the package (see config/spfx-customize-webpack.js).
    const base = this.context.manifest.loaderConfig.internalModuleBaseUrls[0];
    window.PdfView.setBase(`${base}vendor/pdfjs/`);
    window.Ocr.setBase(`${base}vendor/tesseract/`);
    return super.onInit();
  }

  public render(): void {
    this.stop();
    this.host = new SharePointHost(this.context, {
      listTitle: this.properties.listTitle,
      libraryTitle: this.properties.libraryTitle,
      tvPageUrl: this.properties.tvPageUrl,
    });
    this.domElement.innerHTML = '<p style="padding:16px;font:14px system-ui">Loading Staffroom Gazette…</p>';
    this.start(this.host).catch((e: Error) => this.showMessage("Staffroom Gazette couldn't start", e.message));
  }

  private async start(host: SharePointHost): Promise<void> {
    const ready = await host.init();
    if (host !== this.host) return; // re-rendered meanwhile
    if (!ready) return this.showSetup(host);

    if (this.properties.mode === 'tv') {
      injectStyle('sg-tv-css', tvCss);
      const root = document.createElement('div');
      root.className = 'sg-tv';
      root.innerHTML = tvMarkup;
      this.domElement.replaceChildren(root);
      // On the live page the TV covers everything (SharePoint header included); while editing it's a preview.
      if (this.displayMode === DisplayMode.Read) {
        root.classList.add('overlay');
        this.restoreOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
      }
      host.root = root;
      const q = new URLSearchParams();
      q.set('interval', String(this.properties.tvInterval || 15));
      q.set('pages', String(this.properties.tvPages || 8));
      if (this.properties.tvCategories) q.set('category', this.properties.tvCategories);
      if (this.properties.tvTheme === 'light') q.set('theme', 'light');
      // Values in the page address (e.g. ?interval=30) override the settings.
      new URLSearchParams(location.search).forEach((v, k) => q.set(k, v));
      host.tvQuery = q.toString();
      this.running.push(startTv(host));
    } else {
      injectStyle('sg-board-css', boardCss);
      const root = document.createElement('div');
      root.className = 'sg-board';
      root.innerHTML = boardMarkup;
      this.domElement.replaceChildren(root);
      host.root = root;
      const tvLink = root.querySelector<HTMLAnchorElement>('[data-sg-tv]');
      if (tvLink) {
        if (this.properties.tvPageUrl) {
          tvLink.href = this.properties.tvPageUrl;
          tvLink.target = '_blank';
          tvLink.rel = 'noopener';
        } else {
          tvLink.remove();
          root.querySelector('.footer .sep')?.remove();
        }
      }
      this.running.push(startTheme(root));
      this.running.push(startBoard(host));
      host.cleanOrphans().catch(() => { /* housekeeping only */ });
    }
    this.running.push(host);
  }

  private showMessage(title: string, text: string): void {
    const box = document.createElement('div');
    box.setAttribute('style', 'padding:20px;border:1px solid #d9cfbd;border-radius:10px;font:15px system-ui;background:#fffdf8;color:#1d1a16');
    const h = document.createElement('h3');
    h.textContent = title;
    h.setAttribute('style', 'margin:0 0 8px;font-family:Georgia,serif');
    const p = document.createElement('p');
    p.textContent = text;
    p.setAttribute('style', 'margin:0');
    box.append(h, p);
    this.domElement.replaceChildren(box);
  }

  private showSetup(host: SharePointHost): void {
    if (!host.canManage) {
      this.showMessage('Staffroom Gazette isn’t set up on this site yet',
        `A site owner needs to open this page and click "Set up". It creates a "${this.properties.listTitle}" list for notices and a "${this.properties.libraryTitle}" library for PDFs and images.`);
      return;
    }
    this.showMessage('Set up Staffroom Gazette on this site',
      `This creates a "${this.properties.listTitle}" list for notices and a "${this.properties.libraryTitle}" library for PDFs and images. ` +
      'Afterwards, give your HR team "Contribute" (edit) permission on both, and everyone else "Read".');
    const button = document.createElement('button');
    button.textContent = 'Set up';
    button.setAttribute('style', 'margin-top:14px;padding:8px 18px;border-radius:999px;border:0;background:#1d1a16;color:#fff;font:600 14px system-ui;cursor:pointer');
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Setting up…';
      host.setup().then(() => this.render()).catch((e: Error) => {
        button.disabled = false;
        button.textContent = 'Try again';
        this.showMessage('Setup failed', e.message);
      });
    });
    this.domElement.firstElementChild?.appendChild(button);
  }

  private stop(): void {
    while (this.running.length) {
      try { this.running.pop()!.dispose(); } catch { /* ignore */ }
    }
    if (this.restoreOverflow !== null) {
      document.documentElement.style.overflow = this.restoreOverflow;
      this.restoreOverflow = null;
    }
  }

  protected onDisplayModeChanged(): void {
    this.render();
  }

  protected onDispose(): void {
    this.stop();
    super.onDispose();
  }

  protected get dataVersion(): Version {
    return Version.parse('1.0');
  }

  protected get disableReactivePropertyChanges(): boolean {
    return true; // apply settings when the panel's "Apply" is clicked, not on every keystroke
  }

  protected getPropertyPaneConfiguration(): IPropertyPaneConfiguration {
    const tv = this.properties.mode === 'tv';
    return {
      pages: [
        {
          header: { description: 'Staffroom Gazette shows HR notices. Use "Board" on your intranet page, and "TV display" on a separate page opened full screen on the staffroom TV.' },
          groups: [
            {
              groupName: 'Display',
              groupFields: [
                PropertyPaneDropdown('mode', {
                  label: 'Show as',
                  options: [
                    { key: 'board', text: 'Board (notices for staff, posting for HR)' },
                    { key: 'tv', text: 'TV display (full screen slideshow)' },
                  ],
                }),
                ...(tv
                  ? [
                    PropertyPaneSlider('tvInterval', { label: 'Seconds per slide', min: 5, max: 120, step: 5 }),
                    PropertyPaneSlider('tvPages', { label: 'Most PDF pages per notice', min: 1, max: 20, step: 1 }),
                    PropertyPaneTextField('tvCategories', { label: 'Only these categories (optional)', description: 'Comma-separated, e.g. Events, People' }),
                    PropertyPaneDropdown('tvTheme', { label: 'Colours', options: [{ key: 'dark', text: 'Dark (best for TVs)' }, { key: 'light', text: 'Light' }] }),
                  ]
                  : [
                    PropertyPaneTextField('tvPageUrl', { label: 'TV page address (optional)', description: 'The page where this web part is set to "TV display". Adds a "TV display" link for HR.' }),
                  ]),
              ],
            },
            {
              groupName: 'Storage',
              groupFields: [
                PropertyPaneTextField('listTitle', { label: 'Notices list', description: 'Created by "Set up" if it doesn’t exist.' }),
                PropertyPaneTextField('libraryTitle', { label: 'Files library', description: 'Where PDFs and images are stored.' }),
              ],
            },
          ],
        },
      ],
    };
  }
}

/*
 * SharePoint back end for Staffroom Gazette.
 *
 * The board and TV code (ported from the self-hosted version) talk to a small
 * "API". In the self-hosted version that was a Node server; here this class
 * answers the same calls using SharePoint:
 *   - notices  -> a list   ("Gazette Notices" by default)
 *   - files    -> a library ("Gazette Files" by default)
 *   - sign-in  -> Microsoft 365; "HR" = anyone who can add items to the list
 */
/* eslint-disable @rushstack/no-new-null -- SharePoint's REST API returns null for empty fields */
import { SPHttpClient, type SPHttpClientResponse } from '@microsoft/sp-http';
import type { WebPartContext } from '@microsoft/sp-webpart-base';
import * as PdfText from './legacy/pdftext';

export const CATEGORIES = ['General', 'Policy', 'Events', 'Benefits', 'Health & Safety', 'Training', 'People', 'IT & Facilities'];
export const PRIORITIES = ['normal', 'important', 'urgent'];
const TV_MODES = ['auto', 'pages', 'text'];
const MAX_FILE_MB = 25;
const MAX_TEXT = 15000;

// SharePoint permission bits (SP.PermissionKind), low word.
const PERM_ADD_ITEMS = 0x2;
const PERM_MANAGE_LISTS = 0x800;

export interface IAttachment {
  id: string;
  url: string;
  downloadUrl?: string;
  name: string;
  size: number;
  kind: 'pdf' | 'image';
  ext: string;
  pages: number | null;
  hasText: boolean;
  textHeavy: boolean;
  text?: string;
  textSource?: 'pdf' | 'ocr' | null;
  ocr?: { verifiedBy: string; verifiedAt: string; confidence: number | null } | null;
}

export interface INotice {
  id: string;
  title: string;
  body: string;
  category: string;
  priority: string;
  pinned: boolean;
  publishAt: string | null;
  expiresAt: string | null;
  tvMode: string;
  attachment: IAttachment | null;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  editedBy?: string;
}

interface IListItem {
  Id: number;
  Title: string;
  GzBody: string | null;
  GzCategory: string | null;
  GzPriority: string | null;
  GzPinned: boolean | null;
  GzPublishAt: string | null;
  GzExpiresAt: string | null;
  GzTvMode: string | null;
  GzAttachment: string | null;
  GzText: string | null;
  Created: string;
  Modified: string;
  Author?: { Title: string };
  Editor?: { Title: string };
}

interface IUploadInfo { text: string; hasText: boolean; textHeavy: boolean; pages: number | null }

class ApiError extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// The PDF-reading code is ported as-is from the self-hosted version (untyped), so give it a signature here.
const { analysePdf, suggestFromParagraphs } = PdfText as unknown as {
  analysePdf(data: ArrayBuffer, opts: { categories: string[] }): Promise<{ pages: number; text: string; hasText: boolean; textHeavy: boolean; suggestions: Json }>;
  suggestFromParagraphs(paras: { text: string; size: number; y: number }[], pageHeight: number, categories: string[], fullText?: string): Json;
};

const FILE_SIGNATURES: { ext: string; kind: 'pdf' | 'image'; test: (b: Uint8Array) => boolean }[] = [
  { ext: 'pdf', kind: 'pdf', test: (b) => new TextDecoder('latin1').decode(b.subarray(0, 1024)).includes('%PDF-') },
  { ext: 'jpg', kind: 'image', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', kind: 'image', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    ext: 'webp', kind: 'image',
    test: (b) => new TextDecoder('latin1').decode(b.subarray(0, 4)) === 'RIFF' && new TextDecoder('latin1').decode(b.subarray(8, 12)) === 'WEBP',
  },
];

const odataEscape = (s: string): string => s.replace(/'/g, "''");
const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export class SharePointHost {
  public root!: HTMLElement;
  public tvQuery = '';
  public canEdit = false;
  public canManage = false;

  private readonly ctx: WebPartContext;
  private readonly listTitle: string;
  private readonly libraryTitle: string;
  private readonly tvPageUrl: string;
  private readonly web: string;
  private libraryRoot = '';
  private listUrl = '';
  private uploads = new Map<string, IUploadInfo>();
  private cache: INotice[] | null = null;
  private timers: number[] = [];

  constructor(ctx: WebPartContext, opts: { listTitle: string; libraryTitle: string; tvPageUrl: string }) {
    this.ctx = ctx;
    this.listTitle = opts.listTitle || 'Gazette Notices';
    this.libraryTitle = opts.libraryTitle || 'Gazette Files';
    this.tvPageUrl = opts.tvPageUrl || '';
    this.web = ctx.pageContext.web.absoluteUrl;
  }

  public get userName(): string {
    return this.ctx.pageContext.user.displayName;
  }

  /* ------------------------------------------------------------------ */
  /* REST helpers                                                        */
  /* ------------------------------------------------------------------ */

  private async request(path: string, init: { method?: string; body?: Json; headers?: Record<string, string>; raw?: BodyInit } = {}): Promise<Json> {
    const url = path.startsWith('http') ? path : `${this.web}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json;odata=nometadata', ...(init.headers || {}) };
    let body: BodyInit | undefined;
    if (init.raw !== undefined) body = init.raw;
    else if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json;odata=nometadata';
      body = JSON.stringify(init.body);
    }
    const res: SPHttpClientResponse = init.method && init.method !== 'GET'
      ? await this.ctx.spHttpClient.post(url, SPHttpClient.configurations.v1, { headers, body })
      : await this.ctx.spHttpClient.get(url, SPHttpClient.configurations.v1, { headers });
    if (!res.ok) {
      let message = `SharePoint returned ${res.status}`;
      try {
        const data: Json = await res.json();
        message = (data['odata.error'] && data['odata.error'].message && data['odata.error'].message.value) || (data.error && data.error.message) || message;
      } catch { /* not JSON */ }
      throw new ApiError(res.status, message);
    }
    if (res.status === 204) return {};
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  private listPath(sub = ''): string {
    return `/_api/web/lists/getbytitle('${odataEscape(this.listTitle)}')${sub}`;
  }

  private static hasPerm(perms: Json, bit: number): boolean {
    return (Number(perms && perms.Low) & bit) === bit;
  }

  /* ------------------------------------------------------------------ */
  /* Setup and permissions                                               */
  /* ------------------------------------------------------------------ */

  /** Returns false if the list doesn't exist yet (someone needs to run setup). */
  public async init(): Promise<boolean> {
    const webPerms = await this.request('/_api/web/EffectiveBasePermissions');
    this.canManage = SharePointHost.hasPerm(webPerms, PERM_MANAGE_LISTS);
    try {
      const list = await this.request(this.listPath('?$select=Id,RootFolder/ServerRelativeUrl&$expand=RootFolder'));
      this.listUrl = `${new URL(this.web).origin}${list.RootFolder ? list.RootFolder.ServerRelativeUrl : ''}`;
    } catch (e) {
      if ((e as ApiError).status === 404) return false;
      throw e;
    }
    const perms = await this.request(this.listPath('/EffectiveBasePermissions'));
    this.canEdit = SharePointHost.hasPerm(perms, PERM_ADD_ITEMS);
    const lib = await this.request(`/_api/web/lists/getbytitle('${odataEscape(this.libraryTitle)}')/RootFolder?$select=ServerRelativeUrl`);
    this.libraryRoot = lib.ServerRelativeUrl;
    return true;
  }

  /** Creates the notices list and files library (site owners only). */
  public async setup(): Promise<void> {
    const exists = async (title: string): Promise<boolean> => {
      try {
        await this.request(`/_api/web/lists/getbytitle('${odataEscape(title)}')?$select=Id`);
        return true;
      } catch (e) {
        if ((e as ApiError).status === 404) return false;
        throw e;
      }
    };
    if (!(await exists(this.libraryTitle))) {
      await this.request('/_api/web/lists', {
        method: 'POST',
        body: { BaseTemplate: 101, Title: this.libraryTitle, Description: 'PDFs and images posted on Staffroom Gazette.' },
      });
    }
    if (!(await exists(this.listTitle))) {
      await this.request('/_api/web/lists', {
        method: 'POST',
        body: { BaseTemplate: 100, Title: this.listTitle, Description: 'Notices shown on Staffroom Gazette. Edit them through the Gazette web part.' },
      });
      const choice = (name: string, display: string, values: string[], def: string): string =>
        `<Field Type="Choice" Name="${name}" StaticName="${name}" DisplayName="${display}" Format="Dropdown"><Default>${xmlEscape(def)}</Default><CHOICES>${values.map((v) => `<CHOICE>${xmlEscape(v)}</CHOICE>`).join('')}</CHOICES></Field>`;
      const fields = [
        '<Field Type="Note" Name="GzBody" StaticName="GzBody" DisplayName="Message" NumLines="6" RichText="FALSE" />',
        choice('GzCategory', 'Category', CATEGORIES, 'General'),
        choice('GzPriority', 'Priority', PRIORITIES, 'normal'),
        '<Field Type="Boolean" Name="GzPinned" StaticName="GzPinned" DisplayName="Pinned"><Default>0</Default></Field>',
        '<Field Type="DateTime" Name="GzPublishAt" StaticName="GzPublishAt" DisplayName="Publish from" Format="DateTime" />',
        '<Field Type="DateTime" Name="GzExpiresAt" StaticName="GzExpiresAt" DisplayName="Take down on" Format="DateTime" />',
        choice('GzTvMode', 'TV display', TV_MODES, 'auto'),
        '<Field Type="Note" Name="GzAttachment" StaticName="GzAttachment" DisplayName="Attachment details" NumLines="3" RichText="FALSE" />',
        '<Field Type="Note" Name="GzText" StaticName="GzText" DisplayName="Text from PDF or image" NumLines="6" RichText="FALSE" />',
      ];
      for (const SchemaXml of fields) {
        // 8 = use the Name as the internal name, 16 = add to the default view
        await this.request(this.listPath('/fields/CreateFieldAsXml'), { method: 'POST', body: { parameters: { SchemaXml, Options: 8 | 16 } } });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Notices                                                             */
  /* ------------------------------------------------------------------ */

  private downloadUrlFor(url: string): string {
    return `${this.web}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(decodeURI(url))}`;
  }

  private toNotice(item: IListItem): INotice {
    let attachment: IAttachment | null = null;
    if (item.GzAttachment) {
      try {
        attachment = JSON.parse(item.GzAttachment) as IAttachment;
        attachment.text = item.GzText || '';
        attachment.downloadUrl = this.downloadUrlFor(attachment.url);
      } catch { attachment = null; }
    }
    return {
      id: String(item.Id),
      title: item.Title || '',
      body: item.GzBody || '',
      category: item.GzCategory || 'General',
      priority: item.GzPriority || 'normal',
      pinned: !!item.GzPinned,
      publishAt: item.GzPublishAt || null,
      expiresAt: item.GzExpiresAt || null,
      tvMode: item.GzTvMode || 'auto',
      attachment,
      authorName: (item.Author && item.Author.Title) || 'HR',
      createdAt: item.Created,
      updatedAt: item.Modified,
      editedBy: item.Editor && item.Editor.Title,
    };
  }

  private async loadAll(): Promise<INotice[]> {
    const select = 'Id,Title,GzBody,GzCategory,GzPriority,GzPinned,GzPublishAt,GzExpiresAt,GzTvMode,GzAttachment,GzText,Created,Modified,Author/Title,Editor/Title';
    const data = await this.request(this.listPath(`/items?$select=${select}&$expand=Author,Editor&$top=2000&$orderby=Created desc`));
    this.cache = (data.value as IListItem[]).map((i) => this.toNotice(i));
    return this.cache;
  }

  private static isLive(n: INotice, now = new Date().toISOString()): boolean {
    return (!n.publishAt || n.publishAt <= now) && (!n.expiresAt || n.expiresAt > now);
  }

  private static sort(list: INotice[]): INotice[] {
    const rank: Record<string, number> = { urgent: 0, important: 1, normal: 2 };
    return list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
      return (b.publishAt || b.createdAt).localeCompare(a.publishAt || a.createdAt);
    });
  }

  private validate(input: Json, previous: INotice | null): Record<string, Json> {
    const str = (v: Json, max: number, field: string, required = false): string => {
      if (v === undefined || v === null) v = '';
      if (typeof v !== 'string') throw new ApiError(400, `${field} must be text`);
      v = v.trim();
      if (required && !v) throw new ApiError(400, `${field} is required`);
      if (v.length > max) throw new ApiError(400, `${field} is too long (max ${max} characters)`);
      return v;
    };
    const date = (v: Json, field: string): string | null => {
      if (!v) return null;
      const d = new Date(v);
      if (isNaN(d.getTime())) throw new ApiError(400, `${field} is not a valid date`);
      return d.toISOString();
    };

    let attachment: IAttachment | null = null;
    let text = '';
    const a = input.attachment;
    if (a) {
      const prev = previous && previous.attachment && previous.attachment.id === a.id ? previous.attachment : null;
      const uploaded = this.uploads.get(a.id);
      if (!prev && !uploaded) throw new ApiError(400, 'The attached file could not be found. Please upload it again.');
      const base: IAttachment = prev || a;
      attachment = {
        id: base.id, url: base.url, name: str(a.name || base.name, 200, 'File name') || 'notice', size: base.size,
        kind: base.kind, ext: base.ext, pages: base.pages, hasText: !!base.hasText, textHeavy: !!base.hasText && !!base.textHeavy,
        textSource: null, ocr: null,
      };
      if (attachment.hasText) {
        text = uploaded ? uploaded.text : (prev && prev.text) || '';
        attachment.textSource = 'pdf';
      } else if (typeof a.ocrText === 'string') {
        // Text read from an image (OCR) is only accepted once HR has checked it.
        if (a.ocrVerified !== true) throw new ApiError(400, 'Please check the text read from the image and confirm it before publishing.');
        text = str(a.ocrText, MAX_TEXT, 'Text from the image');
        const confidence = Number(a.ocrConfidence);
        attachment.ocr = text ? {
          verifiedBy: this.userName, verifiedAt: new Date().toISOString(),
          confidence: Number.isFinite(confidence) ? Math.round(Math.min(100, Math.max(0, confidence))) : null,
        } : null;
      } else if (prev && prev.textSource === 'ocr') {
        text = prev.text || '';
        attachment.ocr = prev.ocr || null;
      }
      if (!attachment.hasText && text) attachment.textSource = 'ocr';
    }

    const publishAt = date(input.publishAt, 'Publish date');
    const expiresAt = date(input.expiresAt, 'Expiry date');
    if (publishAt && expiresAt && expiresAt <= publishAt) throw new ApiError(400, 'Expiry date must be after the publish date');
    return {
      Title: str(input.title, 150, 'Title', true),
      GzBody: str(input.body, 10000, 'Message', !attachment),
      GzCategory: CATEGORIES.includes(input.category) ? input.category : 'General',
      GzPriority: PRIORITIES.includes(input.priority) ? input.priority : 'normal',
      GzPinned: !!input.pinned,
      GzPublishAt: publishAt,
      GzExpiresAt: expiresAt,
      GzTvMode: TV_MODES.includes(input.tvMode) ? input.tvMode : 'auto',
      GzAttachment: attachment ? JSON.stringify(attachment) : null,
      GzText: text ? text.slice(0, MAX_TEXT) : null,
    };
  }

  private async recycleFile(url: string): Promise<void> {
    try {
      await this.request(`/_api/web/GetFileByServerRelativePath(decodedurl='${odataEscape(decodeURI(url))}')/recycle()`, { method: 'POST' });
    } catch { /* already gone */ }
  }

  /** Answers the same calls the board/TV made to the Node server. */
  public api = async (path: string, opts: { method?: string; body?: Json } = {}): Promise<Json> => {
    const method = opts.method || 'GET';
    const [route, query] = path.split('?');

    if (route === '/api/status') {
      return {
        needsSetup: false, canSetup: this.canManage,
        user: this.canEdit ? { displayName: this.userName } : null,
        categories: CATEGORIES, priorities: PRIORITIES, maxPdfMb: MAX_FILE_MB,
      };
    }

    if (route === '/api/suggest' && method === 'POST') {
      const b = opts.body || {};
      const paras = (Array.isArray(b.paragraphs) ? b.paragraphs : []).slice(0, 400)
        .map((x: Json) => ({ text: String((x && x.text) || '').slice(0, 2000).trim(), size: Number(x && x.size) || 10, y: Number(x && x.y) || 0 }))
        .filter((x: { text: string }) => x.text);
      return { suggestions: paras.length ? suggestFromParagraphs(paras, Number(b.pageHeight) || 1000, CATEGORIES, typeof b.text === 'string' ? b.text : undefined) : null };
    }

    if (route === '/api/notices' && method === 'GET') {
      const all = await this.loadAll();
      const includeAll = this.canEdit && /(^|&)all=1/.test(query || '');
      const now = new Date().toISOString();
      return { notices: SharePointHost.sort(all.filter((n) => includeAll || SharePointHost.isLive(n, now))), serverTime: now };
    }

    if (route === '/api/notices' && method === 'POST') {
      if (!this.canEdit) throw new ApiError(403, "You don't have permission to post notices");
      const fields = this.validate(opts.body, null);
      const item = await this.request(this.listPath('/items'), { method: 'POST', body: fields });
      if (opts.body.attachment) this.uploads.delete(opts.body.attachment.id);
      return { notice: { id: String(item.Id) } };
    }

    const m = route.match(/^\/api\/notices\/(\d+)$/);
    if (m) {
      const list = this.cache || (await this.loadAll());
      const notice = list.find((n) => n.id === m[1]) || (await this.loadAll()).find((n) => n.id === m[1]);
      if (!notice) throw new ApiError(404, 'Notice not found');
      if (method === 'GET') return { notice };
      if (!this.canEdit) throw new ApiError(403, "You don't have permission to change notices");
      if (method === 'PUT') {
        const fields = this.validate(opts.body, notice);
        await this.request(this.listPath(`/items(${notice.id})`), { method: 'POST', body: fields, headers: { 'IF-MATCH': '*', 'X-HTTP-Method': 'MERGE' } });
        const newId = opts.body.attachment && opts.body.attachment.id;
        if (notice.attachment && notice.attachment.id !== newId) await this.recycleFile(notice.attachment.url);
        if (newId) this.uploads.delete(newId);
        return { notice: { ...notice } };
      }
      if (method === 'DELETE') {
        await this.request(this.listPath(`/items(${notice.id})/recycle()`), { method: 'POST' });
        if (notice.attachment) await this.recycleFile(notice.attachment.url);
        return { ok: true };
      }
    }

    throw new ApiError(404, `Not supported here: ${method} ${route}`);
  };

  /* ------------------------------------------------------------------ */
  /* Files                                                               */
  /* ------------------------------------------------------------------ */

  /** Upload a PDF or image to the library and read its text (PDFs) in the browser. */
  public upload = async (file: File): Promise<{ attachment: IAttachment; suggestions: Json }> => {
    if (!this.canEdit) throw new ApiError(403, "You don't have permission to post notices");
    if (file.size > MAX_FILE_MB * 1048576) throw new ApiError(413, `That file is too large (max ${MAX_FILE_MB} MB)`);
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const type = bytes.length >= 12 ? FILE_SIGNATURES.find((t) => t.test(bytes)) : undefined;
    if (!type) throw new ApiError(400, "That file doesn't look like a valid PDF, JPG, PNG or WebP");

    const id = (crypto as Crypto & { randomUUID(): string }).randomUUID();
    const target = `${id}.${type.ext}`;
    const added = await this.request(
      `/_api/web/GetFolderByServerRelativePath(decodedurl='${odataEscape(this.libraryRoot)}')/Files/AddUsingPath(decodedurl='${target}',overwrite=false)`,
      { method: 'POST', raw: buffer },
    );
    const url = encodeURI(added.ServerRelativeUrl || `${this.libraryRoot}/${target}`);

    let info: IUploadInfo = { text: '', hasText: false, textHeavy: false, pages: 1 };
    let suggestions: Json = null;
    if (type.kind === 'pdf') {
      try {
        const r = await analysePdf(buffer, { categories: CATEGORIES });
        info = { text: r.text, hasText: r.hasText, textHeavy: r.textHeavy, pages: r.pages };
        suggestions = r.suggestions;
      } catch {
        info = { text: '', hasText: false, textHeavy: false, pages: null };
      }
    }
    this.uploads.set(id, info);
    const name = file.name.replace(/[\r\n"\\/]/g, '').slice(0, 200) || target;
    return {
      attachment: {
        id, url, downloadUrl: this.downloadUrlFor(url), name, size: file.size, kind: type.kind, ext: type.ext,
        pages: info.pages, hasText: info.hasText, textHeavy: info.textHeavy,
      },
      suggestions,
    };
  };

  /** Recycle uploads that were never published (e.g. the editor was cancelled). HR only. */
  public async cleanOrphans(): Promise<void> {
    if (!this.canEdit || !this.libraryRoot) return;
    const notices = this.cache || (await this.loadAll());
    const used = new Set(notices.map((n) => n.attachment && decodeURI(n.attachment.url)).filter(Boolean));
    const files = await this.request(`/_api/web/GetFolderByServerRelativePath(decodedurl='${odataEscape(this.libraryRoot)}')/Files?$select=ServerRelativeUrl,TimeCreated`);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of files.value || []) {
      if (!used.has(f.ServerRelativeUrl) && new Date(f.TimeCreated).getTime() < dayAgo) await this.recycleFile(f.ServerRelativeUrl);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Live updates, links                                                 */
  /* ------------------------------------------------------------------ */

  /** Calls back when the list changes (checked every 20 seconds; cheap). */
  public watch = (onChange: () => void): void => {
    let last = '';
    const check = async (): Promise<void> => {
      try {
        const l = await this.request(this.listPath('?$select=ItemCount,LastItemModifiedDate,LastItemDeletedDate'));
        const stamp = `${l.ItemCount}|${l.LastItemModifiedDate}|${l.LastItemDeletedDate}`;
        if (last && stamp !== last) onChange();
        last = stamp;
      } catch { /* offline for a moment */ }
    };
    check().catch(() => { /* handled inside */ });
    this.timers.push(window.setInterval(check, 20000));
  };

  public ping = async (): Promise<boolean> => {
    try {
      await this.request(this.listPath('?$select=Id'));
      return true;
    } catch {
      return false;
    }
  };

  public openTv = (): void => {
    if (this.tvPageUrl) window.open(this.tvPageUrl, '_blank', 'noopener');
    else alert('No TV page is set yet. Create a SharePoint page with this web part set to "TV display", then add its address in this web part\'s settings.');
  };

  public openList = (): void => {
    window.open(this.listUrl || this.web, '_blank', 'noopener');
  };

  public dispose(): void {
    for (const t of this.timers) window.clearInterval(t);
    this.timers = [];
  }
}

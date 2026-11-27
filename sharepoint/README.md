# Staffroom Gazette for SharePoint

This is the SharePoint Online version of Staffroom Gazette. It's a SharePoint Framework (SPFx 1.24) web part, so there's no server to run. Microsoft 365 handles sign-in, and notices and files live on your SharePoint site.

| | Self-hosted version (repo root) | SharePoint version (this folder) |
|---|---|---|
| Runs on | A Node.js server on your network | Your Microsoft 365 tenant |
| Sign-in | Gazette's own HR accounts | Microsoft 365. HR is anyone who can add items to the notices list |
| Notices | `data/gazette.json` | A SharePoint list ("Gazette Notices") |
| PDFs and images | `data/uploads/` | A document library ("Gazette Files") |
| PDF text, suggestions, OCR | On the server and in the browser | In the browser |
| Live updates | Instant | Within about 20 seconds |
| TV display | `/tv` | A SharePoint page with the web part set to "TV display" |

Everything else is the same code, ported by `tools/port-legacy.js`: the board, editor, PDF previews, suggestions, OCR with HR's check-before-publishing step, search inside PDFs, and the TV slideshow.

> **Status:** It builds and packages cleanly, and the ported board and TV were tested in a local harness against stand-in data. **It hasn't been installed on a real SharePoint site yet.** See "Things to check on first install" below.

## Build the package

You need Node.js 22.14+ (or 24).

```powershell
cd sharepoint
npm install
npm run build
```

This creates `sharepoint/solution/staffroom-gazette.sppkg` (about 10 MB, including the bundled PDF.js and Tesseract.js).

## Install (a SharePoint admin does this once)

1. Open the **SharePoint admin centre**, then **More features → Apps → App Catalog**, then **Apps for SharePoint**.
2. Upload `staffroom-gazette.sppkg`. When asked, tick **Make this app available to all sites**, then click **Deploy**.

## Add it to your HR site (a site owner)

1. Edit a page, click **+**, and add the **Staffroom Gazette** web part. It's in the *Advanced* section, or you can search for it.
2. The web part shows a **Set up** button. Click it to create the **Gazette Notices** list and the **Gazette Files** library on the site.
3. **Set permissions.** This is what makes someone "HR". In *Site contents*, open each of the two items, go to **Settings → Permissions**, choose **Stop inheriting permissions**, and then set:
   - your HR team: **Contribute** (they can post, edit and remove notices)
   - everyone else: **Read**
4. Publish the page. Staff see the board, and people with Contribute access also see the **HR menu** and the **+ New notice** button.

### The TV display

1. Create a new page, for example "Gazette TV". Use a single **full-width** section and add the Staffroom Gazette web part.
2. In the web part settings, set **Show as: TV display**. You can also set the seconds per slide, categories, PDF page limit and colours.
3. Publish the page. When it's viewed (not edited), the web part covers the whole page, SharePoint header included. Press **F** for full screen. **←** and **→** move between slides, and **Space** pauses.
4. On the board page's web part, paste the TV page's address into **TV page address**, so HR gets a "TV display" link.
5. **On the TV:** sign in with a Microsoft 365 account that can read the site, ideally a dedicated kiosk account, and open the TV page in a browser's kiosk mode. Your IT team may need to exempt that account from short sign-in timeouts.

You can override settings in the page address, for example `…/Gazette-TV.aspx?interval=30&category=Events`.

## Good to know

- **Scheduled notices:** they're hidden on the board until their publish date, but anyone with Read access could still open the list itself and see them. If that matters, keep the list out of the site navigation, or post scheduled notices closer to the date.
- **The OCR check** is enforced by the web part. People with edit access to the list can still change items directly in SharePoint, as with any list.
- **Removed notices and files** go to the site's **Recycle bin**, so they can be restored. Uploads that were never published are recycled after a day.
- **SharePoint search** also indexes the list, including the "Text from PDF or image" column.

## Things to check on first install

These can't be tested without a real tenant:

1. **Setup:** the **Set up** button creates the list (with columns) and the library.
2. **Posting:** posting, editing and removing a text notice, a PDF and an image all work.
3. **OCR and PDF previews:** OCR runs, and PDF previews render. Both use WebAssembly. If your tenant's content security policy blocks it, OCR shows "OCR couldn't read this image", PDFs may still render but without some image types, and the notices still post fine. Tell me if that happens.
4. **Office 365 public CDN:** if your tenant has the CDN turned on, the PDF and OCR engines load from the CDN. The code handles that, but check it once.
5. **TV display:** in view mode, the TV display covers the page.

## For developers

- **`tools/port-legacy.js`** regenerates `src/webparts/staffroomGazette/legacy/` from the self-hosted version (`../public`, `../lib`). Run `node tools/port-legacy.js` after changing those files, then rebuild.
- **`src/webparts/staffroomGazette/SharePointHost.ts`** is the SharePoint back end: REST calls to the list and library, permissions, setup and validation.
- **`config/spfx-customize-webpack.js`** copies `../public/vendor` (PDF.js and Tesseract.js) into the package.
- **`tools/harness/`** runs the compiled UI against stand-in data. After `npm run build`, run `node tools/harness/serve.js` and open `http://localhost:4400/?mode=board` or `?mode=tv`.

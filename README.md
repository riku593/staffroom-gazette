# The Staffroom Gazette

A self-hosted company noticeboard. HR posts notices, and everyone on the company network can read them on a desktop browser, a phone or a wall screen. Nothing is sent outside your network.

## Running it

You need [Node.js](https://nodejs.org) 18 or newer. There are no packages to install.

```powershell
npm start
```

The console prints two addresses:

- **On this computer:** `http://localhost:3000`
- **On your network:** something like `http://10.0.0.9:3000`. Share this one with staff.

To use a different port: `$env:PORT=8080; npm start`

### First run

Open `http://localhost:3000` **on the server computer itself** and create the first HR admin account. For security, setup can't be done from another device. (If the server has no screen, start it once with `$env:ALLOW_REMOTE_SETUP="1"`, finish setup, then restart without it.)

After that, sign in from any device with **HR sign in** and add the rest of the team from **HR menu → HR team accounts**.

### Letting phones and other PCs connect

Windows may ask whether to allow Node.js through the firewall the first time you start it. Choose **Private networks**. If devices still can't connect, add an inbound firewall rule for TCP port 3000.

On a phone, open the network address and use **Add to Home Screen** to get an app icon.

## Features

- **Reading needs no login.** Staff just open the page.
- **Front page.** Pinned and urgent notices sit at the top. Priorities are normal, important and urgent.
- **Categories and search.** Filter chips only show categories that currently have notices.
- **Scheduling.** Set a "publish from" date and a "take down on" date. Notices appear and disappear on their own. HR can switch on *Show scheduled & expired* to see everything.
- **PDF notices.** HR can post a PDF (a poster, letter or policy) as a notice, up to 25 MB. Use *Choose a PDF…* in the editor, or drag a PDF onto the board. Cards show a preview of the first page, and opening the notice shows every page. A written message is optional for PDF notices and appears as a summary. PDFs display on every device, including phones and TVs that have no PDF viewer of their own.
- **Reading the PDF for you.** When you attach a PDF, the Gazette reads its text and fills in the headline, a short summary and a category. If the PDF mentions upcoming dates (e.g. "Wednesday 10 December"), it offers them as one-click take-down dates. These are only suggestions, and an **Undo** link puts back what you had. Only dates written with a month name are recognised, because numbers like 04/05 mean different dates in different countries.
- **Image notices and OCR.** HR can also post JPG, PNG or WebP images, such as a poster from a design tool or a photo of a printed notice. Text in images and scanned PDFs is read with OCR (Tesseract.js, bundled and offline), in the HR person's browser.
  - **You check it first.** The recognised text appears next to the image, with a notice that it was read automatically and may contain mistakes. HR corrects it and clicks *I've checked it — use this text*, or chooses not to use it. Nothing is filled in from OCR text, and the notice can't be published, until one of those happens. The server enforces this too.
  - **Staff see it labelled.** In the reader, the text appears under *Text in this image (read by OCR, checked by …)*, with a note that the image itself is the official version. Search results and the TV mark it the same way.
  - **Accuracy:** OCR works well on clean printed text and poorly on angled or blurry photos, decorative fonts and handwriting. A confidence score is shown, with an extra warning when it's low. Only the first 3 pages of a scanned PDF are read. The first OCR after the page loads takes a few seconds longer while the engine starts.
- **Search inside PDFs.** Search looks through the text inside PDFs (and checked OCR text) too, and shows the passage that matched.
- **Live updates.** Open boards and TV displays refresh as soon as a notice is posted, edited or removed.
- **"New" badges.** Each device remembers which notices it has already seen.
- **Shareable links.** Opening a notice gives it its own URL (`/#notice-…`) that you can paste into email or chat.
- **Simple formatting.** Use `**bold**`, start lines with `- ` for bullets, and web and email addresses become links automatically.
- **Light/dark mode.** It follows the device setting until someone taps the sun/moon button. After that, each device remembers its own choice. The page also prints cleanly.

## TV dashboard

Open `/tv` on the TV's browser, for example `http://10.0.0.9:3000/tv`. It cycles through live notices full screen and shows a clock, a progress bar and what's coming up next.

- **Text notices** use large type that shrinks to fit. Urgent and important notices get a coloured stripe.
- **Letters and policies** (PDFs with lots of small text) are shown as their text in large type, split across up to 4 screens. Posters and anything picture-based are shown as pages. Image notices are shown full screen. Checked OCR text is only shown as text if HR picks *Its text, in large type*, and it's labelled as read by OCR. In the editor, *On the TV display, show* lets you override this for each notice.
- **Other PDF notices** are shown page by page. Portrait pages appear two at a time on a widescreen TV. Long PDFs show their first 8 pages, then move on.
- New, edited and removed notices are picked up automatically, and the current slide isn't interrupted unless it was the one that changed.
- **Controls:** press F or click *Full screen*. → skips ahead, ← goes back, and Space pauses. The cursor and buttons hide after 3 seconds.

You can add options to the address:

| Option | Example | What it does |
|---|---|---|
| `interval` | `/tv?interval=20` | Seconds per slide (default 15). Long text gets 50% longer. |
| `category` | `/tv?category=Events,People` | Only show these categories, e.g. one screen per area. |
| `pages` | `/tv?pages=4` | The most PDF pages to show per notice (default 8). |
| `theme` | `/tv?theme=light` | Light colours. The default is dark, which is easier on a TV. |

Combine options with `&`, for example `/tv?interval=20&category=Events`.

**Setting up the screen:** Any browser works, whether it's a smart-TV browser, a stick PC or a laptop plugged into the TV. For a screen that runs unattended, start the browser in kiosk mode so it opens full screen at startup. On Windows that's:

```powershell
& "C:Program Files (x86)MicrosoftEdgeApplicationmsedge.exe" --kiosk http://10.0.0.9:3000/tv --edge-kiosk-type=fullscreen
```

Also turn off sleep and the screensaver on that device. The page asks the screen to stay awake, but browsers only allow that on `localhost` or HTTPS. The page reloads itself every 6 hours to stay fresh, but only after checking the server is up, so a server restart never leaves a blank screen.

## Data and backups

Notices and accounts live in `data/gazette.json`. Uploaded PDFs live in `data/uploads/`, each with a small `.json` file holding the text read from it. To back up, copy the whole `data/` folder. To move the Gazette to another machine, copy the whole folder, including `data/`.

When a PDF notice is removed or its PDF is replaced, the old file is deleted. PDFs that were uploaded but never published are cleaned up after a day.

Passwords are stored as salted scrypt hashes. Sign-ins last 12 hours and end when the server restarts.

## Security notes

- This is built for a trusted internal network. It uses plain HTTP, so don't expose it directly to the internet. If you need access from outside the office, put it behind a VPN or an HTTPS reverse proxy.
- After 10 failed sign-in attempts from one address, sign-in is locked for 15 minutes.
- PDF text is read on the server with the bundled PDF.js. Nothing is sent to any outside service, and PDFs posted before this feature existed are read automatically when the server starts.
- **Scanned PDFs and images** contain no text of their own, so they go through OCR and HR's check (see above). The checked text is stored next to the file in `data/uploads/<id>.json`, along with who checked it and when.
- Uploads must be real PDFs; the server checks the file's contents, not just its name. Staff can only open PDFs that belong to live notices.
- To change the PDF size limit, start the server with `$env:MAX_PDF_MB=50` (the default is 25).
- All HR accounts have the same permissions: post, edit and remove any notice, and manage team accounts.

## Project layout

```
server.js           HTTP server, API, sign-in, storage, PDF uploads, live updates
public/             The board (index.html, app.js, styles.css) and TV display (tv.html, tv.js, tv.css)
public/pdfview.js   PDF rendering shared by the board and TV
public/richtext.js  Notice formatting shared by the board and TV
public/ocr.js       OCR in the browser (reads images and scanned PDFs)
public/vendor/pdfjs Mozilla PDF.js 6.5 (Apache-2.0), bundled so no install is needed
public/vendor/tesseract  Tesseract.js 7 + English data (Apache-2.0), bundled for offline OCR
lib/pdftext.js      Reads PDF text and works out the headline, summary, category and dates
data/               Created on first run; holds gazette.json and uploads/
```

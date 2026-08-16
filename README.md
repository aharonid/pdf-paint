# Micro Paint

**Live: https://pdf-paint.vercel.app**

A tiny paint program that runs in a browser tab. Start on a blank canvas with MS-Paint-style
tools — pencil, marker, shapes, fill bucket, text, selection.

It also opens images and PDFs, which is useful when you want to draw on top of something
rather than from scratch: a PDF is rasterized page by page into bitmaps you can paint on, and
can be saved back out as a PDF. That's a supported input, not the point of the program.

No build step and no npm install — `pdf.js` and `pdf-lib` are vendored in `vendor/`.

## Run it

Double-click **Start PDF Paint.command**, or from a terminal:

```bash
cd ~/Downloads/pdf-paint
node server.js       # or: npm start
```

It serves on `http://127.0.0.1:4321` and opens your browser. A local server is required —
pdf.js is an ES module with a web worker, and browsers block both over `file://`.
Set `PORT=5000` to change the port; the server steps to the next free port if it's taken.

## What it does

**New canvas** gives you a blank sheet at whatever size you pick. Paint, then **Save PNG**.

**Open** takes a PNG, JPG, WebP, or PDF and turns it into a canvas to draw on. Drag it onto
the window or use the button. Set **Import quality** first — it controls how finely the file
is rasterized: 150 dpi is fine for screen, 300 for print. Opening more files appends their
pages, so you can pull a scanned signature in next to a document.

**Save as PDF** writes every page back out at its original dimensions. Note that pages are
bitmaps by then, so the result is a flat picture PDF: text is no longer selectable or
searchable, and file size grows with dpi. That's the tradeoff for being able to paint
anywhere — good for signing, whiting out, and markup; wrong when the text layer has to
survive.

## Tools

| Tool | Key | Notes |
|---|---|---|
| Pencil | `B` | Freehand. |
| Marker | `M` | Multiplies into the page — highlights without hiding text underneath. |
| Eraser | `E` | Paints with the background color (white by default), not transparency. |
| Line | `L` | Hold `Shift` to snap horizontal / vertical / 45°. |
| Rectangle | `R` | Outline, filled, or both. Filled + white = whiteout block. |
| Ellipse | `O` | Hold `Shift` for a circle. |
| Fill bucket | `G` | Tolerance slider handles anti-aliased and scanned edges. |
| Text | `T` | Click, type, `Enter` to commit, `Shift+Enter` for a new line, `Esc` to cancel. |
| Eyedropper | `I` | Picks a color off the page — handy for matching a scan's off-white. |
| Select | `S` | Drag a box, then drag inside it to move those pixels. Hold `Alt` while dragging to copy instead of move. `Delete` clears the box. `Esc` drops it. |

**Right-drag paints with the background color** with any brush or shape, the same way Paint does.

## Other shortcuts

- `⌘Z` / `⇧⌘Z` — undo / redo (20 steps per page)
- `⌘S` — save as PDF
- `[` / `]` — brush size
- `X` — swap primary and background colors
- `+` / `-` / `0` — zoom in, out, fit page; `⌘`+scroll also zooms
- `←` / `→` — previous / next page, on multi-page documents
- Right-click a palette swatch to set the background color

**Clear canvas** blanks the current page to the background color. **Revert to original**
throws away your edits and restores the page as it was imported. Both are undoable.

## Hosting

The deployed site is static files on a CDN. There's no server-side code and no database, so
nothing in the stack is set up to receive a document — all the work happens in the page.
Two things in the config back that up:

- A `Content-Security-Policy` (see `vercel.json`) restricts `connect-src` to `'self'`, so the
  browser blocks the page from sending data to another origin. Same-origin fetches stay
  allowed because pdf.js loads its CJK cmaps and standard-font data on demand.
- `form-action 'none'` and `frame-ancestors 'none'` close the usual exfiltration and
  clickjacking paths.

`sw.js` caches the app's own code so it keeps working offline after the first visit. Only
app assets are cached; the files you open aren't fetched through the network layer at all.

To deploy your own copy: `vercel deploy --prod`. Note `.vercelignore` excludes `package.json`
and `server.js` — without that, Vercel's zero-config detection sees a Node entrypoint and
tries to run the app as a server instead of serving it as static files. `vercel.json` pins
`"framework": null` for the same reason.

## Notes

- Nothing is written to disk until you hit a Save button — the browser downloads the result
  to your Downloads folder.
- Undo history is in memory only. Closing the tab loses unsaved work (you'll get a warning).
- The page rail on the right only appears for multi-page documents.
- High import quality on a long PDF eats RAM: roughly 4 bytes per pixel per page, times each
  undo step. If a 40-page document at 300 dpi feels sluggish, reopen it at 150.

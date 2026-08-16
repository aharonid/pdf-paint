# PDF Paint

**Live: https://pdf-paint.vercel.app**

A tiny paint app for PDFs. It rasterizes every page of a PDF into a bitmap, hands you
MS-Paint-style tools, and packs the edited bitmaps back into a PDF.

Runs entirely in the browser. No build step, no npm install, no upload, no backend, no
account — `pdf.js` and `pdf-lib` are vendored in `vendor/`, and your document never leaves
the tab it's opened in.

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

1. **Open** a PDF (or PNG/JPG) — drag it onto the window or use the button.
2. Each page is rendered to a bitmap at the DPI you pick. **Set the DPI before opening the
   file**: 150 is fine for screen, 300 for print.
3. Paint on it.
4. **Save PDF** rebuilds a PDF at the original page dimensions, or **Save page PNG** exports
   just the current page.

Because pages become images, the output is a flat picture PDF: text is no longer selectable
or searchable, and file size grows with DPI. That's the tradeoff for being able to paint
anywhere — it's ideal for signing, whiting out, marking up, or fixing a scan, and wrong for
anything where the text layer has to survive.

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
- `⌘S` — save PDF
- `[` / `]` — brush size
- `X` — swap primary and background colors
- `+` / `-` / `0` — zoom in, out, fit page; `⌘`+scroll also zooms
- `←` / `→` — previous / next page
- Right-click a palette swatch to set the background color

**Whiteout page** blanks the current page to the background color. **Revert page** throws away
your edits and restores the original render of that page. Both are undoable.

## Hosting

The deployed site is static files on a CDN — there is no server-side code, no database, and
no request that carries your document anywhere. Two things enforce that rather than merely
claiming it:

- A `Content-Security-Policy` (see `vercel.json`) restricts `connect-src` to `'self'`, so the
  browser blocks any attempt by the page to send data to another origin. Same-origin fetches
  are still allowed because pdf.js loads its CJK cmaps and standard-font data on demand.
- There is no backend to POST to. `form-action 'none'` and `frame-ancestors 'none'` close
  off the usual exfiltration and clickjacking paths.

`sw.js` caches the app's own code so it keeps working offline after the first visit. Only
app assets go in that cache — user documents are never fetched, so they can't land in it.

To deploy your own copy: `vercel deploy --prod`. Note `.vercelignore` excludes `package.json`
and `server.js` — without that, Vercel's zero-config detection sees a Node entrypoint and
tries to run the app as a server instead of serving it as static files. `vercel.json` pins
`"framework": null` for the same reason.

## Notes

- Nothing is uploaded and nothing is written to disk until you hit a Save button — the browser
  downloads the result to your Downloads folder.
- Undo history is in memory only. Closing the tab loses unsaved work (you'll get a warning).
- Opening more files appends their pages to the end of the current document, so you can merge
  a PDF and a scanned signature image into one file.
- High DPI on a long PDF eats RAM: roughly 4 bytes per pixel per page, times each undo step.
  If a 40-page document at 300 DPI feels sluggish, reopen it at 150.

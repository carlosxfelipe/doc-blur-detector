/**
 * PDF rendering helper via PDF.js CDN.
 * Renders each PDF page onto an offscreen canvas so the same pixel-level
 * blur detection pipeline works on scanned PDFs, embedded images, and vector PDFs.
 */

const PDFJS_URL =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
const PDFJS_WORKER_URL =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

let pdfjsPromise = null;

async function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return mod;
    });
  }
  return pdfjsPromise;
}

/**
 * Loads a PDF File/Blob and renders up to `maxPages` pages to ImageData + Canvas.
 * @param {File|Blob} file
 * @param {{ maxPages?: number, targetMaxDim?: number, onProgress?: (cur:number, total:number)=>void }} opts
 */
export async function extractPdfPages(file, opts = {}) {
  const { maxPages = 10, targetMaxDim = 1400, onProgress } = opts;
  const pdfjsLib = await getPdfJs();
  const buffer = await file.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  const totalPages = pdf.numPages;
  const pagesToProcess = Math.min(totalPages, maxPages);
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pagesToProcess; pageNumber++) {
    if (onProgress) onProgress(pageNumber, pagesToProcess);

    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const longest = Math.max(baseViewport.width, baseViewport.height) || 1;
    const scale = Math.min(2.5, Math.max(1.0, targetMaxDim / longest));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Inspect vector text presence as diagnostic metadata
    let textItemCount = 0;
    try {
      const textContent = await page.getTextContent();
      textItemCount = textContent.items.filter(
        (it) => it.str && it.str.trim().length > 0,
      ).length;
    } catch {
      textItemCount = 0;
    }

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    pages.push({
      pageNumber,
      width: canvas.width,
      height: canvas.height,
      canvas,
      imageData,
      hasVectorText: textItemCount > 0,
      textItemCount,
    });
  }

  return {
    totalPages,
    processedPages: pagesToProcess,
    truncated: totalPages > pagesToProcess,
    pages,
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeDocumentBlur, ALGORITHMS } from "../js/blurDetector.js";

/**
 * Generates a synthetic crisp document RGBA buffer (white paper with dark text-like bars & grid).
 */
function makeSyntheticDocument(width = 480, height = 360) {
  const data = new Uint8ClampedArray(width * height * 4);
  // White paper background
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 248;
    data[i + 1] = 250;
    data[i + 2] = 252;
    data[i + 3] = 255;
  }

  const drawRect = (x0, y0, w, h, val = 20) => {
    for (let y = y0; y < Math.min(height, y0 + h); y++) {
      for (let x = x0; x < Math.min(width, x0 + w); x++) {
        const idx = (y * width + x) * 4;
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
      }
    }
  };

  // Document border
  drawRect(30, 30, width - 60, 3, 25);
  drawRect(30, height - 33, width - 60, 3, 25);
  drawRect(30, 30, 3, height - 60, 25);
  drawRect(width - 33, 30, 3, height - 60, 25);

  // Simulated crisp character glyphs / lines in middle region (leaving plenty of white margin)
  for (let row = 70; row < 270; row += 28) {
    for (let col = 60; col < 400; col += 14) {
      if ((col + row) % 5 !== 0) {
        drawRect(col, row, 8, 12, 18);
        drawRect(col + 2, row + 3, 4, 5, 245); // interior glyph hole
      }
    }
  }

  return { width, height, data };
}

function boxBlurRGBA(imageData, radius = 3, passes = 2) {
  const { width, height, data } = imageData;
  let src = new Uint8ClampedArray(data);
  let dst = new Uint8ClampedArray(data.length);

  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        for (
          let kx = Math.max(0, x - radius);
          kx <= Math.min(width - 1, x + radius);
          kx++
        ) {
          const idx = (y * width + kx) * 4;
          r += src[idx];
          g += src[idx + 1];
          b += src[idx + 2];
          c++;
        }
        const out = (y * width + x) * 4;
        dst[out] = r / c;
        dst[out + 1] = g / c;
        dst[out + 2] = b / c;
        dst[out + 3] = 255;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        for (
          let ky = Math.max(0, y - radius);
          ky <= Math.min(height - 1, y + radius);
          ky++
        ) {
          const idx = (ky * width + x) * 4;
          r += dst[idx];
          g += dst[idx + 1];
          b += dst[idx + 2];
          c++;
        }
        const out = (y * width + x) * 4;
        src[out] = r / c;
        src[out + 1] = g / c;
        src[out + 2] = b / c;
        src[out + 3] = 255;
      }
    }
  }

  return { width, height, data: src };
}

test("classifies crisp document as sharp and blurred document as blurry across algorithms", () => {
  const sharpDoc = makeSyntheticDocument();
  const blurryDoc = boxBlurRGBA(sharpDoc, 3, 2);

  for (const alg of ALGORITHMS) {
    const sharpResult = analyzeDocumentBlur(sharpDoc, { algorithm: alg.id });
    const blurryResult = analyzeDocumentBlur(blurryDoc, { algorithm: alg.id });

    assert.equal(
      sharpResult.status,
      "sharp",
      `Expected sharp document to be 'sharp' with ${alg.id}, got ${sharpResult.status} (score=${sharpResult.score})`,
    );
    assert.equal(
      blurryResult.status,
      "blurry",
      `Expected blurry document to be 'blurry' with ${alg.id}, got ${blurryResult.status} (score=${blurryResult.score})`,
    );
    assert.ok(
      sharpResult.score > blurryResult.score + 25,
      `Expected meaningful score gap for ${alg.id}: sharp=${sharpResult.score}, blurry=${blurryResult.score}`,
    );
  }
});

test("detects partial blur when half of the document is out of focus", () => {
  const sharpDoc = makeSyntheticDocument();
  const blurredDoc = boxBlurRGBA(sharpDoc, 4, 2);
  const partialData = new Uint8ClampedArray(sharpDoc.data);
  const splitX = Math.floor(sharpDoc.width * 0.45);

  for (let y = 0; y < sharpDoc.height; y++) {
    for (let x = splitX; x < sharpDoc.width; x++) {
      const idx = (y * sharpDoc.width + x) * 4;
      partialData[idx] = blurredDoc.data[idx];
      partialData[idx + 1] = blurredDoc.data[idx + 1];
      partialData[idx + 2] = blurredDoc.data[idx + 2];
    }
  }

  const partialResult = analyzeDocumentBlur(
    { width: sharpDoc.width, height: sharpDoc.height, data: partialData },
    { algorithm: "hybrid" },
  );

  assert.notEqual(partialResult.status, "sharp");
  assert.ok(partialResult.metrics.blurryTileRatio >= 0.4);
});

test("reports insufficient content for a blank white page", () => {
  const width = 320;
  const height = 240;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const result = analyzeDocumentBlur({ width, height, data });

  assert.equal(result.status, "insufficient");
  assert.equal(result.metrics.activeTileCount, 0);
});

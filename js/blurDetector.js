/**
 * Document Blur Detection Engine (Pure JS, zero DOM dependencies).
 *
 * Combines 3 complementary focus/sharpness metrics tailored to documents:
 * 1. Active-Tile Modified Laplacian Variance (ignores blank paper margins)
 * 2. Tenengrad Sobel Gradient Energy on active tiles
 * 3. Marziliano-style Edge Transition Width (contrast-invariant ramp width)
 *
 * Also supports baseline Global Laplacian Variance for comparison.
 */

export const ALGORITHMS = [
  {
    id: "active_laplacian",
    label: "Laplacian Variance (Tiles Ativos)",
    description:
      "Calcula a variância do Laplaciano apenas em blocos com texto/detalhes, evitando falsos positivos por fundo branco.",
  },
  {
    id: "global_laplacian",
    label: "Laplacian Variance (Global Clássico)",
    description:
      "Algoritmo clássico na imagem inteira. Útil para comparar como margens em branco diluem a variância global.",
  },
  {
    id: "tenengrad",
    label: "Tenengrad (Energia de Gradiente Sobel)",
    description:
      "Mede a energia quadrática dos gradientes Sobel nos blocos ativos com conteúdo.",
  },
  {
    id: "edge_width",
    label: "Largura de Borda (Estilo Marziliano)",
    description:
      "Mede quantos pixels uma borda leva para ir do mínimo ao máximo local. Muito resistente a baixo contraste.",
  },
];

export const DEFAULT_CONFIG = {
  algorithm: "global_laplacian",
  maxAnalysisDim: 1400,
  tileSize: 48,
  minTileContrast: 24,
  minTileStdDev: 5.5,
  // Thresholds for final classification (0-100 score)
  sharpScoreThreshold: 60,
  blurScoreThreshold: 40,
  // If more than this fraction of active tiles are blurry, penalize/flag document
  maxBlurryTileRatio: 0.45,
  // Reference targets used to normalize raw metrics to 0-100
  laplacianRef: 650,
  tenengradRef: 900,
  edgeWidthSharp: 2.3,
  edgeWidthBlurry: 5.2,
};

/**
 * Downsamples an RGBA ImageData if its longest dimension exceeds maxDim.
 * Uses box averaging for clean anti-aliased scaling without DOM Canvas.
 */
export function resizeImageDataIfNeeded(imageData, maxDim) {
  const { width, height, data } = imageData;
  const longest = Math.max(width, height);
  if (!maxDim || longest <= maxDim) {
    return { width, height, data, scale: 1 };
  }

  const scale = maxDim / longest;
  const newW = Math.max(16, Math.round(width * scale));
  const newH = Math.max(16, Math.round(height * scale));
  const out = new Uint8ClampedArray(newW * newH * 4);

  const xRatio = width / newW;
  const yRatio = height / newH;

  for (let ny = 0; ny < newH; ny++) {
    const sy0 = Math.floor(ny * yRatio);
    const sy1 = Math.min(
      height,
      Math.max(sy0 + 1, Math.floor((ny + 1) * yRatio)),
    );

    for (let nx = 0; nx < newW; nx++) {
      const sx0 = Math.floor(nx * xRatio);
      const sx1 = Math.min(
        width,
        Math.max(sx0 + 1, Math.floor((nx + 1) * xRatio)),
      );

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = sy0; sy < sy1; sy++) {
        const rowOffset = sy * width * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const idx = rowOffset + sx * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          a += data[idx + 3];
          count++;
        }
      }

      const outIdx = (ny * newW + nx) * 4;
      out[outIdx] = r / count;
      out[outIdx + 1] = g / count;
      out[outIdx + 2] = b / count;
      out[outIdx + 3] = a / count;
    }
  }

  return { width: newW, height: newH, data: out, scale };
}

/**
 * Converts RGBA pixels into a single-channel luminance Float32Array (0..255).
 * Transparent pixels are composited against white (255) like paper.
 */
export function toGrayscaleLuminance(data, width, height) {
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const alpha = data[p + 3] / 255;
    const r = data[p] * alpha + 255 * (1 - alpha);
    const g = data[p + 1] * alpha + 255 * (1 - alpha);
    const b = data[p + 2] * alpha + 255 * (1 - alpha);
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return lum;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

/**
 * Measures monotonic edge ramp width along horizontal or vertical scanline.
 */
function measureEdgeWidth(
  lum,
  width,
  height,
  x,
  y,
  horizontal,
  maxRadius = 10,
) {
  const step = horizontal ? 1 : width;
  const pos = y * width + x;
  const coord = horizontal ? x : y;
  const limit = horizontal ? width : height;

  const leftGrad = lum[pos + step] - lum[pos - step];
  if (leftGrad === 0) return null;

  const increasing = leftGrad > 0;
  const minStep = 1.5;
  let negDist = 0;
  let posDist = 0;

  // Walk backward against gradient direction (stop on plateaus)
  let prev = lum[pos];
  for (let d = 1; d <= maxRadius; d++) {
    if (coord - d < 0) break;
    const cur = lum[pos - d * step];
    if (increasing ? cur < prev - minStep : cur > prev + minStep) {
      negDist = d;
      prev = cur;
    } else {
      break;
    }
  }

  // Walk forward along gradient direction (stop on plateaus)
  prev = lum[pos];
  for (let d = 1; d <= maxRadius; d++) {
    if (coord + d >= limit) break;
    const cur = lum[pos + d * step];
    if (increasing ? cur > prev + minStep : cur < prev - minStep) {
      posDist = d;
      prev = cur;
    } else {
      break;
    }
  }

  const totalWidth = negDist + posDist;
  return totalWidth >= 1 ? totalWidth : null;
}

function normalizeHigherBetter(value, ref) {
  // Smooth log-like saturation curve mapping ref -> ~70/100
  if (value <= 0) return 0;
  const ratio = value / ref;
  return clamp01(1 - Math.exp(-1.2 * ratio)) * 100;
}

function normalizeEdgeWidthScore(edgeWidth, sharpW, blurryW) {
  if (!edgeWidth || edgeWidth <= 0) return 0;
  if (edgeWidth <= sharpW) return 100;
  if (edgeWidth >= blurryW) return 0;
  return ((blurryW - edgeWidth) / (blurryW - sharpW)) * 100;
}

/**
 * Analyzes an ImageData object and returns detailed blur metrics, per-tile diagnostics,
 * and final classification ('sharp' | 'borderline' | 'blurry' | 'insufficient').
 */
export function analyzeDocumentBlur(imageData, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  const t0 =
    typeof performance !== "undefined" ? performance.now() : Date.now();

  const prepared = resizeImageDataIfNeeded(imageData, cfg.maxAnalysisDim);
  const { width, height, data, scale } = prepared;
  const lum = toGrayscaleLuminance(data, width, height);

  const totalPixels = width * height;
  const lapValues = new Float32Array(totalPixels);
  const gradMag = new Float32Array(totalPixels);
  const gradX = new Float32Array(totalPixels);
  const gradY = new Float32Array(totalPixels);

  let globalLapSum = 0;
  let globalLapSqSum = 0;
  let innerCount = 0;
  let maxGrad = 0;

  // 1. Compute pixel-wise Laplacian & Sobel gradients
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    const rowUp = (y - 1) * width;
    const rowDn = (y + 1) * width;

    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const c = lum[i];

      // 4-neighbor Laplacian
      const lap =
        4 * c - lum[i - 1] - lum[i + 1] - lum[rowUp + x] - lum[rowDn + x];
      lapValues[i] = lap;
      globalLapSum += lap;
      globalLapSqSum += lap * lap;
      innerCount++;

      // Normalized Sobel (divided by 4 so range aligns with 0..255 contrast)
      const tl = lum[rowUp + x - 1];
      const t = lum[rowUp + x];
      const tr = lum[rowUp + x + 1];
      const l = lum[i - 1];
      const r = lum[i + 1];
      const bl = lum[rowDn + x - 1];
      const b = lum[rowDn + x];
      const br = lum[rowDn + x + 1];

      const gx = (-tl + tr - 2 * l + 2 * r - bl + br) * 0.25;
      const gy = (-tl - 2 * t - tr + bl + 2 * b + br) * 0.25;
      const mag = Math.hypot(gx, gy);

      gradX[i] = gx;
      gradY[i] = gy;
      gradMag[i] = mag;
      if (mag > maxGrad) maxGrad = mag;
    }
  }

  const globalLapMean = innerCount > 0 ? globalLapSum / innerCount : 0;
  const globalLapVariance =
    innerCount > 0
      ? Math.max(0, globalLapSqSum / innerCount - globalLapMean * globalLapMean)
      : 0;

  // Adaptive edge threshold for edge-width measurement
  const edgeThreshold = Math.max(12, Math.min(40, maxGrad * 0.16));

  // 2. Tile-based inspection (ignores blank paper margins)
  const tileSize = Math.max(
    24,
    Math.min(cfg.tileSize, Math.floor(Math.min(width, height) / 3) || 24),
  );
  const cols = Math.max(1, Math.floor(width / tileSize));
  const rows = Math.max(1, Math.floor(height / tileSize));

  const tiles = [];
  const activeTileLapVars = [];
  const activeTileTenengrads = [];
  const activeTileEdgeWidths = [];
  const activeTileScores = [];

  for (let ty = 0; ty < rows; ty++) {
    const y0 = Math.max(1, ty * tileSize);
    const y1 =
      ty === rows - 1 ? height - 1 : Math.min(height - 1, (ty + 1) * tileSize);

    for (let tx = 0; tx < cols; tx++) {
      const x0 = Math.max(1, tx * tileSize);
      const x1 =
        tx === cols - 1 ? width - 1 : Math.min(width - 1, (tx + 1) * tileSize);

      let n = 0;
      let lumSum = 0;
      let lumSqSum = 0;
      let minLum = 255;
      let maxLum = 0;
      let lapSum = 0;
      let lapSqSum = 0;
      let gradSqSum = 0;
      let edgeWidthSum = 0;
      let edgeWidthCount = 0;

      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          const i = row + x;
          const v = lum[i];
          lumSum += v;
          lumSqSum += v * v;
          if (v < minLum) minLum = v;
          if (v > maxLum) maxLum = v;

          const lap = lapValues[i];
          lapSum += lap;
          lapSqSum += lap * lap;

          const gm = gradMag[i];
          gradSqSum += gm * gm;

          // Sample edge width at strong edge peaks (every 2px stride for speed)
          if (((x + y) & 1) === 0 && gm >= edgeThreshold) {
            const absGx = Math.abs(gradX[i]);
            const absGy = Math.abs(gradY[i]);
            if (absGx >= absGy) {
              // Check local gradient maximum horizontally
              if (gm >= gradMag[i - 1] && gm >= gradMag[i + 1]) {
                const ew = measureEdgeWidth(lum, width, height, x, y, true);
                if (ew !== null) {
                  edgeWidthSum += ew;
                  edgeWidthCount++;
                }
              }
            } else {
              // Check local gradient maximum vertically
              if (gm >= gradMag[i - width] && gm >= gradMag[i + width]) {
                const ew = measureEdgeWidth(lum, width, height, x, y, false);
                if (ew !== null) {
                  edgeWidthSum += ew;
                  edgeWidthCount++;
                }
              }
            }
          }

          n++;
        }
      }

      if (n === 0) continue;

      const lumMean = lumSum / n;
      const lumVar = Math.max(0, lumSqSum / n - lumMean * lumMean);
      const lumStd = Math.sqrt(lumVar);
      const contrast = maxLum - minLum;

      const lapMean = lapSum / n;
      const lapVar = Math.max(0, lapSqSum / n - lapMean * lapMean);
      const tenengrad = gradSqSum / n;
      const avgEdgeWidth =
        edgeWidthCount > 0 ? edgeWidthSum / edgeWidthCount : null;

      const isActive =
        contrast >= cfg.minTileContrast && lumStd >= cfg.minTileStdDev;

      // Compute tile-level score according to selected algorithm
      const sLap = normalizeHigherBetter(lapVar, cfg.laplacianRef);
      const sTen = normalizeHigherBetter(tenengrad, cfg.tenengradRef);
      const sEdge =
        avgEdgeWidth !== null
          ? normalizeEdgeWidthScore(
              avgEdgeWidth,
              cfg.edgeWidthSharp,
              cfg.edgeWidthBlurry,
            )
          : sTen;

      let tileScore;
      switch (cfg.algorithm) {
        case "active_laplacian":
        case "global_laplacian":
          tileScore = sLap;
          break;
        case "tenengrad":
          tileScore = sTen;
          break;
        case "edge_width":
          tileScore = sEdge;
          break;
        case "hybrid":
        default:
          tileScore =
            avgEdgeWidth !== null
              ? 0.38 * sLap + 0.32 * sTen + 0.3 * sEdge
              : 0.55 * sLap + 0.45 * sTen;
          break;
      }

      let tileStatus = "blank";
      if (isActive) {
        if (tileScore >= cfg.sharpScoreThreshold) tileStatus = "sharp";
        else if (tileScore >= cfg.blurScoreThreshold) tileStatus = "borderline";
        else tileStatus = "blurry";

        activeTileLapVars.push(lapVar);
        activeTileTenengrads.push(tenengrad);
        if (avgEdgeWidth !== null) activeTileEdgeWidths.push(avgEdgeWidth);
        activeTileScores.push(tileScore);
      }

      tiles.push({
        tx,
        ty,
        x: x0 / scale,
        y: y0 / scale,
        w: (x1 - x0) / scale,
        h: (y1 - y0) / scale,
        isActive,
        status: tileStatus,
        score: tileScore,
        lapVar,
        tenengrad,
        edgeWidth: avgEdgeWidth,
        contrast,
      });
    }
  }

  const activeCount = activeTileScores.length;
  const elapsedMs =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;

  if (activeCount === 0) {
    return {
      status: "insufficient",
      label: "Conteúdo Insuficiente",
      reason:
        "Página em branco ou sem contraste suficiente para avaliar nitidez.",
      score: 0,
      metrics: {
        globalLaplacianVar: globalLapVariance,
        activeLaplacianVar: 0,
        activeTenengrad: 0,
        avgEdgeWidth: null,
        activeTileCount: 0,
        totalTileCount: tiles.length,
        blurryTileRatio: 0,
        analyzedWidth: width,
        analyzedHeight: height,
        elapsedMs,
      },
      tiles,
    };
  }

  // Aggregate active tile statistics (using median & upper-middle quantiles to resist outlier speckles)
  const sortedLap = [...activeTileLapVars].sort((a, b) => a - b);
  const sortedTen = [...activeTileTenengrads].sort((a, b) => a - b);
  const sortedEdge = [...activeTileEdgeWidths].sort((a, b) => a - b);
  const sortedScores = [...activeTileScores].sort((a, b) => a - b);

  const activeLapP60 = percentile(sortedLap, 0.6);
  const activeTenP60 = percentile(sortedTen, 0.6);
  const medianEdgeWidth =
    sortedEdge.length > 0 ? percentile(sortedEdge, 0.5) : null;
  const medianTileScore = percentile(sortedScores, 0.5);
  const p25TileScore = percentile(sortedScores, 0.25);

  const blurryTiles = activeTileScores.filter(
    (s) => s < cfg.blurScoreThreshold,
  ).length;
  const blurryTileRatio = blurryTiles / activeCount;

  // Compute final score based on chosen algorithm
  let finalScore;
  if (cfg.algorithm === "global_laplacian") {
    finalScore = normalizeHigherBetter(
      globalLapVariance,
      cfg.laplacianRef * 0.45,
    );
  } else if (cfg.algorithm === "active_laplacian") {
    finalScore = normalizeHigherBetter(activeLapP60, cfg.laplacianRef);
  } else if (cfg.algorithm === "tenengrad") {
    finalScore = normalizeHigherBetter(activeTenP60, cfg.tenengradRef);
  } else if (cfg.algorithm === "edge_width") {
    finalScore =
      medianEdgeWidth !== null
        ? normalizeEdgeWidthScore(
            medianEdgeWidth,
            cfg.edgeWidthSharp,
            cfg.edgeWidthBlurry,
          )
        : medianTileScore;
  } else {
    // Hybrid: combine median & lower-quartile tile score so partial blur is caught
    const baseScore = 0.65 * medianTileScore + 0.35 * p25TileScore;
    // Penalize if a large fraction of text tiles are blurry
    const ratioPenalty =
      blurryTileRatio > cfg.maxBlurryTileRatio
        ? (blurryTileRatio - cfg.maxBlurryTileRatio) * 45
        : 0;
    finalScore = Math.max(0, Math.min(100, baseScore - ratioPenalty));
  }

  let status;
  let label;
  let reason;

  if (
    finalScore < cfg.blurScoreThreshold ||
    (cfg.algorithm === "hybrid" &&
      blurryTileRatio > Math.min(0.85, cfg.maxBlurryTileRatio + 0.15))
  ) {
    status = "blurry";
    label = "Documento Borrado";
    reason =
      blurryTileRatio > cfg.maxBlurryTileRatio
        ? `${Math.round(blurryTileRatio * 100)}% das regiões com conteúdo estão fora de foco ou borradas.`
        : "Baixa energia de bordas e transições largas nas regiões com texto/detalhes.";
  } else if (
    finalScore < cfg.sharpScoreThreshold ||
    (cfg.algorithm === "hybrid" && blurryTileRatio > cfg.maxBlurryTileRatio)
  ) {
    status = "borderline";
    label = "Atenção (Levemente Borrado)";
    reason =
      "Nitidez limítrofe ou borrão parcial em algumas áreas do documento.";
  } else {
    status = "sharp";
    label = "Documento Nítido";
    reason = "Bordas definidas e bom foco nas regiões com conteúdo.";
  }

  return {
    status,
    label,
    reason,
    score: Math.round(finalScore),
    metrics: {
      globalLaplacianVar: Math.round(globalLapVariance * 10) / 10,
      activeLaplacianVar: Math.round(activeLapP60 * 10) / 10,
      activeTenengrad: Math.round(activeTenP60 * 10) / 10,
      avgEdgeWidth:
        medianEdgeWidth !== null
          ? Math.round(medianEdgeWidth * 100) / 100
          : null,
      activeTileCount: activeCount,
      totalTileCount: tiles.length,
      blurryTileRatio: Math.round(blurryTileRatio * 1000) / 1000,
      analyzedWidth: width,
      analyzedHeight: height,
      elapsedMs: Math.round(elapsedMs * 10) / 10,
    },
    tiles,
  };
}

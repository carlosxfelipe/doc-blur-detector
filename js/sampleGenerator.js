/**
 * Generates synthetic document canvases (sharp, Gaussian-blurred, motion-blurred,
 * and partially blurred) so the algorithm can be tested immediately without external files.
 */

function applySeparableBoxBlur(imageData, radius, passes = 2) {
  const { width, height, data } = imageData;
  let src = new Uint8ClampedArray(data);
  let dst = new Uint8ClampedArray(data.length);

  for (let pass = 0; pass < passes; pass++) {
    // Horizontal pass
    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width - 1, x + radius);
        for (let kx = x0; kx <= x1; kx++) {
          const idx = row + kx * 4;
          r += src[idx];
          g += src[idx + 1];
          b += src[idx + 2];
          count++;
        }
        const out = row + x * 4;
        dst[out] = r / count;
        dst[out + 1] = g / count;
        dst[out + 2] = b / count;
        dst[out + 3] = 255;
      }
    }

    // Vertical pass
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let ky = y0; ky <= y1; ky++) {
          const idx = (ky * width + x) * 4;
          r += dst[idx];
          g += dst[idx + 1];
          b += dst[idx + 2];
          count++;
        }
        const out = (y * width + x) * 4;
        src[out] = r / count;
        src[out + 1] = g / count;
        src[out + 2] = b / count;
        src[out + 3] = 255;
      }
    }
  }

  return new ImageData(src, width, height);
}

function applyMotionBlur(imageData, length = 11) {
  const { width, height, data } = imageData;
  const out = new Uint8ClampedArray(data.length);
  const half = Math.floor(length / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let d = -half; d <= half; d++) {
        const sx = Math.min(width - 1, Math.max(0, x + d));
        const sy = Math.min(height - 1, Math.max(0, y + Math.round(d * 0.25)));
        const idx = (sy * width + sx) * 4;
        r += data[idx];
        g += data[idx + 1];
        b += data[idx + 2];
        count++;
      }
      const outIdx = (y * width + x) * 4;
      out[outIdx] = r / count;
      out[outIdx + 1] = g / count;
      out[outIdx + 2] = b / count;
      out[outIdx + 3] = 255;
    }
  }

  return new ImageData(out, width, height);
}

function drawBaseDocument(width = 960, height = 680) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Paper background with large margins (tests resilience against white space)
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);

  // Document card border
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 2;
  ctx.strokeRect(56, 48, width - 112, height - 96);

  // Header bar
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(56, 48, width - 112, 58);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 22px sans-serif";
  ctx.fillText("COMPROVANTE FISCAL / DOCUMENTO DE TESTE", 82, 85);

  // Two-column fields
  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("Titular: Maria Clara Ferreira", 82, 146);
  ctx.fillText("Protocolo: BR-2026-884120", 520, 146);

  ctx.font = "15px monospace";
  ctx.fillStyle = "#1e293b";
  const lines = [
    "CPF/CNPJ: 123.456.789-00        Emissão: 23/11/2026",
    "Endereço: Av. Paulista, 1420    CEP: 01310-100",
    "Valor Total: R$ 1.849,90        Situação: Válido",
    "Hash: 9f8a7c6b5d4e3f2a1b0c9d8e7f6a5b4c",
  ];

  lines.forEach((line, idx) => {
    ctx.fillText(line, 82, 190 + idx * 34);
  });

  // Table block
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(82, 336, width - 164, 170);
  ctx.beginPath();
  ctx.moveTo(82, 376);
  ctx.lineTo(width - 82, 376);
  ctx.moveTo(82, 420);
  ctx.lineTo(width - 82, 420);
  ctx.moveTo(82, 464);
  ctx.lineTo(width - 82, 464);
  ctx.stroke();

  ctx.font = "bold 14px sans-serif";
  ctx.fillText("ITEM / DESCRIÇÃO", 98, 362);
  ctx.fillText("QTD", 620, 362);
  ctx.fillText("VALOR", 740, 362);

  ctx.font = "14px sans-serif";
  ctx.fillText("01. Verificação de Autenticidade Documental", 98, 404);
  ctx.fillText("1", 626, 404);
  ctx.fillText("R$ 849,90", 740, 404);

  ctx.fillText("02. Processamento Digital de Imagem e OCR", 98, 448);
  ctx.fillText("2", 626, 448);
  ctx.fillText("R$ 1.000,00", 740, 448);

  // Barcode-like pattern at bottom
  ctx.fillStyle = "#0f172a";
  for (let x = 84; x < 340; x += 6) {
    const barW = (x * 7) % 3 === 0 ? 3 : 1.5;
    ctx.fillRect(x, 534, barW, 56);
  }

  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#334155";
  ctx.fillText("Assinatura Digital Conferida Eletronicamente", 480, 566);

  return canvas;
}

export function createSampleDocument(variant) {
  const canvas = drawBaseDocument();
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const baseData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (variant === "sharp") {
    return {
      name: "amostra-documento-nitido.png",
      canvas,
      imageData: baseData,
    };
  }

  if (variant === "gaussian_blur") {
    const blurred = applySeparableBoxBlur(baseData, 3, 2);
    ctx.putImageData(blurred, 0, 0);
    return {
      name: "amostra-foco-borrado.png",
      canvas,
      imageData: blurred,
    };
  }

  if (variant === "motion_blur") {
    const blurred = applyMotionBlur(baseData, 13);
    ctx.putImageData(blurred, 0, 0);
    return {
      name: "amostra-movimento-borrado.png",
      canvas,
      imageData: blurred,
    };
  }

  // Partial blur: sharp on left half, out-of-focus on right half
  const blurred = applySeparableBoxBlur(baseData, 4, 2);
  const mixed = new ImageData(
    new Uint8ClampedArray(baseData.data),
    baseData.width,
    baseData.height,
  );
  const splitX = Math.floor(baseData.width * 0.48);

  for (let y = 0; y < baseData.height; y++) {
    for (let x = splitX; x < baseData.width; x++) {
      const idx = (y * baseData.width + x) * 4;
      mixed.data[idx] = blurred.data[idx];
      mixed.data[idx + 1] = blurred.data[idx + 1];
      mixed.data[idx + 2] = blurred.data[idx + 2];
      mixed.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(mixed, 0, 0);
  return {
    name: "amostra-borrao-parcial.png",
    canvas,
    imageData: mixed,
  };
}

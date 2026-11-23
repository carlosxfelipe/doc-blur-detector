import { h, render } from "preact";
import { useState, useEffect, useRef, useMemo } from "preact/hooks";
import htm from "htm";

import {
  ALGORITHMS,
  DEFAULT_CONFIG,
  analyzeDocumentBlur,
} from "./blurDetector.js";
import { extractPdfPages } from "./pdfProcessor.js";
import { createSampleDocument } from "./sampleGenerator.js";

const html = htm.bind(h);

const STATUS_BADGE_MAP = {
  sharp: "Nítido",
  borderline: "Atenção",
  blurry: "Borrado",
  insufficient: "Sem conteúdo",
};

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve({
          pageNumber: 1,
          width: canvas.width,
          height: canvas.height,
          canvas,
          imageData,
          hasVectorText: false,
          textItemCount: 0,
        });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error(`Não foi possível decodificar a imagem "${file.name}".`),
      );
    };
    img.src = url;
  });
}

function aggregateDocumentStatus(pageResults) {
  if (!pageResults || pageResults.length === 0) {
    return {
      status: "insufficient",
      label: "Sem páginas",
      score: 0,
      blurryPages: [],
    };
  }

  const blurryPages = [];
  const borderlinePages = [];
  let minScore = Infinity;

  pageResults.forEach((res, idx) => {
    const pageNum = idx + 1;
    if (res.status !== "insufficient" && res.score < minScore) {
      minScore = res.score;
    }
    if (res.status === "blurry") blurryPages.push(pageNum);
    else if (res.status === "borderline") borderlinePages.push(pageNum);
  });

  if (minScore === Infinity) minScore = 0;

  if (blurryPages.length > 0) {
    return {
      status: "blurry",
      label:
        pageResults.length > 1
          ? `Borrado (Pág. ${blurryPages.join(", ")})`
          : "Documento Borrado",
      score: minScore,
      blurryPages,
    };
  }

  if (borderlinePages.length > 0) {
    return {
      status: "borderline",
      label:
        pageResults.length > 1
          ? `Atenção (Pág. ${borderlinePages.join(", ")})`
          : "Levemente Borrado",
      score: minScore,
      blurryPages: [],
    };
  }

  const allInsufficient = pageResults.every((r) => r.status === "insufficient");
  if (allInsufficient) {
    return {
      status: "insufficient",
      label: "Conteúdo Insuficiente",
      score: 0,
      blurryPages: [],
    };
  }

  return {
    status: "sharp",
    label: "Documento Nítido",
    score: minScore,
    blurryPages: [],
  };
}

function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedDocId, setSelectedDocId] = useState(null);
  const [selectedPageIdx, setSelectedPageIdx] = useState(0);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const fileInputRef = useRef(null);
  const previewCanvasRef = useRef(null);

  const activeAlgorithm = useMemo(
    () => ALGORITHMS.find((a) => a.id === config.algorithm) || ALGORITHMS[0],
    [config.algorithm],
  );

  // Re-evaluate all loaded documents dynamically whenever algorithm or thresholds change
  const analyzedDocs = useMemo(() => {
    return documents.map((doc) => {
      const pageAnalyses = doc.pages.map((page) =>
        analyzeDocumentBlur(page.imageData, config),
      );
      const summary = aggregateDocumentStatus(pageAnalyses);
      return {
        ...doc,
        pageAnalyses,
        summary,
      };
    });
  }, [documents, config]);

  const activeDoc = useMemo(
    () =>
      analyzedDocs.find((d) => d.id === selectedDocId) ||
      analyzedDocs[0] ||
      null,
    [analyzedDocs, selectedDocId],
  );

  const safePageIdx = activeDoc
    ? Math.min(selectedPageIdx, Math.max(0, activeDoc.pages.length - 1))
    : 0;
  const activePage = activeDoc ? activeDoc.pages[safePageIdx] : null;
  const activeAnalysis = activeDoc ? activeDoc.pageAnalyses[safePageIdx] : null;

  // Render preview canvas + optional tile sharpness overlay
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !activePage || !activeAnalysis) return;

    canvas.width = activePage.width;
    canvas.height = activePage.height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(activePage.canvas, 0, 0);

    if (showHeatmap && activeAnalysis.tiles) {
      for (const tile of activeAnalysis.tiles) {
        if (!tile.isActive) continue;

        if (tile.status === "sharp") {
          ctx.fillStyle = "rgba(34, 197, 94, 0.16)";
          ctx.strokeStyle = "rgba(34, 197, 94, 0.45)";
        } else if (tile.status === "borderline") {
          ctx.fillStyle = "rgba(245, 158, 11, 0.24)";
          ctx.strokeStyle = "rgba(245, 158, 11, 0.7)";
        } else {
          ctx.fillStyle = "rgba(239, 68, 68, 0.28)";
          ctx.strokeStyle = "rgba(239, 68, 68, 0.8)";
        }

        ctx.lineWidth = 1;
        ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
        ctx.strokeRect(tile.x + 0.5, tile.y + 0.5, tile.w - 1, tile.h - 1);
      }
    }
  }, [activePage, activeAnalysis, showHeatmap]);

  async function processFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    setErrorMsg("");
    const addedDocs = [];

    try {
      for (const file of files) {
        const isPdf =
          file.type === "application/pdf" ||
          file.name.toLowerCase().endsWith(".pdf");
        const isImage =
          file.type.startsWith("image/") ||
          /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name);

        if (!isPdf && !isImage) {
          throw new Error(
            `Formato não suportado: "${file.name}". Use imagens ou PDF.`,
          );
        }

        if (isPdf) {
          setLoadingMsg(`Renderizando páginas de "${file.name}"...`);
          const pdfResult = await extractPdfPages(file, {
            maxPages: 10,
            targetMaxDim: config.maxAnalysisDim,
            onProgress: (cur, total) => {
              setLoadingMsg(
                `Renderizando "${file.name}" — página ${cur} de ${total}...`,
              );
            },
          });

          addedDocs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            type: "pdf",
            size: file.size,
            totalPages: pdfResult.totalPages,
            truncated: pdfResult.truncated,
            pages: pdfResult.pages,
          });
        } else {
          setLoadingMsg(`Carregando imagem "${file.name}"...`);
          const page = await loadImageFile(file);
          addedDocs.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            type: "image",
            size: file.size,
            totalPages: 1,
            truncated: false,
            pages: [page],
          });
        }
      }

      if (addedDocs.length > 0) {
        setDocuments((prev) => [...addedDocs, ...prev]);
        setSelectedDocId(addedDocs[0].id);
        setSelectedPageIdx(0);
      }
    } catch (err) {
      setErrorMsg(err?.message || "Erro ao processar o arquivo.");
    } finally {
      setLoadingMsg("");
    }
  }

  function handleAddSample(variant) {
    setErrorMsg("");
    const sample = createSampleDocument(variant);
    const doc = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: sample.name,
      type: "sample",
      size: null,
      totalPages: 1,
      truncated: false,
      pages: [
        {
          pageNumber: 1,
          width: sample.canvas.width,
          height: sample.canvas.height,
          canvas: sample.canvas,
          imageData: sample.imageData,
          hasVectorText: false,
          textItemCount: 0,
        },
      ],
    };
    setDocuments((prev) => [doc, ...prev]);
    setSelectedDocId(doc.id);
    setSelectedPageIdx(0);
  }

  function updateConfig(key, value) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function resetCalibration() {
    setConfig(DEFAULT_CONFIG);
  }

  function clearQueue() {
    setDocuments([]);
    setSelectedDocId(null);
    setSelectedPageIdx(0);
    setErrorMsg("");
  }

  return html`
    <div class="app-shell">
      <header class="app-header">
        <div>
          <h1>Detector de Documentos Borrados</h1>
          <p class="subtitle">
            POC client-side (Preact CDN + ES Modules + PDF.js) para validar
            nitidez de imagens e PDFs antes do envio.
          </p>
        </div>
        <div class="header-actions">
          <div class="header-badge">
            <span>100% no navegador</span>
            <span>•</span>
            <span>Sem upload / envio</span>
          </div>
          <a
            class="btn repo-btn"
            href="https://github.com/carlosxfelipe/doc-blur-detector"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Abrir repositório no GitHub"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
            <span>Repositório</span>
          </a>
        </div>
      </header>

      <div class="layout-grid">
        <!-- Sidebar: Upload, Samples, Algorithm Calibration & Queue -->
        <aside class="panel">
          <h2 class="panel-title">1. Entrada de Documentos</h2>

          <div
            class=${`dropzone ${isDragging ? "dragging" : ""}`}
            onClick=${() => fileInputRef.current?.click()}
            onDragOver=${(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave=${() => setIsDragging(false)}
            onDrop=${(e) => {
              e.preventDefault();
              setIsDragging(false);
              processFiles(e.dataTransfer?.files);
            }}
          >
            <div class="dropzone-title">Arraste imagens ou PDFs aqui</div>
            <div class="dropzone-hint">
              ou clique para selecionar (PNG, JPG, WEBP, PDF)
            </div>
            <input
              ref=${fileInputRef}
              class="hidden-input"
              type="file"
              multiple
              accept="image/*,.pdf,application/pdf"
              onChange=${(e) => {
                processFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <div class="samples-block">
            <span class="section-label"
              >Gerar amostras sintéticas para teste</span
            >
            <div class="btn-grid">
              <button class="btn" onClick=${() => handleAddSample("sharp")}>
                Documento Nítido
              </button>
              <button
                class="btn"
                onClick=${() => handleAddSample("gaussian_blur")}
              >
                Foco Borrado
              </button>
              <button
                class="btn"
                onClick=${() => handleAddSample("motion_blur")}
              >
                Blur Movimento
              </button>
              <button
                class="btn"
                onClick=${() => handleAddSample("partial_blur")}
              >
                Borrão Parcial
              </button>
            </div>
          </div>

          <div class="controls-stack">
            <div class="panel-title" style="margin-bottom: 0;">
              <span>2. Algoritmo e Calibração</span>
              <button class="btn btn-ghost" onClick=${resetCalibration}>
                Restaurar
              </button>
            </div>

            <div class="field">
              <label for="algo-select">Algoritmo de Detecção</label>
              <select
                id="algo-select"
                value=${config.algorithm}
                onChange=${(e) => updateConfig("algorithm", e.target.value)}
              >
                ${ALGORITHMS.map(
                  (alg) => html`<option value=${alg.id}>${alg.label}</option>`,
                )}
              </select>
            </div>

            <div class="field">
              <label>
                <span>Limiar Nítido (Score mínimo)</span>
                <strong>${config.sharpScoreThreshold}</strong>
              </label>
              <input
                type="range"
                min="35"
                max="85"
                step="1"
                value=${config.sharpScoreThreshold}
                onInput=${(e) => {
                  const val = Number(e.target.value);
                  setConfig((prev) => ({
                    ...prev,
                    sharpScoreThreshold: val,
                    blurScoreThreshold: Math.min(
                      prev.blurScoreThreshold,
                      val - 5,
                    ),
                  }));
                }}
              />
            </div>

            <div class="field">
              <label>
                <span>Limiar Borrado (Score abaixo de)</span>
                <strong>${config.blurScoreThreshold}</strong>
              </label>
              <input
                type="range"
                min="15"
                max="70"
                step="1"
                value=${config.blurScoreThreshold}
                onInput=${(e) => {
                  const val = Number(e.target.value);
                  setConfig((prev) => ({
                    ...prev,
                    blurScoreThreshold: val,
                    sharpScoreThreshold: Math.max(
                      prev.sharpScoreThreshold,
                      val + 5,
                    ),
                  }));
                }}
              />
            </div>

            <div class="field">
              <label>
                <span>Tolerância a Blur Parcial (Tiles)</span>
                <strong>${Math.round(config.maxBlurryTileRatio * 100)}%</strong>
              </label>
              <input
                type="range"
                min="0.15"
                max="0.85"
                step="0.05"
                value=${config.maxBlurryTileRatio}
                onInput=${(e) => updateConfig("maxBlurryTileRatio", Number(e.target.value))}
              />
            </div>

            <div class="field">
              <label>
                <span>Tamanho do Tile (px)</span>
                <strong>${config.tileSize}px</strong>
              </label>
              <input
                type="range"
                min="24"
                max="96"
                step="8"
                value=${config.tileSize}
                onInput=${(e) => updateConfig("tileSize", Number(e.target.value))}
              />
            </div>

            <label class="checkbox-row">
              <input
                type="checkbox"
                checked=${showHeatmap}
                onChange=${(e) => setShowHeatmap(e.target.checked)}
              />
              <span>Exibir mapa de nitidez por regiões (tiles)</span>
            </label>
          </div>

          ${
            analyzedDocs.length > 0 &&
            html`
              <div
                style="margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border);"
              >
                <div class="panel-title" style="margin-bottom: 6px;">
                  <span>Documentos (${analyzedDocs.length})</span>
                  <button class="btn btn-ghost" onClick=${clearQueue}>
                    Limpar
                  </button>
                </div>
                <div class="queue-list">
                  ${analyzedDocs.map(
                    (doc) => html`
                      <div
                        key=${doc.id}
                        class=${`queue-item ${activeDoc?.id === doc.id ? "active" : ""}`}
                        onClick=${() => {
                          setSelectedDocId(doc.id);
                          setSelectedPageIdx(0);
                        }}
                      >
                        <div class="queue-meta">
                          <div class="queue-name" title=${doc.name}>
                            ${doc.name}
                          </div>
                          <div class="queue-sub">
                            ${
                              doc.type === "pdf"
                                ? `PDF • ${doc.pages.length}${doc.truncated ? `/${doc.totalPages}` : ""} pág(s)`
                                : `${doc.pages[0].width}×${doc.pages[0].height}px`
                            }
                            ${doc.size ? ` • ${formatBytes(doc.size)}` : ""}
                          </div>
                        </div>
                        <span class=${`status-pill ${doc.summary.status}`}>
                          ${STATUS_BADGE_MAP[doc.summary.status]}
                          (${doc.summary.score})
                        </span>
                      </div>
                    `,
                  )}
                </div>
              </div>
            `
          }
        </aside>

        <!-- Main Workspace: Inspection & Metrics -->
        <main class="panel">
          ${loadingMsg && html`<div class="loading-box">${loadingMsg}</div>`}
          ${errorMsg && html`<div class="error-box">${errorMsg}</div>`}
          ${
            !activeDoc || !activeAnalysis
              ? html`
                  <div class="empty-state">
                    <h2>Nenhum documento carregado</h2>
                    <p>
                      Envie uma foto de documento, um arquivo PDF ou clique em
                      um dos botões de
                      <strong>amostra sintética</strong> ao lado para testar o
                      algoritmo.
                    </p>
                  </div>
                `
              : html`
                  ${
                    activeDoc.pages.length > 1 &&
                    html`
                      <div class="pages-bar">
                        ${activeDoc.pageAnalyses.map(
                          (res, idx) => html`
                            <button
                              key=${idx}
                              class=${`page-chip ${idx === safePageIdx ? "active" : ""}`}
                              onClick=${() => setSelectedPageIdx(idx)}
                            >
                              <span class=${`page-dot ${res.status}`}></span>
                              <span>Pág. ${idx + 1} (${res.score})</span>
                            </button>
                          `,
                        )}
                      </div>
                    `
                  }

                  <div class=${`result-banner ${activeAnalysis.status}`}>
                    <div>
                      <div class="verdict-title">
                        ${activeAnalysis.label}
                        ${
                          activeDoc.type === "pdf"
                            ? ` — Página ${safePageIdx + 1} de ${activeDoc.pages.length}`
                            : ""
                        }
                      </div>
                      <div class="verdict-desc">
                        ${activeAnalysis.reason}
                        ${
                          activeDoc.type === "pdf"
                            ? activePage.hasVectorText
                              ? ` • PDF com texto vetorial (${activePage.textItemCount} trechos).`
                              : " • PDF digitalizado/rasterizado (sem texto vetorial)."
                            : ""
                        }
                      </div>
                    </div>
                    <div class="score-box">
                      <div class="score-value">${activeAnalysis.score}/100</div>
                      <div class="score-label">Score de Nitidez</div>
                    </div>
                  </div>

                  <div class="metrics-grid">
                    <div class="metric-card">
                      <div class="metric-label">Laplacian (Tiles Ativos)</div>
                      <div class="metric-value">
                        ${activeAnalysis.metrics.activeLaplacianVar}
                      </div>
                      <div class="metric-note">Ignora margens em branco</div>
                    </div>

                    <div class="metric-card">
                      <div class="metric-label">Laplacian (Global)</div>
                      <div class="metric-value">
                        ${activeAnalysis.metrics.globalLaplacianVar}
                      </div>
                      <div class="metric-note">Imagem inteira (baseline)</div>
                    </div>

                    <div class="metric-card">
                      <div class="metric-label">Tenengrad (Sobel)</div>
                      <div class="metric-value">
                        ${activeAnalysis.metrics.activeTenengrad}
                      </div>
                      <div class="metric-note">Energia média de gradientes</div>
                    </div>

                    <div class="metric-card">
                      <div class="metric-label">Largura de Borda</div>
                      <div class="metric-value">
                        ${
                          activeAnalysis.metrics.avgEdgeWidth !== null
                            ? `${activeAnalysis.metrics.avgEdgeWidth} px`
                            : "N/A"
                        }
                      </div>
                      <div class="metric-note">
                        Nítido &lt; 2.6 px • Borrado &gt; 4.5 px
                      </div>
                    </div>

                    <div class="metric-card">
                      <div class="metric-label">Tiles Borrados</div>
                      <div class="metric-value">
                        ${Math.round(activeAnalysis.metrics.blurryTileRatio * 100)}%
                      </div>
                      <div class="metric-note">
                        ${activeAnalysis.metrics.activeTileCount} ativos /
                        ${activeAnalysis.metrics.totalTileCount} totais
                      </div>
                    </div>

                    <div class="metric-card">
                      <div class="metric-label">Tempo & Resolução</div>
                      <div class="metric-value">
                        ${activeAnalysis.metrics.elapsedMs} ms
                      </div>
                      <div class="metric-note">
                        ${activeAnalysis.metrics.analyzedWidth}×${activeAnalysis.metrics.analyzedHeight}px
                      </div>
                    </div>
                  </div>

                  <div class="preview-toolbar">
                    <span class="section-label" style="margin: 0;">
                      Inspeção Visual
                      ${showHeatmap ? "(Overlay por Tile Ativo)" : ""}
                    </span>
                    <div class="legend">
                      <span class="legend-item">
                        <span
                          class="swatch"
                          style="background: rgba(34, 197, 94, 0.7);"
                        ></span>
                        Nítido
                      </span>
                      <span class="legend-item">
                        <span
                          class="swatch"
                          style="background: rgba(245, 158, 11, 0.8);"
                        ></span>
                        Limítrofe
                      </span>
                      <span class="legend-item">
                        <span
                          class="swatch"
                          style="background: rgba(239, 68, 68, 0.8);"
                        ></span>
                        Borrado
                      </span>
                      <span class="legend-item">
                        <span
                          class="swatch"
                          style="background: rgba(148, 163, 184, 0.25); border: 1px solid var(--border);"
                        ></span>
                        Fundo ignorado
                      </span>
                    </div>
                  </div>

                  <div class="canvas-frame">
                    <canvas ref=${previewCanvasRef}></canvas>
                  </div>

                  <div class="diag-notes">
                    <strong
                      >Como o algoritmo selecionado funciona
                      (${activeAlgorithm.label}):</strong
                    >
                    <p style="margin: 4px 0 0;">
                      ${activeAlgorithm.description}
                    </p>
                    ${
                      activeDoc.truncated
                        ? `<p style="margin: 6px 0 0; color: var(--warn);">Nota: Este PDF possui ${activeDoc.totalPages} páginas; a POC analisou as primeiras ${activeDoc.pages.length}.</p>`
                        : ""
                    }
                  </div>
                `
          }
        </main>
      </div>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("app"));

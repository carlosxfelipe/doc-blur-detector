# POC — Detector de Documentos Borrados (Preact CDN)

Prova de conceito 100% client-side usando **Preact + HTM via CDN** (ES Modules nativos, sem bundler/build) e **PDF.js via CDN** para detectar se imagens e páginas de PDF estão borradas antes de um envio.

## Estrutura

- `index.html` — Importmap do Preact/HTM, import de CSS e módulo principal JS
- `css/styles.css` — Estilos da interface diagnóstica
- `js/blurDetector.js` — Motor puro de detecção de borrão em documentos
- `js/pdfProcessor.js` — Renderização de páginas PDF para `Canvas` / `ImageData` via PDF.js CDN
- `js/sampleGenerator.js` — Gerador de documentos sintéticos (nítido, foco borrado, motion blur e borrão parcial)
- `js/app.js` — Aplicação Preact com calibração de thresholds e heatmap por região
- `test/blurDetector.test.mjs` — Testes unitários do algoritmo em Node.js
- `run.sh` — Script para subir o servidor HTTP local (`python3` ou fallback para `npx serve`)
- `fmt.sh` — Script de formatação de código (`prettier` e `shfmt`)

## CDNs utilizadas

- **esm.sh** (em `index.html` via `importmap`):
  - `preact@10.25.4`
  - `preact@10.25.4/hooks`
  - `htm@3.1.1`
- **jsDelivr** (carregamento dinâmico em `js/pdfProcessor.js`):
  - `pdfjs-dist@4.10.38/build/pdf.min.mjs`
  - `pdfjs-dist@4.10.38/build/pdf.worker.min.mjs`

## Scripts e execução local

Como o projeto utiliza `<script type="module">` e `importmap`, sirva a pasta via HTTP local (não abra direto com `file://`):

### Iniciar o servidor local (`run.sh`)

```bash
./run.sh        # inicia na porta padrão 8080
./run.sh 3000   # opcional: informa uma porta customizada
```

O script tenta usar `python3 -m http.server` e faz fallback para `npx --yes serve`. Depois acesse `http://localhost:8080` (ou a porta informada).

### Formatar arquivos (`fmt.sh`)

```bash
./fmt.sh
```

Formata arquivos `.js`, `.mjs`, `.css`, `.html` e `.md` com `prettier` (ou `npx prettier`) e scripts `.sh` com `shfmt` (ou `uvx --from shfmt-py shfmt`).

### Rodar os testes unitários

```bash
node --test test/blurDetector.test.mjs
```

## Algoritmos disponíveis em `js/blurDetector.js`

1. **Laplacian Variance (Global Clássico)** _(padrão)_ — calcula a variância do Laplaciano na imagem inteira.
2. **Laplacian Variance (Tiles Ativos)** — divide o documento em tiles, descarta margens/áreas em branco de baixo contraste e calcula a variância apenas nos blocos ativos.
3. **Tenengrad (Energia de Gradiente Sobel)** — mede a energia quadrática dos gradientes Sobel nos blocos ativos com conteúdo.
4. **Largura de Borda (Estilo Marziliano)** — mede quantos pixels a borda leva para ir do mínimo ao máximo local (resistente a baixo contraste).

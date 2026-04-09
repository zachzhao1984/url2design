import "./style.css";
type DesignResponse = {
  fileName: string;
  markdown: string;
  sampledPages: string[];
  summary: string;
  warnings: string[];
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root was not found.");
}

app.innerHTML = `
  <div class="page-shell">
    <header class="topbar">
      <div class="topbar-inner">
        <p class="brand">URL2DESIGN.md</p>
        <a
          class="topbar-copy"
          href="https://stitch.withgoogle.com/docs/design-md/overview"
          target="_blank"
          rel="noreferrer"
        >
          Google Stitch DESIGN.md
        </a>
      </div>
    </header>

    <main>
      <section class="hero-section">
        <div class="hero-ambient" aria-hidden="true">
          <div class="hero-orb hero-orb-1"></div>
          <div class="hero-orb hero-orb-2"></div>
          <div class="hero-orb hero-orb-3"></div>
          <div class="hero-beam"></div>
          <div class="hero-grid"></div>
        </div>

        <div class="hero-content">
          <p class="eyebrow">URL to Stitch DESIGN.md</p>
          <h1>Translate any web URL to <code>DESIGN.md</code>.</h1>
          <form id="design-form" class="generator-form" novalidate>
            <label class="sr-only" for="website-url">Website URL</label>
            <div class="input-row">
              <input
                id="website-url"
                name="url"
                type="url"
                inputmode="url"
                autocomplete="url"
                placeholder="Enter your website URL"
                required
              />
              <button id="submit-button" type="submit">Generate</button>
            </div>
            <p id="status-message" class="status-message" role="status" aria-live="polite"></p>
          </form>

          <div class="hero-notes" aria-hidden="true">
            <p>Colors, typography, spacing, layout.</p>
            <p>One accent color. One exported markdown file.</p>
          </div>
        </div>
      </section>

      <section id="result-panel" class="result-panel" hidden>
        <div class="result-shell">
          <div class="result-card">
            <div class="result-header">
              <div>
                <p class="result-label">Generated File</p>
                <p class="result-title">DESIGN.md is ready.</p>
              </div>
              <a id="download-link" class="download-link" href="#" download>Download DESIGN.md</a>
            </div>
            <p id="result-summary" class="result-summary"></p>
            <p id="result-meta" class="result-meta"></p>
            <ul id="warning-list" class="warning-list" hidden></ul>
          </div>

          <details class="preview-panel">
            <summary>Preview generated markdown</summary>
            <pre id="markdown-preview"></pre>
          </details>
        </div>
      </section>
    </main>
  </div>
`;

const form = document.querySelector<HTMLFormElement>("#design-form")!;
const urlInput = document.querySelector<HTMLInputElement>("#website-url")!;
const submitButton = document.querySelector<HTMLButtonElement>("#submit-button")!;
const statusMessage = document.querySelector<HTMLParagraphElement>("#status-message")!;
const resultPanel = document.querySelector<HTMLElement>("#result-panel")!;
const resultSummary = document.querySelector<HTMLParagraphElement>("#result-summary")!;
const resultMeta = document.querySelector<HTMLParagraphElement>("#result-meta")!;
const warningList = document.querySelector<HTMLUListElement>("#warning-list")!;
const preview = document.querySelector<HTMLPreElement>("#markdown-preview")!;
const downloadLink = document.querySelector<HTMLAnchorElement>("#download-link")!;

let activeDownloadUrl = "";

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!urlInput.reportValidity()) {
    return;
  }

  setLoadingState(true, "Crawling the site and generating DESIGN.md...");
  hideResult();

  try {
    const response = await fetch("/api/design", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: urlInput.value.trim() }),
    });

    const payload = (await response.json()) as DesignResponse & { error?: string };

    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? "Generation failed.");
    }

    showResult(payload);
    setLoadingState(false, "DESIGN.md generated successfully.");
  } catch (error) {
    setLoadingState(
      false,
      error instanceof Error ? error.message : "Unable to generate DESIGN.md.",
      true,
    );
  }
});

window.addEventListener("beforeunload", () => {
  if (activeDownloadUrl) {
    URL.revokeObjectURL(activeDownloadUrl);
  }
});

function showResult(payload: DesignResponse) {
  if (activeDownloadUrl) {
    URL.revokeObjectURL(activeDownloadUrl);
  }

  activeDownloadUrl = URL.createObjectURL(
    new Blob([payload.markdown], { type: "text/markdown;charset=utf-8" }),
  );

  downloadLink.href = activeDownloadUrl;
  downloadLink.download = payload.fileName;
  resultSummary.textContent = payload.summary;
  resultMeta.textContent = `Sampled ${payload.sampledPages.length} page(s): ${payload.sampledPages.join(" · ")}`;
  preview.textContent = payload.markdown;

  warningList.innerHTML = "";
  if (payload.warnings.length > 0) {
    warningList.hidden = false;
    for (const warning of payload.warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      warningList.append(item);
    }
  } else {
    warningList.hidden = true;
  }

  resultPanel.hidden = false;
}

function hideResult() {
  resultPanel.hidden = true;
  warningList.innerHTML = "";
  warningList.hidden = true;
}

function setLoadingState(isLoading: boolean, message: string, isError = false) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Analyzing..." : "Generate";
  statusMessage.textContent = message;
  statusMessage.dataset.state = isError ? "error" : isLoading ? "loading" : "idle";
}

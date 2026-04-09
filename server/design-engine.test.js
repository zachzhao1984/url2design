import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { generateDesignArtifact } from "./design-engine.js";

describe("generateDesignArtifact", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("builds a structured DESIGN.md from sampled HTML and CSS", async () => {
    const pages = new Map([
      [
        "https://example.com/",
        {
          ok: true,
          status: 200,
          url: "https://example.com/",
          text: async () => `
            <!doctype html>
            <html>
              <head>
                <title>Example | Home</title>
                <meta name="description" content="Example product marketing site">
                <meta property="og:site_name" content="Example">
                <link rel="stylesheet" href="/assets/site.css">
              </head>
              <body>
                <header>
                  <nav>
                    <a href="/about">About</a>
                  </nav>
                </header>
                <main>
                  <section class="hero">
                    <h1>Example Platform</h1>
                    <a class="button" href="/signup">Start now</a>
                  </section>
                </main>
              </body>
            </html>
          `,
        },
      ],
      [
        "https://example.com/about",
        {
          ok: true,
          status: 200,
          url: "https://example.com/about",
          text: async () => `
            <!doctype html>
            <html>
              <head>
                <title>About Example</title>
                <link rel="stylesheet" href="/assets/site.css">
              </head>
              <body>
                <main>
                  <section class="card">
                    <h2>Design team</h2>
                    <p>We build calm software.</p>
                    <form>
                      <input type="email">
                    </form>
                  </section>
                </main>
              </body>
            </html>
          `,
        },
      ],
      [
        "https://example.com/assets/site.css",
        {
          ok: true,
          status: 200,
          url: "https://example.com/assets/site.css",
          text: async () => `
            :root {
              --surface: #f7f3ea;
              --text: #192928;
              --accent: #0d7a71;
              --radius: 14px;
            }

            body {
              background: var(--surface);
              color: var(--text);
              font-family: "Avenir Next", sans-serif;
              font-size: 16px;
              line-height: 1.5;
            }

            h1 {
              font-size: 56px;
              letter-spacing: -0.04em;
            }

            .button,
            button {
              background-color: var(--accent);
              color: #ffffff;
              border-radius: var(--radius);
              transition: background-color 160ms ease;
            }

            .button:hover,
            .button:focus-visible {
              background-color: #0a5e58;
            }

            .card {
              padding: 24px;
              box-shadow: 0 12px 30px rgba(0, 0, 0, 0.12);
            }

            @media (min-width: 768px) {
              .grid {
                display: grid;
                gap: 24px;
              }
            }
          `,
        },
      ],
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        const response = pages.get(url);

        if (!response) {
          throw new Error(`Unexpected fetch: ${url}`);
        }

        return response;
      }),
    );

    const artifact = await generateDesignArtifact("example.com");

    expect(artifact.fileName).toBe("example-com-DESIGN.md");
    expect(artifact.sampledPages).toEqual(["https://example.com/", "https://example.com/about"]);
    expect(artifact.markdown).toContain("# Design System: Example");
    expect(artifact.markdown).toContain("## 2. Color Palette & Roles");
    expect(artifact.markdown).toContain("## 7. Guardrails");
    expect(artifact.markdown).toContain("**#0D7A71**");
    expect(artifact.summary).toContain("Example presents");
  });

  test("rejects unsupported URL schemes", async () => {
    await expect(generateDesignArtifact("ftp://example.com")).rejects.toThrow(
      "Only http and https URLs are supported.",
    );
  });
});

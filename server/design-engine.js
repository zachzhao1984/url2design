import { load } from "cheerio";

const PAGE_LIMIT = 3;
const STYLESHEET_LIMIT = 8;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_LENGTH = 1_000_000;
const MAX_CSS_LENGTH = 700_000;
const REQUEST_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/css;q=0.8,*/*;q=0.5",
  "user-agent": "Mozilla/5.0 (compatible; url2design/1.0; +https://url2design.local)",
};

const MEDIA_QUERY_REGEX = /@media[^{]*\((min|max)-width:\s*([0-9.]+)px\)/gi;
const DECLARATION_REGEX = /([A-Za-z_-][\w-]*)\s*:\s*([^;{}]+);/g;
const COLOR_REGEX = /#(?:[0-9a-f]{3,8})\b|rgba?\([^)]+\)|hsla?\([^)]+\)/gi;
const TIME_REGEX = /([\d.]+)\s*(ms|s)\b/gi;

export async function generateDesignArtifact(inputUrl) {
  const sourceUrl = normalizeWebsiteUrl(inputUrl);
  const crawl = await crawlSite(sourceUrl);
  const analysis = analyzeSite(crawl, sourceUrl);
  const fileName = `${buildSafeFileStem(new URL(sourceUrl).hostname)}-DESIGN.md`;

  return {
    fileName,
    markdown: renderDesignMarkdown(analysis),
    sampledPages: crawl.pages.map((page) => page.url),
    summary: analysis.summary,
    warnings: crawl.warnings,
  };
}

async function crawlSite(sourceUrl) {
  const warnings = [];
  const pages = [];
  const seenPages = new Set();
  const stylesheetTexts = [];
  const seenStylesheets = new Set();

  const rootPage = await fetchPage(sourceUrl, warnings);
  pages.push(rootPage);
  seenPages.add(normalizeForSet(rootPage.url));

  const origin = new URL(rootPage.url).origin;
  const sampleTargets = pickSamplePages(rootPage.links, origin, PAGE_LIMIT - 1);

  for (const targetUrl of sampleTargets) {
    try {
      const page = await fetchPage(targetUrl, warnings);
      const normalized = normalizeForSet(page.url);
      if (seenPages.has(normalized)) {
        continue;
      }
      pages.push(page);
      seenPages.add(normalized);
    } catch (error) {
      warnings.push(`Skipped ${targetUrl}: ${getErrorMessage(error)}`);
    }
  }

  for (const page of pages) {
    for (const inlineStyle of page.inlineStyles) {
      if (inlineStyle.trim()) {
        stylesheetTexts.push({
          source: `${page.url}#inline-style`,
          text: truncateText(inlineStyle, MAX_CSS_LENGTH),
        });
      }
    }

    for (const styleAttribute of page.styleAttributes) {
      if (styleAttribute.trim()) {
        stylesheetTexts.push({
          source: `${page.url}#style-attr`,
          text: `.inline-style { ${styleAttribute} }`,
        });
      }
    }

    for (const stylesheetUrl of page.stylesheetUrls) {
      if (stylesheetTexts.length >= STYLESHEET_LIMIT) {
        break;
      }
      const normalized = normalizeForSet(stylesheetUrl);
      if (seenStylesheets.has(normalized)) {
        continue;
      }
      seenStylesheets.add(normalized);

      try {
        const response = await fetchText(stylesheetUrl);
        stylesheetTexts.push({
          source: stylesheetUrl,
          text: truncateText(response.text, MAX_CSS_LENGTH),
        });
      } catch (error) {
        warnings.push(`Skipped stylesheet ${stylesheetUrl}: ${getErrorMessage(error)}`);
      }
    }
  }

  return {
    pages,
    stylesheets: stylesheetTexts,
    warnings: dedupeStrings(warnings),
  };
}

async function fetchPage(url, warnings) {
  const response = await fetchText(url);
  const html = truncateText(response.text, MAX_HTML_LENGTH);
  const $ = load(html);
  const finalUrl = response.url;
  const bodyText = collectBodyText($);
  const headings = uniqueStrings(
    $("h1, h2, h3")
      .map((_, element) => sanitizeText($(element).text()))
      .get(),
  ).slice(0, 8);

  const scriptCount = $("script").length;
  if (bodyText.length < 120 && scriptCount >= 5) {
    warnings.push(
      `The page ${finalUrl} appears script-heavy, so the analysis relies more on shipped stylesheets than rendered content.`,
    );
  }

  return {
    url: finalUrl,
    title: sanitizeTitle($("title").first().text()),
    siteName: sanitizeTitle(
      $('meta[property="og:site_name"]').attr("content") ??
        $('meta[name="application-name"]').attr("content") ??
        "",
    ),
    description: sanitizeText(
      $('meta[name="description"]').attr("content") ??
        $('meta[property="og:description"]').attr("content") ??
        "",
    ),
    headings,
    links: collectLinks($, finalUrl),
    stylesheetUrls: collectStylesheetUrls($, finalUrl),
    inlineStyles: $("style")
      .map((_, element) => $(element).html() ?? "")
      .get(),
    styleAttributes: $("[style]")
      .slice(0, 80)
      .map((_, element) => $(element).attr("style") ?? "")
      .get(),
    counts: {
      nav: $("nav").length,
      buttons:
        $("button").length + $('a[class*="button"], a[class*="btn"], a[class*="cta"]').length,
      forms: $("form").length,
      fields: $("input, textarea, select").length,
      sections: $("section, article, main > div").length,
      cards: $('[class*="card"], [class*="tile"], [class*="panel"]').length,
      media: $("img, video, picture").length,
    },
    bodyText,
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return {
    text: await response.text(),
    url: response.url,
  };
}

function analyzeSite(crawl, sourceUrl) {
  const cssEntries = crawl.stylesheets.map((entry) => entry.text);
  const declarations = collectDeclarations(cssEntries);
  const variableMap = buildVariableMap(declarations);
  const palette = analyzePalette(declarations, variableMap);
  const typography = analyzeTypography(declarations, variableMap);
  const layout = analyzeLayout(declarations, variableMap, cssEntries);
  const motion = analyzeMotion(declarations, cssEntries);
  const html = analyzeHtml(crawl.pages);
  const siteName = inferSiteName(crawl.pages, sourceUrl);
  const summary = buildSummary(siteName, palette, typography, layout, motion, html);
  const components = buildComponentSections(palette, typography, layout, motion, html);
  const guardrails = buildGuardrails(palette, typography, layout, motion);

  return {
    siteName,
    sourceUrl,
    sampledPages: crawl.pages.map((page) => page.url),
    warnings: crawl.warnings,
    confidence: getConfidenceLabel(crawl.pages.length, crawl.stylesheets.length, crawl.warnings),
    summary,
    palette,
    typography,
    layout,
    motion,
    components,
    guardrails,
  };
}

function collectDeclarations(cssEntries) {
  const declarations = [];

  for (const cssEntry of cssEntries) {
    const css = stripCssComments(cssEntry);
    let match;

    while ((match = DECLARATION_REGEX.exec(css)) !== null) {
      const property = match[1].trim().toLowerCase();
      const value = match[2].trim();

      if (!property || !value) {
        continue;
      }

      declarations.push({ property, value });
    }
  }

  return declarations;
}

function buildVariableMap(declarations) {
  const variables = new Map();

  for (const declaration of declarations) {
    if (!declaration.property.startsWith("--")) {
      continue;
    }

    variables.set(declaration.property, declaration.value);
  }

  return variables;
}

function analyzePalette(declarations, variableMap) {
  const stats = new Map();

  for (const declaration of declarations) {
    if (declaration.property.startsWith("--")) {
      continue;
    }

    const usage = getColorUsage(declaration.property);
    if (!usage) {
      continue;
    }

    const resolved = resolveCssVars(declaration.value, variableMap);
    const colors = extractColors(resolved);
    for (const color of colors) {
      const key = color.key;
      const current = stats.get(key) ?? {
        ...color,
        count: 0,
        background: 0,
        text: 0,
        border: 0,
        shadow: 0,
        accent: 0,
      };

      current.count += 1;
      current[usage] += 1;
      stats.set(key, current);
    }
  }

  const entries = [...stats.values()].sort(sortColorStats).slice(0, 8);
  const background =
    entries.filter((entry) => entry.background > 0).sort(sortByUsage("background"))[0] ??
    entries[0] ??
    null;
  const text =
    entries.filter((entry) => entry.text > 0).sort(sortByUsage("text"))[0] ??
    entries[1] ??
    background;
  const accentCandidates = entries
    .filter(
      (entry) =>
        entry.key !== background?.key && entry.key !== text?.key && entry.saturation >= 0.16,
    )
    .sort((left, right) => {
      const leftScore = left.count * (left.saturation + 0.2);
      const rightScore = right.count * (right.saturation + 0.2);
      return rightScore - leftScore;
    });
  const accent = accentCandidates[0] ?? entries[2] ?? entries[1] ?? null;

  return {
    entries: entries.map((entry) => ({
      ...entry,
      role: describeColorRole(entry, background, text, accent),
    })),
    background,
    text,
    accent,
  };
}

function analyzeTypography(declarations, variableMap) {
  const familyCounts = new Map();
  const sizeCounts = new Map();
  const weightCounts = new Map();
  const lineHeightCounts = new Map();
  const trackingCounts = new Map();

  for (const declaration of declarations) {
    const value = resolveCssVars(declaration.value, variableMap);

    if (declaration.property === "font-family") {
      const normalized = normalizeFontStack(value);
      if (normalized) {
        bumpCount(familyCounts, normalized);
      }
    }

    if (declaration.property === "font-size") {
      for (const size of extractPixelValues(value, { min: 9, max: 96 })) {
        bumpCount(sizeCounts, size);
      }
    }

    if (declaration.property === "font-weight") {
      const normalized = normalizeFontWeight(value);
      if (normalized) {
        bumpCount(weightCounts, normalized);
      }
    }

    if (declaration.property === "line-height") {
      const normalized = normalizeLineHeight(value);
      if (normalized) {
        bumpCount(lineHeightCounts, normalized);
      }
    }

    if (declaration.property === "letter-spacing") {
      const normalized = normalizeTracking(value);
      if (normalized) {
        bumpCount(trackingCounts, normalized);
      }
    }
  }

  const families = topEntries(familyCounts, 4).map(([value]) => value);
  const sizes = topEntries(sizeCounts, 10)
    .map(([value]) => Number(value))
    .sort((left, right) => left - right);
  const weights = topEntries(weightCounts, 6).map(([value]) => value);
  const lineHeights = topEntries(lineHeightCounts, 6).map(([value]) => value);
  const tracking = topEntries(trackingCounts, 6).map(([value]) => value);

  return {
    families,
    sizes,
    weights,
    lineHeights,
    tracking,
  };
}

function analyzeLayout(declarations, variableMap, cssEntries) {
  const spacingCounts = new Map();
  const radiusCounts = new Map();
  const widthCounts = new Map();
  const shadowCounts = new Map();
  let flexLayouts = 0;
  let gridLayouts = 0;

  for (const declaration of declarations) {
    const value = resolveCssVars(declaration.value, variableMap);

    if (isSpacingProperty(declaration.property)) {
      for (const pxValue of extractPixelValues(value, { min: 2, max: 160 })) {
        bumpCount(spacingCounts, pxValue);
      }
    }

    if (declaration.property.includes("radius")) {
      for (const pxValue of extractPixelValues(value, { min: 2, max: 9999 })) {
        bumpCount(radiusCounts, pxValue);
      }
    }

    if (declaration.property === "max-width" || declaration.property === "width") {
      for (const pxValue of extractPixelValues(value, { min: 240, max: 1800 })) {
        bumpCount(widthCounts, pxValue);
      }
    }

    if (declaration.property === "box-shadow") {
      bumpCount(shadowCounts, normalizeShadow(value));
    }

    if (declaration.property === "display") {
      if (value.includes("flex")) {
        flexLayouts += 1;
      }

      if (value.includes("grid")) {
        gridLayouts += 1;
      }
    }
  }

  const breakpoints = collectBreakpoints(cssEntries);

  return {
    spacingScale: topEntries(spacingCounts, 10)
      .map(([value]) => Number(value))
      .sort((left, right) => left - right),
    radiusScale: topEntries(radiusCounts, 8)
      .map(([value]) => Number(value))
      .sort((left, right) => left - right),
    maxWidths: topEntries(widthCounts, 6)
      .map(([value]) => Number(value))
      .sort((left, right) => left - right),
    shadows: topEntries(shadowCounts, 4).map(([value]) => value),
    breakpoints,
    usesFlex: flexLayouts > 0,
    usesGrid: gridLayouts > 0,
  };
}

function analyzeMotion(declarations, cssEntries) {
  const durations = new Map();
  let hasHover = false;
  let hasFocus = false;
  let hasAnimation = false;
  let usesTransform = false;
  let smoothScroll = false;

  for (const cssEntry of cssEntries) {
    hasHover ||= cssEntry.includes(":hover");
    hasFocus ||= cssEntry.includes(":focus") || cssEntry.includes(":focus-visible");
    hasAnimation ||= cssEntry.includes("@keyframes");
  }

  for (const declaration of declarations) {
    if (
      declaration.property === "transition" ||
      declaration.property === "transition-duration" ||
      declaration.property === "animation" ||
      declaration.property === "animation-duration"
    ) {
      for (const duration of extractDurations(declaration.value)) {
        bumpCount(durations, duration);
      }
    }

    if (declaration.property === "transform") {
      usesTransform = true;
    }

    if (declaration.property === "scroll-behavior" && declaration.value.includes("smooth")) {
      smoothScroll = true;
    }
  }

  const durationValues = topEntries(durations, 6)
    .map(([value]) => Number(value))
    .sort((left, right) => left - right);

  return {
    durations: durationValues,
    hasHover,
    hasFocus,
    hasAnimation,
    usesTransform,
    smoothScroll,
    level: getMotionLabel(durationValues, hasAnimation),
  };
}

function analyzeHtml(pages) {
  const counts = {
    nav: 0,
    buttons: 0,
    forms: 0,
    fields: 0,
    sections: 0,
    cards: 0,
    media: 0,
  };

  const headings = [];
  const descriptions = [];

  for (const page of pages) {
    for (const key of Object.keys(counts)) {
      counts[key] += page.counts[key];
    }

    headings.push(...page.headings);
    descriptions.push(page.description);
  }

  return {
    counts,
    headings: uniqueStrings(headings).slice(0, 8),
    descriptions: uniqueStrings(descriptions).slice(0, 4),
  };
}

function buildSummary(siteName, palette, typography, layout, motion, html) {
  const mode = getSurfaceMode(palette.background, palette.text);
  const paletteTone = getPaletteTone(palette.entries);
  const typeTone = getTypographyTone(typography.families);
  const density = getDensityLabel(layout.spacingScale, html.counts.sections);
  const accentLabel = palette.accent?.label ?? "a restrained accent";
  const primaryFont = typography.families[0] ?? "a modern sans-serif";
  const radiusLabel =
    layout.radiusScale.length > 0 ? `${formatNumber(layout.radiusScale[0])}px` : "soft";

  return [
    `${siteName} presents a ${mode}, ${paletteTone} interface with ${density} spacing and ${motion.level} interaction motion.`,
    `The system leans on ${primaryFont}, a ${radiusLabel} corner language, and ${accentLabel} as the main interactive highlight.`,
    html.headings.length > 0
      ? `Sampled content suggests a product language centered around ${html.headings
          .slice(0, 3)
          .join(", ")}.`
      : `Sampled content is limited, so the guidance focuses on shipped CSS tokens and structural patterns.`,
    typeTone,
  ].join(" ");
}

function buildComponentSections(palette, typography, layout, motion, html) {
  const sections = [];
  const radiusSummary = summarizeScale(layout.radiusScale, "px");
  const spacingSummary = summarizeScale(layout.spacingScale, "px");
  const primaryFont = typography.families[0] ?? "the primary UI font";
  const accent = palette.accent?.label ?? "the main accent";
  const background = palette.background?.label ?? "the dominant surface color";

  if (html.counts.nav > 0) {
    sections.push({
      title: "Navigation",
      points: [
        `Navigation is present across sampled pages and should stay aligned to ${primaryFont} with compact spacing.`,
        `Keep the top-level shell anchored to ${background} surfaces and the same spacing rhythm (${spacingSummary}).`,
      ],
    });
  }

  sections.push({
    title: "Buttons & Links",
    points: [
      `Primary interactive emphasis should remain tied to ${accent}, with corner treatment drawn from ${radiusSummary}.`,
      motion.hasHover || motion.hasFocus
        ? `Hover and focus states are part of the current system and should stay subtle, fast, and contrast-driven.`
        : `Interaction states appear restrained; preserve clarity through contrast before adding heavier motion.`,
    ],
  });

  if (html.counts.cards > 0 || html.counts.sections > 4) {
    sections.push({
      title: "Cards & Content Blocks",
      points: [
        `Content is grouped into repeatable blocks, so card surfaces should stay within the current palette hierarchy and avoid introducing new decorative treatments.`,
        layout.shadows.length > 0
          ? `Depth is lightweight and should reuse the observed shadow language (${layout.shadows[0]}).`
          : `Depth appears minimal; rely on spacing, borders, or tonal surfaces before adding heavier shadows.`,
      ],
    });
  }

  if (html.counts.forms > 0 || html.counts.fields > 0) {
    sections.push({
      title: "Forms",
      points: [
        `Inputs should stay visually quieter than calls to action, using the existing spacing scale (${spacingSummary}) and radius system (${radiusSummary}).`,
        `Preserve clear focus styling and keep field chrome secondary to content and submit actions.`,
      ],
    });
  }

  return sections;
}

function buildGuardrails(palette, typography, layout, motion) {
  const background = palette.background?.label ?? "the dominant surface";
  const text = palette.text?.label ?? "the main text color";
  const accent = palette.accent?.label ?? "the current accent";
  const font = typography.families[0] ?? "the existing font stack";
  const spacing = summarizeScale(layout.spacingScale, "px");
  const radii = summarizeScale(layout.radiusScale, "px");
  const durations =
    motion.durations.length > 0
      ? `${motion.durations.map((value) => `${formatNumber(value)}ms`).join(", ")}`
      : "very short transitions";

  return [
    `Do: keep surfaces anchored to ${background} with ${text} carrying the primary reading contrast.`,
    `Do: preserve ${font} as the core UI voice and extend the observed size scale before inventing new jumps.`,
    `Do: reuse the existing spacing (${spacing}) and radii (${radii}) as the first layout constraint.`,
    `Do: keep interaction feedback in the ${durations} range and bias toward hover/focus clarity over animation spectacle.`,
    `Don't: introduce additional high-chroma accents beyond ${accent} unless the brand already needs them.`,
    `Don't: mix unrelated shadow systems or radius styles that break the current visual cadence.`,
  ];
}

function renderDesignMarkdown(analysis) {
  const paletteLines =
    analysis.palette.entries.length > 0
      ? analysis.palette.entries.map((entry) => `- **${entry.label}**: ${entry.role}`)
      : ["- No stable color tokens were detected from the sampled stylesheets."];

  const typographyLines = [
    `- Primary font families: ${analysis.typography.families.join(", ") || "Not confidently detected"}`,
    `- Observed size scale: ${formatNumberList(analysis.typography.sizes, "px") || "Not confidently detected"}`,
    `- Common font weights: ${analysis.typography.weights.join(", ") || "Not confidently detected"}`,
    `- Common line-heights: ${analysis.typography.lineHeights.join(", ") || "Not confidently detected"}`,
    `- Tracking usage: ${analysis.typography.tracking.join(", ") || "Not confidently detected"}`,
  ];

  const layoutLines = [
    `- Spacing scale: ${formatNumberList(analysis.layout.spacingScale, "px") || "Not confidently detected"}`,
    `- Radius scale: ${formatNumberList(analysis.layout.radiusScale, "px") || "Not confidently detected"}`,
    `- Container widths: ${formatNumberList(analysis.layout.maxWidths, "px") || "Not confidently detected"}`,
    `- Layout primitives: ${describeLayoutPrimitives(analysis.layout)}`,
    `- Responsive breakpoints: ${analysis.layout.breakpoints.join(", ") || "Not confidently detected"}`,
  ];

  const motionLines = [
    `- Motion level: ${analysis.motion.level}`,
    `- Transition durations: ${formatNumberList(analysis.motion.durations, "ms") || "Not confidently detected"}`,
    `- Hover states: ${analysis.motion.hasHover ? "Present" : "Not prominently detected"}`,
    `- Focus states: ${analysis.motion.hasFocus ? "Present" : "Not prominently detected"}`,
    `- Animation system: ${analysis.motion.hasAnimation ? "Keyframes detected" : "No keyframes detected"}`,
  ];

  const componentLines = analysis.components
    .map(
      (section) =>
        `### ${section.title}\n${section.points.map((point) => `- ${point}`).join("\n")}`,
    )
    .join("\n\n");

  const crawlNotes = [
    `- Source URL: ${analysis.sourceUrl}`,
    `- Sampled pages: ${analysis.sampledPages.join(", ")}`,
    `- Confidence: ${analysis.confidence}`,
    ...analysis.warnings.map((warning) => `- Crawl note: ${warning}`),
  ].join("\n");

  return `# Design System: ${analysis.siteName}

## 1. Visual Theme & Atmosphere

${analysis.summary}

${crawlNotes}

## 2. Color Palette & Roles

${paletteLines.join("\n")}

## 3. Typography Rules

${typographyLines.join("\n")}

## 4. Component Stylings

${componentLines}

## 5. Layout Principles

${layoutLines.join("\n")}

## 6. Motion & Interaction

${motionLines.join("\n")}

## 7. Guardrails

${analysis.guardrails.map((line) => `- ${line}`).join("\n")}
`;
}

function collectLinks($, pageUrl) {
  const selectors = [
    "header nav a[href]",
    "nav a[href]",
    "header a[href]",
    "main a[href]",
    "a[href]",
  ];
  const links = [];
  const seen = new Set();

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const href = $(element).attr("href");
      const text = sanitizeText($(element).text());
      const resolved = resolveCandidateUrl(href, pageUrl);

      if (!resolved || seen.has(normalizeForSet(resolved))) {
        return;
      }

      seen.add(normalizeForSet(resolved));
      links.push({ url: resolved, text, source: selector });
    });
  }

  return links;
}

function collectStylesheetUrls($, pageUrl) {
  const urls = [];
  const seen = new Set();

  $('link[rel~="stylesheet"][href], link[href$=".css"]').each((_, element) => {
    const href = $(element).attr("href");
    const resolved = resolveCandidateUrl(href, pageUrl);
    if (!resolved) {
      return;
    }

    const normalized = normalizeForSet(resolved);
    if (seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    urls.push(resolved);
  });

  return urls;
}

function pickSamplePages(links, origin, limit) {
  return links
    .filter((link) => {
      const url = new URL(link.url);
      return (
        url.origin === origin &&
        url.pathname !== "/" &&
        !/\.(pdf|jpg|jpeg|png|svg|gif|webp|zip)$/i.test(url.pathname)
      );
    })
    .sort((left, right) => rankLink(right) - rankLink(left))
    .slice(0, limit)
    .map((link) => link.url);
}

function rankLink(link) {
  const url = new URL(link.url);
  const pathDepth = url.pathname.split("/").filter(Boolean).length;
  const keywordScore =
    /(about|feature|features|product|pricing|service|services|platform|solution|work|portfolio)/i.test(
      `${link.text} ${url.pathname}`,
    )
      ? 3
      : 0;

  return keywordScore + (link.source.includes("nav") ? 2 : 0) + Math.max(0, 3 - pathDepth);
}

function inferSiteName(pages, sourceUrl) {
  for (const page of pages) {
    if (page.siteName) {
      return page.siteName;
    }
  }

  for (const page of pages) {
    if (!page.title) {
      continue;
    }

    const splitTitle = page.title.split(/\s[|—-]\s/)[0]?.trim();
    if (splitTitle) {
      return splitTitle;
    }
  }

  return new URL(sourceUrl).hostname.replace(/^www\./, "");
}

function getConfidenceLabel(pageCount, stylesheetCount, warnings) {
  if (pageCount >= 2 && stylesheetCount >= 2 && warnings.length === 0) {
    return "High";
  }

  if (pageCount >= 1 && stylesheetCount >= 1) {
    return "Medium";
  }

  return "Low";
}

function getColorUsage(property) {
  if (property.includes("background") || property === "fill" || property === "stroke") {
    return "background";
  }

  if (
    property === "color" ||
    property.includes("text-decoration-color") ||
    property.includes("caret-color")
  ) {
    return "text";
  }

  if (property.includes("border") || property.includes("outline") || property.includes("ring")) {
    return "border";
  }

  if (property.includes("shadow")) {
    return "shadow";
  }

  if (property.includes("accent")) {
    return "accent";
  }

  return null;
}

function describeColorRole(entry, background, text, accent) {
  if (entry.key === background?.key) {
    return entry.lightness < 0.35
      ? "Primary dark surface / background anchor"
      : "Primary light surface / background anchor";
  }

  if (entry.key === text?.key) {
    return "Primary text / contrast color";
  }

  if (entry.key === accent?.key) {
    return "Primary accent / interactive highlight";
  }

  if (entry.border > 0) {
    return "Divider, border, or subtle chrome";
  }

  if (entry.shadow > 0) {
    return "Shadow, overlay, or depth treatment";
  }

  return "Secondary surface or supporting accent";
}

function describeLayoutPrimitives(layout) {
  const primitives = [];

  if (layout.usesFlex) {
    primitives.push("flex layouts");
  }

  if (layout.usesGrid) {
    primitives.push("grid layouts");
  }

  if (layout.shadows.length > 0) {
    primitives.push(`light depth (${layout.shadows[0]})`);
  }

  return primitives.join(", ") || "Not confidently detected";
}

function getSurfaceMode(background, text) {
  if (!background || !text) {
    return "mixed-surface";
  }

  if (background.lightness <= 0.35 && text.lightness >= 0.7) {
    return "dark-first";
  }

  if (background.lightness >= 0.8 && text.lightness <= 0.3) {
    return "light-first";
  }

  return "mixed-surface";
}

function getPaletteTone(entries) {
  const accents = entries.filter((entry) => entry.saturation >= 0.16);
  if (accents.length <= 1) {
    return "restrained-palette";
  }

  if (accents.length <= 3) {
    return "brand-forward";
  }

  return "multi-accent";
}

function getTypographyTone(families) {
  const primary = families[0]?.toLowerCase() ?? "";

  if (/(serif|georgia|garamond|times|palatino)/i.test(primary)) {
    return "Typography leans editorial and benefits from generous hierarchy rather than dense UI ornamentation.";
  }

  if (/(mono|code|jetbrains|menlo|consolas|courier)/i.test(primary)) {
    return "Typography has a technical flavor, so supporting UI should stay crisp, direct, and low-noise.";
  }

  return "Typography reads as a modern product UI system with a bias toward clarity, utility, and consistency.";
}

function getDensityLabel(spacingScale, sectionCount) {
  const median = spacingScale[Math.floor(spacingScale.length / 2)] ?? 16;

  if (median >= 20 && sectionCount <= 8) {
    return "airy";
  }

  if (median <= 10 || sectionCount >= 20) {
    return "compact";
  }

  return "balanced";
}

function getMotionLabel(durations, hasAnimation) {
  if (hasAnimation || durations.some((value) => value > 350)) {
    return "expressive";
  }

  if (durations.length > 0) {
    return "subtle";
  }

  return "minimal";
}

function collectBreakpoints(cssEntries) {
  const counts = new Map();

  for (const cssEntry of cssEntries) {
    let match;
    while ((match = MEDIA_QUERY_REGEX.exec(cssEntry)) !== null) {
      bumpCount(counts, `${match[1]} ${formatNumber(Number(match[2]))}px`);
    }
  }

  return topEntries(counts, 6).map(([value]) => value);
}

function extractColors(value) {
  const matches = value.match(COLOR_REGEX) ?? [];
  const colors = [];

  for (const token of matches) {
    const normalized = normalizeColorToken(token);
    if (normalized) {
      colors.push(normalized);
    }
  }

  return colors;
}

function normalizeColorToken(token) {
  const raw = token.trim().toLowerCase();
  const parsed = parseHexColor(raw) ?? parseRgbColor(raw) ?? parseHslColor(raw);

  if (!parsed || parsed.a === 0) {
    return null;
  }

  const label =
    parsed.a < 1
      ? `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${trimTrailingZeros(parsed.a)})`
      : rgbToHex(parsed.r, parsed.g, parsed.b);
  const { saturation, lightness } = rgbToHsl(parsed.r, parsed.g, parsed.b);

  return {
    key: `${parsed.r},${parsed.g},${parsed.b},${trimTrailingZeros(parsed.a)}`,
    label,
    saturation,
    lightness,
  };
}

function parseHexColor(value) {
  if (!value.startsWith("#")) {
    return null;
  }

  let hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map((character) => `${character}${character}`).join("");
  }

  if (hex.length !== 6 && hex.length !== 8) {
    return null;
  }

  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;

  return { r, g, b, a };
}

function parseRgbColor(value) {
  const match = value.match(/^rgba?\((.+)\)$/i);
  if (!match) {
    return null;
  }

  const parts = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) {
    return null;
  }

  const rgb = parts.slice(0, 3).map(parseRgbChannel);
  if (rgb.some((channel) => channel === null)) {
    return null;
  }

  const alpha = parts[3] ? parseAlpha(parts[3]) : 1;
  if (alpha === null) {
    return null;
  }

  return {
    r: rgb[0],
    g: rgb[1],
    b: rgb[2],
    a: alpha,
  };
}

function parseHslColor(value) {
  const match = value.match(/^hsla?\((.+)\)$/i);
  if (!match) {
    return null;
  }

  const parts = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) {
    return null;
  }

  const hue = Number.parseFloat(parts[0]);
  const saturation = Number.parseFloat(parts[1]);
  const lightness = Number.parseFloat(parts[2]);

  if (![hue, saturation, lightness].every((valuePart) => Number.isFinite(valuePart))) {
    return null;
  }

  const alpha = parts[3] ? parseAlpha(parts[3]) : 1;
  if (alpha === null) {
    return null;
  }

  const { r, g, b } = hslToRgb(hue, saturation / 100, lightness / 100);
  return { r, g, b, a: alpha };
}

function parseRgbChannel(value) {
  if (value.endsWith("%")) {
    const percent = Number.parseFloat(value);
    if (!Number.isFinite(percent)) {
      return null;
    }
    return clamp(Math.round((percent / 100) * 255), 0, 255);
  }

  const channel = Number.parseFloat(value);
  if (!Number.isFinite(channel)) {
    return null;
  }

  return clamp(Math.round(channel), 0, 255);
}

function parseAlpha(value) {
  const alpha = value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
  if (!Number.isFinite(alpha)) {
    return null;
  }

  return clamp(alpha, 0, 1);
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (hue < 60) {
    r = chroma;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = chroma;
  } else if (hue < 180) {
    g = chroma;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = chroma;
  } else if (hue < 300) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }

  return {
    r: Math.round((r + match) * 255),
    g: Math.round((g + match) * 255),
    b: Math.round((b + match) * 255),
  };
}

function rgbToHsl(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;

  let saturation = 0;
  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
  }

  return {
    saturation,
    lightness,
  };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function resolveCssVars(value, variableMap) {
  let resolved = value;

  for (let index = 0; index < 4; index += 1) {
    const next = resolved.replace(
      /var\((--[\w-]+)(?:,\s*([^)]+))?\)/g,
      (_, variableName, fallback) => variableMap.get(variableName) ?? fallback ?? "",
    );

    if (next === resolved) {
      break;
    }

    resolved = next;
  }

  return resolved;
}

function extractPixelValues(value, { min, max }) {
  const matches = [...value.matchAll(/(-?[\d.]+)\s*(px|rem|em)\b/gi)];
  const values = [];

  for (const match of matches) {
    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount)) {
      continue;
    }

    const unit = match[2].toLowerCase();
    const pxValue = unit === "px" ? amount : unit === "rem" || unit === "em" ? amount * 16 : null;

    if (pxValue === null || pxValue < min || pxValue > max) {
      continue;
    }

    values.push(Number(pxValue.toFixed(2)));
  }

  return uniqueNumbers(values);
}

function extractDurations(value) {
  const durations = [];
  let match;

  while ((match = TIME_REGEX.exec(value)) !== null) {
    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount)) {
      continue;
    }

    const duration = match[2] === "s" ? amount * 1000 : amount;
    durations.push(Number(duration.toFixed(2)));
  }

  return uniqueNumbers(durations);
}

function normalizeFontStack(value) {
  const cleaned = value
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .slice(0, 4);

  return cleaned.length > 0 ? cleaned.join(", ") : null;
}

function normalizeFontWeight(value) {
  const namedWeights = {
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  };

  const normalized = namedWeights[value.toLowerCase()] ?? value.trim();
  return /^\d{3}$/.test(normalized) ? normalized : null;
}

function normalizeLineHeight(value) {
  const unitless = Number.parseFloat(value);
  if (Number.isFinite(unitless) && !/[a-z%]/i.test(value) && unitless >= 0.8 && unitless <= 3) {
    return trimTrailingZeros(unitless);
  }

  const pxValues = extractPixelValues(value, { min: 10, max: 96 });
  return pxValues[0] ? `${formatNumber(pxValues[0])}px` : null;
}

function normalizeTracking(value) {
  const pxValues = extractPixelValues(value, { min: -8, max: 16 });
  if (pxValues[0] !== undefined) {
    return `${formatNumber(pxValues[0])}px`;
  }

  const emMatch = value.match(/(-?[\d.]+)\s*em/i);
  if (emMatch) {
    return `${trimTrailingZeros(Number.parseFloat(emMatch[1]))}em`;
  }

  return null;
}

function normalizeShadow(value) {
  return value.replace(/\s+/g, " ").trim();
}

function isSpacingProperty(property) {
  return /^(margin|padding|gap|column-gap|row-gap|top|right|bottom|left|inset)/.test(property);
}

function collectBodyText($) {
  return sanitizeText($("main, body").first().text()).slice(0, 700);
}

function resolveCandidateUrl(href, pageUrl) {
  if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) {
    return null;
  }

  try {
    const resolved = new URL(href, pageUrl);
    if (!/^https?:$/.test(resolved.protocol)) {
      return null;
    }

    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
}

function normalizeWebsiteUrl(input) {
  const trimmed = input.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let parsedUrl;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    throw new Error("Please provide a valid http or https URL.");
  }

  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  parsedUrl.hash = "";
  return parsedUrl.toString();
}

function normalizeForSet(url) {
  const parsedUrl = new URL(url);
  parsedUrl.hash = "";
  return parsedUrl.toString();
}

function sanitizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeTitle(value) {
  return sanitizeText(value).slice(0, 120);
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function topEntries(map, limit) {
  return [...map.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit);
}

function bumpCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function uniqueStrings(values) {
  return dedupeStrings(values.filter(Boolean));
}

function uniqueNumbers(values) {
  return [...new Set(values)];
}

function dedupeStrings(values) {
  return [...new Set(values)];
}

function summarizeScale(values, unit) {
  if (values.length === 0) {
    return "a restrained shared scale";
  }

  const slice = values.slice(0, 4).map((value) => `${formatNumber(value)}${unit}`);
  return slice.join(", ");
}

function formatNumberList(values, unit) {
  return values.length > 0 ? values.map((value) => `${formatNumber(value)}${unit}`).join(", ") : "";
}

function formatNumber(value) {
  return trimTrailingZeros(Number(value.toFixed(2)));
}

function trimTrailingZeros(value) {
  return Number(value.toFixed(3)).toString();
}

function truncateText(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function buildSafeFileStem(hostname) {
  return hostname
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
}

function sortColorStats(left, right) {
  return right.count - left.count;
}

function sortByUsage(key) {
  return (left, right) => right[key] - left[key] || right.count - left.count;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "Unknown error";
}

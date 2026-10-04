/**
 * Browser-environment detection.
 *
 * Headless browsers and automation frameworks leave characteristic gaps in
 * the JS environment even when they spoof headers. A real Chrome always has
 * chrome.runtime, chrome.app, chrome.csi, chrome.loadTimes, PDF plugins,
 * client hint brands, and non-trivial window chrome geometry. Automation
 * usually has none.
 *
 * These signals are client-claimed (spoofable with enough effort) and are
 * therefore used only as one input among several. They are, however, extremely
 * effective against default Selenium, Puppeteer, and headless Chrome.
 */

export interface EnvSignals {
  hasChrome: boolean;
  hasChromeRuntime: boolean;
  hasChromeApp: boolean;
  hasChromeCsi: boolean;
  hasChromeLoadTimes: boolean;
  pluginCount: number;
  mimeTypeCount: number;
  uaBrandCount: number;
  hasPermissionsApi: boolean;
  notificationPermission: string;
  outerW: number;
  outerH: number;
  innerW: number;
  innerH: number;
  screenW: number;
  screenH: number;
  availW: number;
  availH: number;
  prefersDark: boolean | null;
  prefersReducedMotion: boolean | null;
  hasTouch: boolean;
  hasPointer: boolean;
  hasWebdriver: boolean;
  hasLocks: boolean;
  hasStorage: boolean;
  hasConnection: boolean;
  hardwareConcurrency: number;
  deviceMemory: number;
  languageCount: number;
  glVendor?: string;
  glRenderer?: string;
}

export interface EnvVerdict {
  score: number;
  reasons: string[];
  isLikelyHeadless: boolean;
  headlessMarkerCount: number;
}

export function scoreEnvSignals(env: EnvSignals | undefined): EnvVerdict {
  if (!env || typeof env !== 'object') {
    // No env data at all — the widget didn't send it. Not a signal by itself,
    // because older widget versions or clipped payloads would also hit this.
    return { score: 1.0, reasons: [], isLikelyHeadless: false, headlessMarkerCount: 0 };
  }

  let score = 1.0;
  const reasons: string[] = [];
  let headlessScore = 0;

  // --- Chrome API surface ---------------------------------------------------
  // Only check Chrome-specific globals when the browser *claims* to be Chrome.
  // Firefox / Safari don't have chrome.runtime and that's correct.
  const claimsChrome = env.hasChrome === true;

  if (claimsChrome) {
    if (!env.hasChromeRuntime)   { headlessScore++; reasons.push('chrome-no-runtime'); }
    if (!env.hasChromeApp)       { headlessScore++; reasons.push('chrome-no-app'); }
    if (!env.hasChromeCsi)       { headlessScore++; reasons.push('chrome-no-csi'); }
    if (!env.hasChromeLoadTimes) { headlessScore++; reasons.push('chrome-no-loadtimes'); }
  }

  // --- Plugin / mimetype surface -------------------------------------------
  // Real Chrome ships 5 plugins (PDF-related) and 2 mimetypes. Headless: 0.
  if (env.pluginCount === 0 && env.mimeTypeCount === 0 && !env.hasTouch) {
    headlessScore++; reasons.push('zero-plugins-desktop');
  }

  // --- Chrome client hints brands ------------------------------------------
  // Chrome 90+ always exposes 2-3 brands in userAgentData.
  if (claimsChrome && env.uaBrandCount === 0) {
    headlessScore++; reasons.push('no-ua-brands');
  }

  // --- Permission API availability -----------------------------------------
  if (!env.hasPermissionsApi) {
    score -= 0.1; reasons.push('no-permissions-api');
  }

  // --- Window vs screen geometry -------------------------------------------
  // On desktop, outer !== inner (window chrome) and avail !== screen (taskbar).
  // Headless typically reports them equal.
  const innerEqOuter = env.innerW > 0 && env.innerH > 0
    && env.innerW === env.outerW && env.innerH === env.outerH;
  const availEqScreen = env.screenW > 0 && env.screenH > 0
    && env.availW === env.screenW && env.availH === env.screenH;

  if (innerEqOuter && !env.hasTouch) {
    score -= 0.15; reasons.push('inner-equals-outer-desktop');
  }
  if (availEqScreen && !env.hasTouch && env.screenW < 3000) {
    // Desktops usually have a taskbar; mobile often does not. The < 3000 guard
    // excludes phones from this check.
    score -= 0.1; reasons.push('avail-equals-screen-desktop');
  }

  // --- WebGL renderer string -----------------------------------------------
  const renderer = (env.glRenderer || '').toLowerCase();
  const vendor = (env.glVendor || '').toLowerCase();

  if (/swiftshader|llvmpipe|software|basic render/.test(renderer)) {
    headlessScore++; reasons.push('software-webgl');
  }
  if (/google inc/.test(vendor) && /swiftshader/.test(renderer)) {
    headlessScore++; reasons.push('swiftshader');
  }

  // --- Hard reject: webdriver flag -----------------------------------------
  if (env.hasWebdriver) {
    return {
      score: 0,
      reasons: ['webdriver-flag'],
      isLikelyHeadless: true,
      headlessMarkerCount: 99,
    };
  }

  // --- Aggregate verdict ---------------------------------------------------
  const isLikelyHeadless = headlessScore >= 2;

  if (isLikelyHeadless) {
    score = Math.min(score, 0.2);
  } else if (headlessScore === 1) {
    score = Math.min(score, 0.6);
  }

  if (score < 0) score = 0;
  return { score, reasons, isLikelyHeadless, headlessMarkerCount: headlessScore };
}

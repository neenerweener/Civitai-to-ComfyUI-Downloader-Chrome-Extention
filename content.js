(() => {
  'use strict';

  const MODEL_URL_REGEX = /^\/models\/(\d+)/i;

  let currentModelId = null;
  let currentVersionId = null;
  let latestModelData = null;
  let latestActiveVersion = null;
  let cachedModels = new Map(); // modelId -> API response
  let lastUrl = location.href;
  let widgetContainer = null;
  let isChecking = false;

  // Map Civitai API types to readable labels and colors
  const TYPE_BADGE_COLORS = {
    'Checkpoint': '#228be6',
    'LORA': '#be4bdb',
    'LoCon': '#9c36b5',
    'DoRA': '#ae3ec9',
    'TextualInversion': '#12b886',
    'VAE': '#fd7e14',
    'Controlnet': '#15aabf',
    'Upscaler': '#fab005',
    'Hypernetwork': '#e64980'
  };

  const DEFAULT_FOLDER_MAP = {
    'Checkpoint': 'checkpoints',
    'LORA': 'loras',
    'LoCon': 'loras',
    'DoRA': 'loras',
    'TextualInversion': 'embeddings',
    'VAE': 'vae',
    'Controlnet': 'controlnet',
    'Upscaler': 'upscale_models',
    'Hypernetwork': 'hypernetworks',
    'AestheticGradient': 'embeddings',
    'Poses': 'controlnet',
    'MotionModule': 'diffusion_models',
    'Workflows': 'workflows',
    'Other': 'other'
  };

  function parsePageUrl() {
    const match = location.pathname.match(MODEL_URL_REGEX);
    if (!match) return null;
    const modelId = match[1];
    const params = new URLSearchParams(location.search);
    const versionId = params.get('modelVersionId');
    return { modelId, versionId };
  }

  // Fallback: Scrape DOM if API fails or is rate-limited
  function scrapeModelFromDOM(modelId, requestedVersionId) {
    let detectedType = 'Other';
    const knownTypes = [
      { label: 'Checkpoint', type: 'Checkpoint' },
      { label: 'LoRA', type: 'LORA' },
      { label: 'LyCORIS', type: 'LoCon' },
      { label: 'LoCon', type: 'LoCon' },
      { label: 'DoRA', type: 'DoRA' },
      { label: 'Embedding', type: 'TextualInversion' },
      { label: 'Textual Inversion', type: 'TextualInversion' },
      { label: 'VAE', type: 'VAE' },
      { label: 'ControlNet', type: 'Controlnet' },
      { label: 'Upscaler', type: 'Upscaler' },
      { label: 'Hypernetwork', type: 'Hypernetwork' }
    ];

    const allCells = Array.from(document.querySelectorAll('td, th, .mantine-Badge-root, [class*="Badge"]'));
    for (const el of allCells) {
      const text = (el.textContent || '').trim();
      for (const kt of knownTypes) {
        if (text.toLowerCase() === kt.label.toLowerCase()) {
          detectedType = kt.type;
          break;
        }
      }
      if (detectedType !== 'Other') break;
    }

    const dlLink = document.querySelector('a[href*="/api/download/models/"]');
    let versionId = requestedVersionId;
    let downloadUrl = null;
    if (dlLink) {
      downloadUrl = dlLink.href;
      const m = downloadUrl.match(/\/api\/download\/models\/(\d+)/);
      if (m && !versionId) versionId = m[1];
    }

    const titleEl = document.querySelector('h1');
    const modelName = titleEl ? titleEl.textContent.trim() : `Model ${modelId}`;

    // Check if filename is displayed in the native download card
    let scrapedFilename = `${modelName.replace(/[^a-z0-9_-]/gi, '_')}.safetensors`;
    const pageTextNodes = Array.from(document.querySelectorAll('span, div, p'));
    for (const node of pageTextNodes) {
      if (node.children.length === 0) {
        const txt = (node.textContent || '').trim();
        if (/^[^\s/\\]+\.(safetensors|ckpt|pt|pth|bin|gguf|zip)$/i.test(txt)) {
          scrapedFilename = txt;
          break;
        }
      }
    }

    return {
      id: Number(modelId),
      name: modelName,
      type: detectedType,
      modelVersions: versionId ? [{
        id: Number(versionId),
        name: 'Selected Version',
        downloadUrl: downloadUrl || `${location.origin}/api/download/models/${versionId}`,
        files: [{
          name: scrapedFilename,
          type: 'Model',
          primary: true,
          downloadUrl: downloadUrl || `${location.origin}/api/download/models/${versionId}`
        }]
      }] : []
    };
  }

  async function getModelData(modelId, versionId) {
    if (cachedModels.has(modelId)) {
      return cachedModels.get(modelId);
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'FETCH_MODEL_INFO',
        origin: location.origin,
        modelId
      });
      if (response && response.ok && response.data) {
        cachedModels.set(modelId, response.data);
        return response.data;
      }
    } catch (err) {
      console.warn('[Civitai->ComfyUI] Background API fetch failed, trying direct fetch:', err);
    }

    try {
      const res = await fetch(`${location.origin}/api/v1/models/${modelId}`);
      if (res.ok) {
        const data = await res.json();
        cachedModels.set(modelId, data);
        return data;
      }
    } catch (_) {}

    return scrapeModelFromDOM(modelId, versionId);
  }

  function selectActiveVersion(modelData, versionId) {
    const versions = modelData?.modelVersions || [];
    if (!versions.length) return null;

    if (versionId) {
      const found = versions.find(v => String(v.id) === String(versionId));
      if (found) return found;
    }

    // Check if a download link in DOM indicates the currently selected version
    const dlLink = document.querySelector('a[href*="/api/download/models/"]');
    if (dlLink) {
      const m = dlLink.href.match(/\/api\/download\/models\/(\d+)/);
      if (m) {
        const foundFromDom = versions.find(v => String(v.id) === String(m[1]));
        if (foundFromDom) return foundFromDom;
      }
    }

    return versions[0];
  }

  function formatBytes(kb) {
    if (!kb) return '';
    const mb = kb / 1024;
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(2)} GB`;
    }
    return `${mb.toFixed(1)} MB`;
  }

  async function getSettings() {
    const stored = await chrome.storage.sync.get({
      downloadSubfolderPrefix: 'ComfyUI-Shared/models',
      folderMapping: DEFAULT_FOLDER_MAP
    });
    const mapping = { ...DEFAULT_FOLDER_MAP, ...(stored.folderMapping || {}) };
    const prefix = (stored.downloadSubfolderPrefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return { prefix, mapping };
  }

  async function resolveFolderLabel(modelType) {
    const { prefix, mapping } = await getSettings();
    const sub = mapping[modelType] || mapping['Other'] || 'other';
    return {
      shortFolder: sub,
      fullFolder: prefix ? `${prefix}/${sub}` : sub
    };
  }

  function removeWidget() {
    if (widgetContainer && widgetContainer.parentNode) {
      widgetContainer.parentNode.removeChild(widgetContainer);
    }
    widgetContainer = null;
    document.querySelectorAll('.ccd-inline-wrapper').forEach(el => el.remove());
  }

  // Find the currently selected file on the page (matches filename displayed in Civitai's Download box if multiple variants exist)
  function getActiveFileFromPage(activeVersion, modelData) {
    const files = activeVersion?.files || [];
    const fallbackFile = files.find(f => f.primary) || files[0] || {
      name: `${modelData?.name || 'model'}.safetensors`,
      downloadUrl: activeVersion?.downloadUrl || `${location.origin}/api/download/models/${activeVersion?.id}`,
      type: 'Model'
    };

    if (files.length <= 1) return fallbackFile;

    // Check if the DOM currently displays one of the variant filenames (e.g. "FurryToonMix-V3B.safetensors")
    const bodyText = document.body.innerText || '';
    for (const f of files) {
      if (f.name && bodyText.includes(f.name)) {
        return f;
      }
    }
    return fallbackFile;
  }

  // Trigger download via background worker and update button UI state
  async function triggerModelDownload({ buttonEl, labelEl, defaultLabelText, downloadUrl, filename, modelType, versionId, modelId }) {
    if (!buttonEl || buttonEl.disabled) return;
    buttonEl.disabled = true;
    buttonEl.classList.add('ccd-loading');
    if (labelEl) labelEl.textContent = 'Starting download...';

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_MODEL',
        payload: {
          downloadUrl,
          filename,
          modelType,
          versionId,
          modelId
        }
      });

      if (res && res.ok) {
        buttonEl.classList.remove('ccd-loading');
        buttonEl.classList.add('ccd-success');
        if (labelEl) labelEl.textContent = `Saved to ${res.targetSubfolder}!`;
        setTimeout(() => {
          if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.classList.remove('ccd-success');
            if (labelEl) labelEl.textContent = defaultLabelText;
          }
        }, 3500);
      } else {
        throw new Error(res?.error || 'Download failed');
      }
    } catch (err) {
      buttonEl.disabled = false;
      buttonEl.classList.remove('ccd-loading');
      buttonEl.classList.add('ccd-error');
      if (labelEl) labelEl.textContent = `Error: ${err.message}`;
    }
  }

  // Find Civitai's native "Download (...)" button(s) inside the Download card and inject our secondary button right below it
  function findNativeDownloadButtons() {
    const results = [];

    // 1. Direct download anchor links (e.g. <a href=".../api/download/models/...">)
    const anchors = document.querySelectorAll('a[href*="/api/download/models/"]');
    anchors.forEach(a => results.push(a));

    // 2. Buttons or role="button" elements inside the Download section whose text matches "Download (6.62 GB)" or "Download"
    const candidates = document.querySelectorAll('button, a[role="button"], .mantine-Button-root, .mantine-UnstyledButton-root');
    candidates.forEach(el => {
      if (results.includes(el)) return;
      if (el.classList.contains('ccd-inline-btn') || el.id === 'ccd-download-btn') return;

      const text = (el.textContent || '').trim();
      // Match "Download (6.62 GB)" or standalone "Download" button in the sidebar card
      if (/^Download(\s*\([\d.]+\s*(KB|MB|GB|TB)\))?$/i.test(text)) {
        results.push(el);
      }
    });

    return results;
  }

  async function injectInlineButtons(modelData, activeVersion) {
    if (!modelData || !activeVersion) return;

    const nativeButtons = findNativeDownloadButtons();
    if (!nativeButtons.length) return;

    const chosenFile = getActiveFileFromPage(activeVersion, modelData);
    const effectiveType = resolveFileSpecificType(modelData.type || 'Other', chosenFile);
    const { shortFolder, fullFolder } = await resolveFolderLabel(effectiveType);
    const sizeSuffix = chosenFile.sizeKB ? ` (${formatBytes(chosenFile.sizeKB)})` : '';
    const defaultLabelText = `Download to ComfyUI / ${shortFolder}${sizeSuffix}`;
    const downloadUrl = chosenFile.downloadUrl || activeVersion.downloadUrl || `${location.origin}/api/download/models/${activeVersion.id}`;

    for (const nativeBtn of nativeButtons) {
      // Avoid injecting inside miniature gallery cards or headers if any
      const rect = nativeBtn.getBoundingClientRect();
      if (rect.width > 0 && rect.width < 110) continue;

      const parent = nativeBtn.parentElement;
      if (!parent) continue;

      // Check if we already injected a sibling wrapper right after this button
      let wrapper = parent.querySelector(':scope > .ccd-inline-wrapper');
      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'ccd-inline-wrapper';
        nativeBtn.insertAdjacentElement('afterend', wrapper);
      }

      // Skip re-rendering if nothing changed and button isn't in a loading state
      const existingKey = `${activeVersion.id}_${chosenFile.name}_${fullFolder}`;
      if (wrapper.dataset.renderKey === existingKey) {
        continue;
      }
      wrapper.dataset.renderKey = existingKey;

      wrapper.innerHTML = `
        <button type="button" class="ccd-inline-btn" title="Auto-sorts ${escapeHtml(chosenFile.name)} into ${escapeHtml(fullFolder)}/">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            <line x1="12" y1="11" x2="12" y2="17"></line>
            <polyline points="9 14 12 17 15 14"></polyline>
          </svg>
          <span class="ccd-inline-label">${escapeHtml(defaultLabelText)}</span>
        </button>
        <div class="ccd-inline-subtext">
          <span>Type: <strong>${escapeHtml(effectiveType)}</strong></span>
          <span>&rarr; <code>${escapeHtml(fullFolder)}/</code></span>
        </div>
      `;

      const inlineBtn = wrapper.querySelector('.ccd-inline-btn');
      const inlineLabel = wrapper.querySelector('.ccd-inline-label');

      inlineBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerModelDownload({
          buttonEl: inlineBtn,
          labelEl: inlineLabel,
          defaultLabelText,
          downloadUrl,
          filename: chosenFile.name,
          modelType: effectiveType,
          versionId: activeVersion.id,
          modelId: modelData.id
        });
      });
    }
  }

  async function renderWidget(modelData, activeVersion) {
    if (!modelData || !activeVersion) {
      removeWidget();
      return;
    }

    const modelType = modelData.type || 'Other';
    const { shortFolder, fullFolder } = await resolveFolderLabel(modelType);
    const files = activeVersion.files || [];
    const primaryFile = getActiveFileFromPage(activeVersion, modelData);

    // Register with background script so even clicking Civitai's native download button routes properly
    chrome.runtime.sendMessage({
      action: 'REGISTER_CONTEXT_METADATA',
      payload: {
        versionId: activeVersion.id,
        modelId: modelData.id,
        modelType,
        filename: primaryFile.name
      }
    }).catch(() => {});

    // 1. Inject the inline secondary button directly inside Civitai's Download box
    await injectInlineButtons(modelData, activeVersion);

    // 2. Also maintain the floating quick-widget in the corner
    if (!widgetContainer) {
      widgetContainer = document.createElement('div');
      widgetContainer.id = 'civitai-comfy-downloader-bar';
      document.body.appendChild(widgetContainer);
    }

    const badgeColor = TYPE_BADGE_COLORS[modelType] || '#495057';
    const baseModel = activeVersion.baseModel ? `<span class="ccd-base-tag">${escapeHtml(activeVersion.baseModel)}</span>` : '';
    const sizeText = primaryFile.sizeKB ? `<span class="ccd-size">${formatBytes(primaryFile.sizeKB)}</span>` : '';

    let fileOptionsHtml = '';
    if (files.length > 1) {
      fileOptionsHtml = `
        <select class="ccd-file-select" id="ccd-file-select" title="Choose file to download">
          ${files.map((f, idx) => `
            <option value="${idx}" ${f === primaryFile ? 'selected' : ''}>
              ${escapeHtml(f.name)} (${f.type || 'Model'}${f.sizeKB ? ' - ' + formatBytes(f.sizeKB) : ''})
            </option>
          `).join('')}
        </select>
      `;
    }

    widgetContainer.innerHTML = `
      <div class="ccd-card">
        <div class="ccd-header">
          <div class="ccd-badges">
            <span class="ccd-type-badge" style="background:${badgeColor}">${escapeHtml(modelType)}</span>
            ${baseModel}
            ${sizeText}
          </div>
          <button class="ccd-minimize-btn" id="ccd-minimize-btn" title="Minimize / Expand">_</button>
        </div>

        <div class="ccd-body" id="ccd-body">
          <div class="ccd-title" title="${escapeHtml(modelData.name)} - ${escapeHtml(activeVersion.name)}">
            <strong>${escapeHtml(modelData.name)}</strong>
            <span class="ccd-version-name">${escapeHtml(activeVersion.name)}</span>
          </div>

          <div class="ccd-target-folder" title="Target folder inside Chrome Downloads">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            <span id="ccd-folder-path">${escapeHtml(fullFolder)}/</span>
          </div>

          ${fileOptionsHtml}

          <button class="ccd-download-btn" id="ccd-download-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span id="ccd-btn-label">Download to ${escapeHtml(shortFolder)}</span>
          </button>
        </div>
      </div>
    `;

    const downloadBtn = widgetContainer.querySelector('#ccd-download-btn');
    const btnLabel = widgetContainer.querySelector('#ccd-btn-label');
    const fileSelect = widgetContainer.querySelector('#ccd-file-select');
    const minBtn = widgetContainer.querySelector('#ccd-minimize-btn');
    const bodyEl = widgetContainer.querySelector('#ccd-body');

    minBtn.addEventListener('click', () => {
      bodyEl.classList.toggle('ccd-collapsed');
      minBtn.textContent = bodyEl.classList.contains('ccd-collapsed') ? '+' : '_';
    });

    if (fileSelect) {
      fileSelect.addEventListener('change', async () => {
        const chosen = files[Number(fileSelect.value)] || primaryFile;
        const effectiveType = resolveFileSpecificType(modelType, chosen);
        const updated = await resolveFolderLabel(effectiveType);
        const pathSpan = widgetContainer.querySelector('#ccd-folder-path');
        if (pathSpan) pathSpan.textContent = `${updated.fullFolder}/`;
        btnLabel.textContent = `Download to ${updated.shortFolder}`;
      });
    }

    downloadBtn.addEventListener('click', async () => {
      const chosenFile = (fileSelect && files[Number(fileSelect.value)]) ? files[Number(fileSelect.value)] : primaryFile;
      const effectiveType = resolveFileSpecificType(modelType, chosenFile);
      const updated = await resolveFolderLabel(effectiveType);
      const downloadUrl = chosenFile.downloadUrl || activeVersion.downloadUrl || `${location.origin}/api/download/models/${activeVersion.id}`;

      triggerModelDownload({
        buttonEl: downloadBtn,
        labelEl: btnLabel,
        defaultLabelText: `Download to ${updated.shortFolder}`,
        downloadUrl,
        filename: chosenFile.name,
        modelType: effectiveType,
        versionId: activeVersion.id,
        modelId: modelData.id
      });
    });
  }

  // If a Checkpoint version bundles a separate VAE file, route that VAE file to 'VAE' if selected
  function resolveFileSpecificType(modelType, fileObj) {
    if (!fileObj || !fileObj.type) return modelType;
    const ft = fileObj.type.toLowerCase();
    if (ft === 'vae') return 'VAE';
    if (ft === 'negative' || ft.includes('textual')) return 'TextualInversion';
    return modelType;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function checkAndInject() {
    if (isChecking) return;
    isChecking = true;
    try {
      const parsed = parsePageUrl();
      if (!parsed) {
        currentModelId = null;
        currentVersionId = null;
        latestModelData = null;
        latestActiveVersion = null;
        removeWidget();
        return;
      }

      const { modelId, versionId } = parsed;
      const modelData = await getModelData(modelId, versionId);
      const activeVersion = selectActiveVersion(modelData, versionId);

      currentModelId = modelId;
      currentVersionId = activeVersion?.id ? String(activeVersion.id) : versionId;
      latestModelData = modelData;
      latestActiveVersion = activeVersion;

      await renderWidget(modelData, activeVersion);
    } finally {
      isChecking = false;
    }
  }

  // Watch for SPA URL navigation and delayed React rendering of the Download card
  let domDebounceTimer = null;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      checkAndInject();
      return;
    }

    // If we are on a model page and the native download card just rendered (or re-rendered on variant change), inject our inline button
    if (latestModelData && latestActiveVersion && !document.querySelector('.ccd-inline-wrapper')) {
      clearTimeout(domDebounceTimer);
      domDebounceTimer = setTimeout(() => {
        injectInlineButtons(latestModelData, latestActiveVersion);
      }, 200);
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Also listen for clicks on version/variant switcher buttons
  document.addEventListener('click', (e) => {
    if (!parsePageUrl()) return;
    const btn = e.target.closest('button, a, [role="menuitem"], [role="option"]');
    if (btn && !btn.classList.contains('ccd-inline-btn') && btn.id !== 'ccd-download-btn') {
      setTimeout(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
        }
        checkAndInject();
      }, 400);
    }
  }, true);

  // Re-render if user updates folder settings in popup
  chrome.storage.onChanged.addListener(() => {
    if (currentModelId) {
      document.querySelectorAll('.ccd-inline-wrapper').forEach(el => delete el.dataset.renderKey);
      checkAndInject();
    }
  });

  // Initial check
  checkAndInject();
})();

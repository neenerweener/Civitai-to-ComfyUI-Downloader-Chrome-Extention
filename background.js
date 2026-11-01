// Default configuration matching ComfyUI's folder layout
const DEFAULT_CONFIG = {
  rootFolderPath: 'E:\\Comfy-Desktop\\ComfyUI-Shared',
  downloadSubfolderPrefix: 'ComfyUI-Shared/models',
  interceptNativeDownloads: true,
  apiKey: '',
  folderMapping: {
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
  }
};

// Track active downloads initiated or recognized by the extension
// Key: downloadUrl or modelVersionId, Value: { targetSubfolder, preferredFilename, modelType }
const pendingDownloads = new Map();
const downloadIdMap = new Map();

// Initialize defaults on install
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(null);
  const merged = {
    ...DEFAULT_CONFIG,
    ...stored,
    folderMapping: {
      ...DEFAULT_CONFIG.folderMapping,
      ...(stored.folderMapping || {})
    }
  };
  await chrome.storage.sync.set(merged);
});

// Sanitize path segments for Chrome downloads API (must be relative, forward-slashed, no '..' or drive letters)
function sanitizeRelativePath(pathStr) {
  if (!pathStr) return '';
  let clean = pathStr
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:\/+/, '') // strip drive letters like E:/
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  return clean
    .split('/')
    .map(part => part.replace(/[<>:"|?*]/g, '_').trim())
    .filter(part => part && part !== '.' && part !== '..')
    .join('/');
}

function sanitizeFilename(name) {
  if (!name) return 'model.safetensors';
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

// Resolve ComfyUI subfolder from Civitai model type
async function getTargetSubfolder(modelType) {
  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
  const mapping = { ...DEFAULT_CONFIG.folderMapping, ...(config.folderMapping || {}) };

  // Case-insensitive lookup
  const normalizedType = (modelType || 'Other').trim();
  let mappedFolder = mapping[normalizedType];

  if (!mappedFolder) {
    const lower = normalizedType.toLowerCase();
    for (const [key, val] of Object.entries(mapping)) {
      if (key.toLowerCase() === lower) {
        mappedFolder = val;
        break;
      }
    }
  }

  if (!mappedFolder) {
    // Common aliases
    const lower = normalizedType.toLowerCase();
    if (lower.includes('checkpoint') || lower.includes('ckpt')) mappedFolder = mapping['Checkpoint'] || 'checkpoints';
    else if (lower.includes('lora') || lower.includes('locon') || lower.includes('lycoris') || lower.includes('dora')) mappedFolder = mapping['LORA'] || 'loras';
    else if (lower.includes('embed') || lower.includes('textual') || lower.includes('ti')) mappedFolder = mapping['TextualInversion'] || 'embeddings';
    else if (lower.includes('vae')) mappedFolder = mapping['VAE'] || 'vae';
    else if (lower.includes('control')) mappedFolder = mapping['Controlnet'] || 'controlnet';
    else if (lower.includes('upscal') || lower.includes('esrgan')) mappedFolder = mapping['Upscaler'] || 'upscale_models';
    else if (lower.includes('unet') || lower.includes('diffusion')) mappedFolder = 'diffusion_models';
    else mappedFolder = mapping['Other'] || 'other';
  }

  const prefix = sanitizeRelativePath(config.downloadSubfolderPrefix);
  const sub = sanitizeRelativePath(mappedFolder);
  return [prefix, sub].filter(Boolean).join('/');
}

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'DOWNLOAD_MODEL') {
    handleDownloadRequest(message.payload)
      .then(res => sendResponse({ ok: true, ...res }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // async response
  }

  if (message.action === 'REGISTER_CONTEXT_METADATA') {
    // Content script notifies background of the active page's model metadata
    // so even clicking Civitai's native download button routes to the right folder
    if (message.payload && message.payload.versionId) {
      pendingDownloads.set(String(message.payload.versionId), {
        ...message.payload,
        timestamp: Date.now()
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'FETCH_MODEL_INFO') {
    fetchModelInfoFromApi(message.origin, message.modelId)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});

async function fetchModelInfoFromApi(origin, modelId) {
  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
  const baseUrl = origin || 'https://civitai.com';
  const headers = { 'Accept': 'application/json' };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
  }
  const resp = await fetch(`${baseUrl}/api/v1/models/${modelId}`, {
    headers,
    credentials: 'include'
  });
  if (!resp.ok) {
    throw new Error(`API returned status ${resp.status}`);
  }
  return await resp.json();
}

async function handleDownloadRequest(payload) {
  const {
    downloadUrl,
    filename,
    modelType,
    versionId
  } = payload;

  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
  const targetSubfolder = await getTargetSubfolder(modelType);

  let finalUrl = downloadUrl;
  if (config.apiKey && finalUrl.includes('/api/download/')) {
    try {
      const u = new URL(finalUrl);
      if (!u.searchParams.has('token')) {
        u.searchParams.set('token', config.apiKey.trim());
        finalUrl = u.toString();
      }
    } catch (_) {}
  }

  const meta = {
    targetSubfolder,
    preferredFilename: filename ? sanitizeFilename(filename) : null,
    modelType,
    versionId: versionId ? String(versionId) : null,
    timestamp: Date.now()
  };

  if (versionId) {
    pendingDownloads.set(String(versionId), meta);
  }
  pendingDownloads.set(finalUrl, meta);

  const downloadOptions = {
    url: finalUrl,
    conflictAction: 'uniquify',
    saveAs: false
  };

  // Start the download; onDeterminingFilename will finalize the exact subfolder + server filename
  return new Promise((resolve, reject) => {
    chrome.downloads.download(downloadOptions, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        reject(new Error(chrome.runtime.lastError?.message || 'Failed to initiate download'));
        return;
      }
      downloadIdMap.set(downloadId, meta);
      resolve({ downloadId, targetSubfolder });
    });
  });
}

// Intercept filename determination to place the file into the sorted ComfyUI subfolder
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  handleDeterminingFilename(item, suggest);
  return true; // Indicates we will call suggest() asynchronously
});

async function handleDeterminingFilename(item, suggest) {
  try {
    // 1. Check if this download was directly triggered by our button
    let meta = downloadIdMap.get(item.id) || pendingDownloads.get(item.url);

    // 2. Check if URL contains a Civitai modelVersionId we know about
    if (!meta) {
      const versionMatch = (item.url || '').match(/\/api\/download\/models\/(\d+)/i) ||
                           (item.referrer || '').match(/modelVersionId=(\d+)/i);
      if (versionMatch && pendingDownloads.has(versionMatch[1])) {
        const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
        if (config.interceptNativeDownloads) {
          const pageMeta = pendingDownloads.get(versionMatch[1]);
          const targetSubfolder = await getTargetSubfolder(pageMeta.modelType);
          meta = {
            targetSubfolder,
            preferredFilename: pageMeta.filename ? sanitizeFilename(pageMeta.filename) : null,
            modelType: pageMeta.modelType
          };
        }
      }
    }

    if (!meta) {
      suggest(); // Let Chrome handle non-Civitai downloads normally
      return;
    }

    // Use the server-provided filename if valid, or fall back to preferredFilename from API
    const serverFilename = sanitizeFilename(item.filename);
    const chosenFilename = (serverFilename && !serverFilename.startsWith('download'))
      ? serverFilename
      : (meta.preferredFilename || serverFilename || 'model.safetensors');

    const fullRelativePath = meta.targetSubfolder
      ? `${meta.targetSubfolder}/${chosenFilename}`
      : chosenFilename;

    suggest({
      filename: fullRelativePath,
      conflictAction: 'uniquify'
    });

    // Cleanup map entry
    downloadIdMap.delete(item.id);
  } catch (err) {
    console.error('[Civitai->ComfyUI] Error in onDeterminingFilename:', err);
    suggest();
  }
}

const DEFAULT_FOLDER_MAPPING = {
  'Checkpoint': 'checkpoints',
  'LORA': 'loras',
  'LoCon': 'loras',
  'DoRA': 'loras',
  'TextualInversion': 'embeddings',
  'VAE': 'vae',
  'Controlnet': 'controlnet',
  'Upscaler': 'upscale_models',
  'Hypernetwork': 'hypernetworks',
  'MotionModule': 'diffusion_models',
  'Poses': 'controlnet',
  'Other': 'other'
};

const DEFAULT_CONFIG = {
  rootFolderPath: 'E:\\Comfy-Desktop\\ComfyUI-Shared',
  downloadSubfolderPrefix: 'ComfyUI-Shared/models',
  interceptNativeDownloads: true,
  apiKey: '',
  folderMapping: DEFAULT_FOLDER_MAPPING
};

const rootFolderPathInput = document.getElementById('rootFolderPath');
const prefixInput = document.getElementById('downloadSubfolderPrefix');
const previewPathEl = document.getElementById('previewPath');
const interceptCheckbox = document.getElementById('interceptNativeDownloads');
const apiKeyInput = document.getElementById('apiKey');
const mappingGrid = document.getElementById('mappingGrid');
const saveBtn = document.getElementById('saveBtn');
const resetDefaultsBtn = document.getElementById('resetDefaultsBtn');
const statusMsg = document.getElementById('statusMsg');
const modeJunctionBtn = document.getElementById('modeJunctionBtn');
const modeDirectBtn = document.getElementById('modeDirectBtn');

function updatePreview() {
  const prefix = (prefixInput.value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const loraInput = mappingGrid.querySelector('input[data-type="LORA"]');
  const loraFolder = loraInput ? loraInput.value.trim() : 'loras';
  previewPathEl.textContent = [prefix, loraFolder, 'model.safetensors'].filter(Boolean).join('/');
}

function renderMappingRows(mapping) {
  mappingGrid.innerHTML = '';
  for (const [typeKey, defaultFolder] of Object.entries(DEFAULT_FOLDER_MAPPING)) {
    const label = document.createElement('div');
    label.className = 'mapping-type';
    label.textContent = typeKey === 'TextualInversion' ? 'Embedding (TI)' : typeKey;

    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.type = typeKey;
    input.value = mapping[typeKey] ?? defaultFolder;
    input.addEventListener('input', updatePreview);

    mappingGrid.appendChild(label);
    mappingGrid.appendChild(input);
  }
  updatePreview();
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
  rootFolderPathInput.value = stored.rootFolderPath || DEFAULT_CONFIG.rootFolderPath;
  prefixInput.value = stored.downloadSubfolderPrefix ?? DEFAULT_CONFIG.downloadSubfolderPrefix;
  interceptCheckbox.checked = Boolean(stored.interceptNativeDownloads);
  apiKeyInput.value = stored.apiKey || '';

  const mergedMapping = {
    ...DEFAULT_FOLDER_MAPPING,
    ...(stored.folderMapping || {})
  };
  renderMappingRows(mergedMapping);
}

prefixInput.addEventListener('input', updatePreview);

modeJunctionBtn.addEventListener('click', () => {
  const rawRoot = (rootFolderPathInput.value || 'E:\\Comfy-Desktop\\ComfyUI-Shared').replace(/[\\/]+$/, '');
  const leafName = rawRoot.split(/[\\/]/).pop() || 'ComfyUI-Shared';
  prefixInput.value = `${leafName}/models`;
  updatePreview();
});

modeDirectBtn.addEventListener('click', () => {
  prefixInput.value = 'models';
  updatePreview();
});

resetDefaultsBtn.addEventListener('click', () => {
  rootFolderPathInput.value = DEFAULT_CONFIG.rootFolderPath;
  prefixInput.value = DEFAULT_CONFIG.downloadSubfolderPrefix;
  interceptCheckbox.checked = true;
  renderMappingRows(DEFAULT_FOLDER_MAPPING);
});

saveBtn.addEventListener('click', async () => {
  const newMapping = {};
  mappingGrid.querySelectorAll('input[data-type]').forEach(input => {
    newMapping[input.dataset.type] = input.value.trim() || DEFAULT_FOLDER_MAPPING[input.dataset.type];
  });

  await chrome.storage.sync.set({
    rootFolderPath: rootFolderPathInput.value.trim(),
    downloadSubfolderPrefix: prefixInput.value.trim(),
    interceptNativeDownloads: interceptCheckbox.checked,
    apiKey: apiKeyInput.value.trim(),
    folderMapping: newMapping
  });

  statusMsg.textContent = 'Saved!';
  setTimeout(() => {
    statusMsg.textContent = '';
  }, 2200);
});

loadSettings();

const { ipcRenderer } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── DOM refs ──
const selectBtn     = document.getElementById('selectBtn');
const upscaleBtn    = document.getElementById('upscaleBtn');
const cancelBtn     = document.getElementById('cancelBtn');
const outputBtn     = document.getElementById('outputBtn');
const outputPathEl  = document.getElementById('outputPath');
const openOutputBtn = document.getElementById('openOutputBtn');
const dropZone      = document.getElementById('dropZone');
const hwStatus      = document.getElementById('hwStatus');
const warningBanner = document.getElementById('warningBanner');
const progressFill  = document.getElementById('progressFill');
const progressText  = document.getElementById('progressText');
const progressInfo  = document.getElementById('progressInfo');
const statusEl      = document.getElementById('status');

const infoName     = document.getElementById('infoName');
const infoDuration = document.getElementById('infoDuration');
const infoRes      = document.getElementById('infoRes');
const infoSize     = document.getElementById('infoSize');

// ── Window controls ──
document.getElementById('winMinimize').addEventListener('click', () => ipcRenderer.send('win-minimize'));
document.getElementById('winMaximize').addEventListener('click', () => ipcRenderer.send('win-maximize'));
document.getElementById('winClose').addEventListener('click',    () => ipcRenderer.send('win-close'));

// ── Slider value display ──
document.getElementById('denoise').addEventListener('input', e => {
    document.getElementById('denoiseVal').textContent = parseFloat(e.target.value).toFixed(1);
});
document.getElementById('sharpen').addEventListener('input', e => {
    document.getElementById('sharpenVal').textContent = parseFloat(e.target.value).toFixed(1);
});
document.getElementById('quality').addEventListener('input', e => {
    document.getElementById('qualityVal').textContent = `${e.target.value} CRF`;
});
document.getElementById('outputFormat').addEventListener('change', resetOutputSelection);

// ── Hardware detection on load ──
const HW_LABELS = {
    nvidia: '● NVIDIA NVENC detected',
    intel:  '● Intel QSV detected',
    cpu:    '○ No GPU encoder found — CPU only',
};
ipcRenderer.invoke('detect-hardware').then(hw => {
    if (hwStatus) {
        hwStatus.textContent = HW_LABELS[hw] ?? '';
        hwStatus.style.color = hw === 'cpu' ? 'var(--text-hint)' : 'var(--success-text)';
    }
});

// ── File handling ──
let selectedFilePath = null;
let selectedOutputPath = null;
let sourceInfo = {};
let lastOutputPath = null;

const VALID_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return 'calculating ETA';
    if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
    return `${formatDuration(seconds)} remaining`;
}

function timemarkToSeconds(timemark) {
    const parts = String(timemark).split(':').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function targetResolution() {
    const [width, height] = document.getElementById('resolution').value.split(':').map(Number);
    return { width, height };
}

function validateTargetResolution() {
    if (!sourceInfo.width || !sourceInfo.height) return true;
    const target = targetResolution();
    if (target.width <= sourceInfo.width || target.height <= sourceInfo.height) {
        setStatus(`Choose a target above the source resolution (${sourceInfo.width} × ${sourceInfo.height}).`, 'error');
        return false;
    }
    return true;
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function resetOutputSelection() {
    selectedOutputPath = null;
    lastOutputPath = null;
    if (outputPathEl) outputPathEl.textContent = 'No output selected';
    if (openOutputBtn) openOutputBtn.disabled = true;
}

function populateFileInfo(filePath) {
    const filename  = path.basename(filePath);
    const stat      = fs.statSync(filePath);

    infoName.textContent  = filename;
    infoSize.textContent  = formatBytes(stat.size);
    infoName.classList.add('populated');
    infoSize.classList.add('populated');

    // Update drop zone appearance
    const dropPrimary = dropZone.querySelector('.drop-primary');
    const dropIcon    = dropZone.querySelector('.drop-icon svg');
    dropPrimary.textContent = filename;
    dropZone.classList.add('has-file');

    // Check mark icon when file is loaded
    dropIcon.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--success-text)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
    </svg>
`;

    // Probe duration and resolution via ffprobe
    ipcRenderer.invoke('probe-file', filePath).then(info => {
         sourceInfo = info;
        if (info.duration) {
            infoDuration.textContent = formatDuration(info.duration);
            infoDuration.classList.add('populated');
        }
        if (info.width && info.height) {
            infoRes.textContent = `${info.width} × ${info.height}`;
            infoRes.classList.add('populated');
        }
    }).catch(() => {
        infoDuration.textContent = 'Unknown';
        infoRes.textContent = 'Unknown';
    });
}

function handleFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!VALID_EXTS.includes(ext)) {
        setStatus(`Unsupported file type: ${ext}`, 'error');
        return;
    }
    selectedFilePath = filePath;
    sourceInfo = {};
    resetOutputSelection();
    setStatus('', '');
    populateFileInfo(filePath);
}

// Browse button
selectBtn.addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('select-file');
    if (result) handleFile(result);
});

// Drag and drop
dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', e => {
    if (!dropZone.contains(e.relatedTarget)) {
        dropZone.classList.remove('drag-over');
    }
});
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file.path);
});

// ── Codec fallback warning ──
ipcRenderer.on('upscale-warning', (event, message) => {
    if (warningBanner) {
        warningBanner.textContent = message;
        warningBanner.hidden = false;
    }
});

// ── Output and progress updates ──
outputBtn.addEventListener('click', async () => {
    if (!selectedFilePath) {
        setStatus('Select a video file first.', 'error');
        return;
    }
    const result = await ipcRenderer.invoke('select-output', {
        inputPath: selectedFilePath,
        outputFormat: document.getElementById('outputFormat').value,
    });
    if (result) {
        selectedOutputPath = result;
        outputPathEl.textContent = result;
        setStatus('', '');
    }
});

openOutputBtn.addEventListener('click', () => {
    if (lastOutputPath) ipcRenderer.invoke('open-output-folder', lastOutputPath);
});

cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    await ipcRenderer.invoke('cancel-upscale');
});
ipcRenderer.on('upscale-progress', (event, { percent, currentFps, timemark }) => {
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${percent}%`;
    if (timemark) {
          const elapsed = timemarkToSeconds(timemark);
        const duration = Number(sourceInfo.duration);
        const eta = duration && elapsed > 0 ? formatEta((duration - elapsed) / (elapsed / Math.max(1, Date.now() - processingStartedAt) * 1000)) : 'calculating ETA';
        progressInfo.textContent = `${currentFps} fps  ·  ${timemark}  ·  ${eta}`;
    } else {
        progressInfo.textContent = '';
    }
});

// ── Status helper ──
function setStatus(message, type = '') {
    statusEl.textContent = message;
    statusEl.className = 'status-message' + (type ? ` ${type}` : '');
}

let processingStartedAt = 0;

// ── Upscale ──
upscaleBtn.addEventListener('click', async () => {
    if (!selectedFilePath) {
        setStatus('Select a video file first.', 'error');
        return;
    }

     if (!validateTargetResolution()) return;

    progressFill.style.width = '0%';
    progressText.textContent = '0%';
    progressInfo.textContent = '';
    if (warningBanner) warningBanner.hidden = true;
    setStatus('', '');
    upscaleBtn.disabled = true;
    outputBtn.disabled = true;
    cancelBtn.disabled = false;
    openOutputBtn.disabled = true;
    processingStartedAt = Date.now();

    const accelerationMode = document.querySelector('input[name="accel"]:checked')?.value ?? 'auto';
    const codecPreference  = document.querySelector('input[name="codec"]:checked')?.value ?? 'h265';
     const audioMode        = document.querySelector('input[name="audio"]:checked')?.value ?? 'copy';

    try {
        const result = await ipcRenderer.invoke('upscale-video', {
            inputPath:       selectedFilePath,
            resolution:      document.getElementById('resolution').value,
            denoiseStrength: parseFloat(document.getElementById('denoise').value),
            sharpenStrength: parseFloat(document.getElementById('sharpen').value),
            accelerationMode,
            codecPreference,
              audioMode,
            outputFormat: document.getElementById('outputFormat').value,
            outputPath: selectedOutputPath,
            crf: parseInt(document.getElementById('quality').value, 10),
            sourceWidth: sourceInfo.width,
            sourceHeight: sourceInfo.height,
        });
          lastOutputPath = result.outputPath;
        selectedOutputPath = result.outputPath;
        outputPathEl.textContent = result.outputPath;
        openOutputBtn.disabled = false;
        setStatus(`Saved to: ${result.outputPath}`, 'success');
    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err}`, 'error');
    } finally {
        upscaleBtn.disabled = false;
         outputBtn.disabled = false;
        cancelBtn.disabled = true;
    }
});
const { ipcRenderer } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── DOM refs ──
const selectBtn     = document.getElementById('selectBtn');
const upscaleBtn    = document.getElementById('upscaleBtn');
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

const VALID_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
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

// ── Progress updates ──
ipcRenderer.on('upscale-progress', (event, { percent, currentFps, timemark }) => {
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${percent}%`;
    if (timemark) {
        progressInfo.textContent = `${currentFps} fps  ·  ${timemark}`;
    } else {
        progressInfo.textContent = '';
    }
});

// ── Status helper ──
function setStatus(message, type = '') {
    statusEl.textContent = message;
    statusEl.className = 'status-message' + (type ? ` ${type}` : '');
}

// ── Upscale ──
upscaleBtn.addEventListener('click', async () => {
    if (!selectedFilePath) {
        setStatus('Select a video file first.', 'error');
        return;
    }

    progressFill.style.width = '0%';
    progressText.textContent = '0%';
    progressInfo.textContent = '';
    if (warningBanner) warningBanner.hidden = true;
    setStatus('', '');
    upscaleBtn.disabled = true;

    const accelerationMode = document.querySelector('input[name="accel"]:checked')?.value ?? 'auto';
    const codecPreference  = document.querySelector('input[name="codec"]:checked')?.value ?? 'h265';

    try {
        const result = await ipcRenderer.invoke('upscale-video', {
            inputPath:       selectedFilePath,
            resolution:      document.getElementById('resolution').value,
            denoiseStrength: parseFloat(document.getElementById('denoise').value),
            sharpenStrength: parseFloat(document.getElementById('sharpen').value),
            accelerationMode,
            codecPreference,
        });
        setStatus(`Saved to: ${result.outputPath}`, 'success');
    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err}`, 'error');
    } finally {
        upscaleBtn.disabled = false;
    }
});
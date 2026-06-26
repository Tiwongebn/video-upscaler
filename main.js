const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const ffmpegPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'win', 'ffmpeg.exe')
    : ffmpegStatic;

const ffprobePath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'win', 'ffprobe.exe')
    : ffprobeInstaller.path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

let mainWindow;
let activeCommand = null;
let activeReject = null;

const FORMAT_EXTENSIONS = {
    mp4: '.mp4',
    mkv: '.mkv',
};

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 660,
        minWidth: 720,
        minHeight: 540,
        frame: false,          // we draw our own titlebar
        backgroundColor: '#0f0f0f',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });
    mainWindow.loadFile('index.html');
}

function getOutputExtension(inputPath, outputFormat = 'source') {
    if (outputFormat === 'source') return path.extname(inputPath) || '.mp4';
    return FORMAT_EXTENSIONS[outputFormat] ?? path.extname(inputPath) ?? '.mp4';
}

function defaultOutputPath(inputPath, outputFormat = 'source') {
    const parsed = path.parse(inputPath);
    return path.join(parsed.dir, `${parsed.name}_upscaled${getOutputExtension(inputPath, outputFormat)}`);
}

function incrementPath(filePath) {
    if (!fs.existsSync(filePath)) return filePath;
    const parsed = path.parse(filePath);
    let index = 1;
    let candidate;
    do {
        candidate = path.join(parsed.dir, `${parsed.name}_${index}${parsed.ext}`);
        index += 1;
    } while (fs.existsSync(candidate));
    return candidate;
}

function parseResolution(resolution) {
    const [width, height] = String(resolution).split(':').map(Number);
    return { width, height };
}

function isTargetHigher(sourceWidth, sourceHeight, resolution) {
    const target = parseResolution(resolution);
    return Number.isFinite(target.width) && Number.isFinite(target.height)
        && target.width > Number(sourceWidth)
        && target.height > Number(sourceHeight);
}

function sendCompletionNotification(outputPath) {
    if (!Notification.isSupported()) return;
    new Notification({
        title: 'Video upscale complete',
        body: `Saved to ${path.basename(outputPath)}`,
    }).show();
}


// ── Hardware detection ──
// Returns { type, hevcNvencAvailable, hevcQsvAvailable }
function detectHardwareAcceleration() {
    return new Promise((resolve) => {
        exec(`"${ffmpegPath}" -encoders`, (error, stdout) => {
            if (error) return resolve({ type: 'cpu', hevcQsvAvailable: false });

            if (stdout.includes('hevc_nvenc') || stdout.includes('h264_nvenc')) {
                return resolve({
                    type: 'nvidia',
                    hevcNvencAvailable: stdout.includes('hevc_nvenc'),
                    hevcQsvAvailable: false,
                });
            }
            if (stdout.includes('h264_qsv')) {
                return resolve({
                    type: 'intel',
                    hevcQsvAvailable: stdout.includes('hevc_qsv'),
                });
            }
            resolve({ type: 'cpu', hevcQsvAvailable: false });
        });
    });
}

// ── Filter chain builder ──
function buildFilterChain(resolution, denoiseStrength, sharpenStrength, hardwareType) {
    const [width, height] = resolution.split(':');
    const filters = [];

    if (hardwareType === 'nvidia') {
        filters.push(`scale_cuda=${width}:${height}:interp_algo=bicubic`);
        filters.push('hwdownload');
        filters.push('format=nv12');
        if (denoiseStrength > 0) {
            const l = denoiseStrength, c = l * 0.5, lt = l * 1.5, ct = c * 1.5;
            filters.push(`hqdn3d=${l}:${c}:${lt}:${ct}`);
        }
        if (sharpenStrength > 0) {
            filters.push(`unsharp=5:5:${sharpenStrength}:5:5:0`);
        }
    }
    else if (hardwareType === 'intel') {
        let qsvFilter = `vpp_qsv=w=${width}:h=${height}`;
        if (denoiseStrength > 0) {
            qsvFilter += `:denoise=${Math.min(Math.round(denoiseStrength * 10), 100)}`;
        }
        filters.push(qsvFilter);
        filters.push('hwdownload');
        filters.push('format=nv12');
        if (sharpenStrength > 0) {
            filters.push(`unsharp=5:5:${sharpenStrength}:5:5:0`);
        }
    }
    else {
        if (denoiseStrength > 0) {
            const l = denoiseStrength, c = l * 0.5, lt = l * 1.5, ct = c * 1.5;
            filters.push(`hqdn3d=${l}:${c}:${lt}:${ct}`);
        }
        filters.push(`scale=${width}:${height}:flags=lanczos+accurate_rnd`);
        if (sharpenStrength > 0) {
            filters.push(`unsharp=5:5:${sharpenStrength}:5:5:0`);
        }
    }

    return filters.join(',');
}

// ── IPC handlers ──

ipcMain.handle('select-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }]
    });
    return canceled ? null : filePaths[0];
});

ipcMain.handle('select-output', async (event, { inputPath, outputFormat }) => {
    const ext = getOutputExtension(inputPath, outputFormat).replace('.', '');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: incrementPath(defaultOutputPath(inputPath, outputFormat)),
        filters: [{ name: `${ext.toUpperCase()} video`, extensions: [ext] }]
    });
    return canceled ? null : filePath;
});


ipcMain.handle('detect-hardware', async () => {
    const hw = await detectHardwareAcceleration();
    return hw.type;
});

// Probe a file for duration and stream info using ffprobe.
// Returns { duration, width, height } — all optional if probe fails.
ipcMain.handle('probe-file', async (event, filePath) => {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return resolve({});
            const duration    = metadata.format?.duration ?? null;
            const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
            resolve({
                duration,
                width:  videoStream?.width  ?? null,
                height: videoStream?.height ?? null,
            });
        });
    });
});

ipcMain.handle('cancel-upscale', async () => {
    if (!activeCommand) return { canceled: false };
    activeCommand.kill('SIGTERM');
    if (activeReject) activeReject('Processing canceled.');
    activeCommand = null;
    activeReject = null;
    return { canceled: true };
});

ipcMain.handle('open-output-folder', async (event, outputPath) => {
    if (!outputPath) return;
    await shell.showItemInFolder(outputPath);
});


ipcMain.handle('upscale-video', async (event, {
    inputPath, resolution, denoiseStrength, sharpenStrength,
    accelerationMode, codecPreference, outputPath, audioMode,
    outputFormat, crf, sourceWidth, sourceHeight
}) => {
    return new Promise(async (resolve, reject) => {
         if (activeCommand) return reject('Another upscale is already running.');

        const finalOutputPath = outputPath || incrementPath(defaultOutputPath(inputPath, outputFormat));
        const outputDir = path.dirname(finalOutputPath);
        if (!fs.existsSync(outputDir)) return reject('The selected output folder does not exist.');
        if (fs.existsSync(finalOutputPath)) return reject('The output file already exists. Choose a different filename.');
        if (sourceWidth && sourceHeight && !isTargetHigher(sourceWidth, sourceHeight, resolution)) {
            return reject('Target resolution must be higher than the source resolution.');
        }

        activeReject = reject;

        // Resolve hardware profile
        let hw;
        if (accelerationMode === 'cpu') {
            hw = { type: 'cpu', hevcQsvAvailable: false };
            console.log('[FFmpeg] Mode: CPU (user forced)');
        } else if (accelerationMode === 'hardware') {
            hw = await detectHardwareAcceleration();
            if (hw.type === 'cpu') {
                  activeReject = null;
                return reject('Hardware acceleration was selected, but no compatible GPU encoder was detected. Switch to Auto or CPU.');
            }
            console.log(`[FFmpeg] Mode: Hardware (user forced) → detected: ${hw.type}`);
        } else {
            hw = await detectHardwareAcceleration();
            console.log(`[FFmpeg] Mode: Auto → detected: ${hw.type}`);
        }

        const useH265     = codecPreference === 'h265';
        const filterChain = buildFilterChain(resolution, denoiseStrength, sharpenStrength, hw.type);
        let command       = ffmpeg(inputPath);
        const quality = String(Number.isFinite(Number(crf)) ? Number(crf) : (useH265 ? 20 : 17));

        if (hw.type === 'nvidia') {
            const videoCodec = (useH265 && hw.hevcNvencAvailable) ? 'hevc_nvenc' : 'h264_nvenc';
            console.log(`[FFmpeg] NVIDIA codec: ${videoCodec}`);
            command
                .inputOptions('-hwaccel', 'cuda')
                .inputOptions('-hwaccel_output_format', 'cuda')
                .outputOptions('-vf', filterChain)
                .videoCodec(videoCodec)
                .outputOptions('-preset', 'p4')
                .outputOptions('-rc', 'vbr')
                .outputOptions('-cq', quality);
        }
        else if (hw.type === 'intel') {
            const videoCodec = (useH265 && hw.hevcQsvAvailable) ? 'hevc_qsv' : 'h264_qsv';
            if (useH265 && !hw.hevcQsvAvailable) {
                console.warn('[FFmpeg] hevc_qsv not available, falling back to h264_qsv');
                mainWindow.webContents.send('upscale-warning',
                    'H.265 is not supported by your Intel GPU encoder — using H.264 instead.');
            }
            console.log(`[FFmpeg] Intel codec: ${videoCodec}`);
            command
                .inputOptions('-hwaccel', 'qsv')
                .inputOptions('-hwaccel_output_format', 'qsv')
                .outputOptions('-vf', filterChain)
                .videoCodec(videoCodec)
                .outputOptions('-global_quality', quality)
                .outputOptions('-look_ahead', '1');
        }
        else {
            const videoCodec = useH265 ? 'libx265' : 'libx264';
            console.log(`[FFmpeg] CPU codec: ${videoCodec}`);
            command
                .outputOptions('-vf', filterChain)
                .videoCodec(videoCodec)
                .outputOptions('-preset', 'slow')
                .outputOptions('-crf', quality);
        }

        if (audioMode === 'reencode') {
            command.audioCodec('aac').audioBitrate('192k');
        } else {
            command.outputOptions('-c:a', 'copy');
        }

         activeCommand = command
            .output(finalOutputPath)
            .on('progress', (progress) => {
                const percent = Math.max(0, Math.min(100, Math.floor(progress.percent ?? 0)));
                mainWindow.webContents.send('upscale-progress', {
                    percent,
                    currentFps: progress.currentFps ?? 0,
                    timemark:   progress.timemark   ?? '0:00:00'
                });
            })
            .on('end', () => {
                activeCommand = null;
                activeReject = null;
                mainWindow.webContents.send('upscale-progress', {
                    percent: 100, currentFps: 0, timemark: null
                });
                sendCompletionNotification(finalOutputPath);
                shell.showItemInFolder(finalOutputPath);
                resolve({ success: true, outputPath: finalOutputPath });
            })
            .on('error', (err) => {
                activeCommand = null;
                activeReject = null;
                console.error('[FFmpeg Error]:', err);
                reject(err.message);
            });

        activeCommand.run();
    });
});

app.whenReady().then(createWindow);

// ── Window control IPC ──
const { ipcMain: _ipc } = require('electron');
_ipc.on('win-minimize', () => mainWindow.minimize());
_ipc.on('win-maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
_ipc.on('win-close',    () => mainWindow.close());
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');

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
let activeCleanup = null;

const FORMAT_EXTENSIONS = {
    mp4: '.mp4',
    mkv: '.mkv',
};

const AI_MODELS = new Set([
    'realesrgan-x4plus',
    'realesrgan-x4plus-anime',
    'realesr-animevideov3-x2',
    'realesr-animevideov3-x3',
    'realesr-animevideov3-x4',
]);

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

function getRealEsrganPaths() {
    const basePath = app.isPackaged
        ? path.join(process.resourcesPath, 'bin', 'win')
        : path.join(__dirname, 'bin', 'win');

    return {
        executable: path.join(basePath, 'realesrgan-ncnn-vulkan.exe'),
        models: path.join(basePath, 'models'),
    };
}

function detectNvidiaGpu() {
    return new Promise((resolve) => {
        exec('nvidia-smi -L', { windowsHide: true }, (error, stdout) => {
            resolve(!error && /GPU\s+\d+:/i.test(stdout || ''));
        });
    });
}

function preferredVulkanGpuId(hasNvidiaGpu) {
    // On many hybrid laptops the integrated GPU is Vulkan device 0 and
    // the NVIDIA dGPU is device 1. Keep single/non-NVIDIA systems on 0.
    return hasNvidiaGpu ? '1' : '0';
}


function detectVulkanGPU() {
    return new Promise((resolve) => {
        const { executable } = getRealEsrganPaths();
        if (!fs.existsSync(executable)) {
            return resolve({ supported: false, device: 'cpu', available: false });
        }

         exec(`"${executable}" -h`, async (error, stdout, stderr) => {
            const output = `${stdout || ''}${stderr || ''}`;
              const hasNvidiaGpu = await detectNvidiaGpu();
            if (output.includes('gpu-id')) {
                 resolve({
                    supported: true,
                    device: 'vulkan',
                    available: true,
                    hasNvidiaGpu,
                    preferredGpuId: preferredVulkanGpuId(hasNvidiaGpu),
                });
            } else {
                resolve({ supported: false, device: 'cpu', available: true, hasNvidiaGpu });
            }
        });
    });
}

function parseFps(rate) {
    const [num, den] = String(rate || '24/1').split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
    if (Number.isFinite(num) && num > 0) return num;
    return 24;
}

function safeFramePercent(frames, totalFrames) {
    if (!Number.isFinite(totalFrames) || totalFrames <= 0) return 0;
    return Math.max(0, Math.min(99, Math.floor((Number(frames || 0) / totalFrames) * 100)));
}

function sendAiProgress(stage, percent, detail = '') {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('ai-upscale-progress', { stage, percent, detail });
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

ipcMain.handle('detect-vulkan', async () => {
    return await detectVulkanGPU();
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
    if (activeCleanup) activeCleanup();
    activeCommand = null;
    activeReject = null;
    activeCleanup = null;
    return { canceled: true };
});

ipcMain.handle('open-output-folder', async (event, outputPath) => {
    if (!outputPath) return;
    await shell.showItemInFolder(outputPath);
});

ipcMain.handle('ai-upscale-video', async (event, {
     inputPath, modelName, codecPreference, outputPath, outputFormat, vulkanGpuId
}) => {
    return new Promise(async (resolve, reject) => {
        if (activeCommand) return reject('Another upscale is already running.');

       if (!AI_MODELS.has(modelName)) return reject('Unsupported AI model selected.');

          const normalizedGpuId = String(vulkanGpuId ?? 'auto');
        const selectedGpuId = normalizedGpuId === 'auto'
            ? preferredVulkanGpuId(await detectNvidiaGpu())
            : normalizedGpuId;
        if (!/^\d+$/.test(selectedGpuId)) return reject('Invalid Vulkan GPU device selected.');

        const finalOutputPath = outputPath || incrementPath(defaultOutputPath(inputPath, outputFormat));
        const outputDir = path.dirname(finalOutputPath);
        if (!fs.existsSync(outputDir)) return reject('The selected output folder does not exist.');
        if (fs.existsSync(finalOutputPath)) return reject('The output file already exists. Choose a different filename.');

        const { executable: esrganPath, models: modelsPath } = getRealEsrganPaths();
        if (!fs.existsSync(esrganPath)) return reject('Real-ESRGAN binary was not found in bin/win. Install realesrgan-ncnn-vulkan.exe before using AI upscale.');
        if (!fs.existsSync(modelsPath)) return reject('Real-ESRGAN models folder was not found in bin/win/models.');
        if (!fs.existsSync(path.join(modelsPath, `${modelName}.param`)) || !fs.existsSync(path.join(modelsPath, `${modelName}.bin`))) {
            return reject(`Selected AI model files were not found: ${modelName}.param and ${modelName}.bin.`);
        }

        const tmpBase = path.join(os.tmpdir(), `esrgan_${process.pid}_${Date.now()}`);
        const framesDir = path.join(tmpBase, 'frames');
        const upscaledDir = path.join(tmpBase, 'upscaled');
        const audioPath = path.join(tmpBase, 'audio.mka');

        function cleanup() {
            try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (err) { console.warn('[AI cleanup]', err); }
        }

        try {
            fs.mkdirSync(framesDir, { recursive: true });
            fs.mkdirSync(upscaledDir, { recursive: true });
            activeCleanup = cleanup;
            activeReject = reject;

            sendAiProgress('probing', 0, 'Reading file info...');
            const probeData = await new Promise((res, rej) => {
                ffmpeg.ffprobe(inputPath, (err, meta) => {
                    if (err) return rej(err);
                    const videoStream = meta.streams?.find(s => s.codec_type === 'video');
                    const duration = Number(meta.format?.duration ?? 0);
                    const fps = parseFps(videoStream?.avg_frame_rate || videoStream?.r_frame_rate);
                    const totalFrames = Number(videoStream?.nb_frames) || Math.ceil(duration * fps) || 1;
                    res({ fps, totalFrames });
                });
            });
            const { fps, totalFrames } = probeData;

            sendAiProgress('extracting', 0, 'Extracting frames...');
            await new Promise((res, rej) => {
                activeCommand = ffmpeg(inputPath)
                    .outputOptions(['-q:v 1', '-qmin 1', '-an'])
                    .output(path.join(framesDir, 'frame%08d.jpg'))
                    .on('progress', (p) => sendAiProgress('extracting', safeFramePercent(p.frames, totalFrames), `Extracting frame ${p.frames || 0} of ${totalFrames}`))
                    .on('end', res)
                    .on('error', rej);
                activeCommand.run();
            });
            activeCommand = null;

            await new Promise((res) => {
                const audioCommand = ffmpeg(inputPath)
                    .outputOptions(['-vn', '-map 0:a:0?', '-c:a copy'])
                    .output(audioPath)
                    .on('end', res)
                    .on('error', res);
                audioCommand.run();
            });

            sendAiProgress('upscaling', 0, 'Starting AI upscale...');
await new Promise((res, rej) => {
    console.log(`[Real-ESRGAN] Vulkan GPU device: ${selectedGpuId}`);
    const args = ['-i', framesDir, '-o', upscaledDir, '-n', modelName, '-m', modelsPath, '-f', 'jpg', '-g', selectedGpuId].map(String);
    const proc = spawn(esrganPath, args, { windowsHide: true });
    activeCommand = proc;

    let completedFrames = 0;
    let lastPct = 0;

    const handleOutput = (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            const match = line.match(/([\d]+[.,][\d]+)%|^([\d]+)%/);
            if (!match) continue;

            const raw = (match[1] || match[2]).replace(',', '.');
            const pct = parseFloat(raw);
            if (!Number.isFinite(pct)) continue;

            // Detect frame completion: percentage resets back near zero
            if (lastPct >= 80 && pct < 10) {
                completedFrames++;
            }
            lastPct = pct;

            // Overall = completed frames + fractional progress through current frame
            const overall = Math.min(99, Math.floor(
                ((completedFrames + pct / 100) / totalFrames) * 100
            ));

            sendAiProgress('upscaling', overall,
                `Upscaling frame ${completedFrames + 1} of ${totalFrames} (${Math.round(pct)}%)`);
        }
    };

    proc.stderr.on('data', handleOutput);
    proc.stdout.on('data', handleOutput);

    proc.on('error', rej);
    proc.on('close', (code) => {
        console.log('[ESRGAN exit code]:', code);
        code === 0 ? res() : rej(new Error(`Real-ESRGAN exited with code ${code}`));
    });
});
activeCommand = null;

            sendAiProgress('assembling', 0, 'Reassembling video...');
            const useH265 = codecPreference === 'h265';
            const audioExists = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0;
            await new Promise((res, rej) => {
                let cmd = ffmpeg()
                    .input(path.join(upscaledDir, 'frame%08d.jpg'))
                    .inputOptions([`-framerate ${fps}`]);
                if (audioExists) cmd = cmd.input(audioPath);

                activeCommand = cmd
                    .videoCodec(useH265 ? 'libx265' : 'libx264')
                    .outputOptions([
                        `-crf ${useH265 ? '20' : '17'}`,
                        '-preset slow',
                        '-pix_fmt yuv420p',
                        audioExists ? '-c:a copy' : '-an',
                        '-movflags +faststart',
                    ])
                    .output(finalOutputPath)
                    .on('progress', (p) => sendAiProgress('assembling', safeFramePercent(p.frames, totalFrames), `Encoding frame ${p.frames || 0} of ${totalFrames}`))
                    .on('end', res)
                    .on('error', rej);
                activeCommand.run();
            });

            activeCommand = null;
            activeReject = null;
            activeCleanup = null;
            sendAiProgress('done', 100, 'Complete');
            cleanup();
            sendCompletionNotification(finalOutputPath);
            shell.showItemInFolder(finalOutputPath);
            resolve({ success: true, outputPath: finalOutputPath });
        } catch (err) {
            activeCommand = null;
            activeReject = null;
            activeCleanup = null;
            cleanup();
            reject(err?.message || String(err));
        }
    });
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
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const fetch = global.fetch || require('node-fetch');

const app = express();
const uploadDir = path.join(os.tmpdir(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeName = file.originalname || `video-${Date.now()}.mp4`;
    cb(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100 MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('video/')) {
      return cb(null, true);
    }
    cb(new Error('invalid file type: expected video/*'));
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', (error) => {
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} failed: ${stderr}`));
      }
    });
  });
}

async function getVideoDuration(inputPath) {
  try {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      inputPath
    ];
    const { stdout } = await runCommand('ffprobe', args);
    const duration = parseFloat(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch (error) {
    return null;
  }
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error('music download failed');
  }
  await pipeline(res.body, fs.createWriteStream(destPath));
}

async function runFfmpeg(args) {
  await runCommand('ffmpeg', args);
}

function buildAssetId(muxUploadUrl) {
  try {
    return muxUploadUrl.split('/').pop().split('?')[0];
  } catch (error) {
    return '';
  }
}

app.post('/process-upload', upload.single('video'), async (req, res) => {
  const inputFile = req.file?.path;
  const {
    facingMode = 'environment',
    audioMode = 'original',
    musicUrl = '',
    musicStart = '0',
    musicVolume = '1',
    muxUploadUrl = ''
  } = req.body || {};

  if (!inputFile) {
    return res.status(400).json({ error: 'missing video' });
  }
  if (!muxUploadUrl) {
    return res.status(400).json({ error: 'missing muxUploadUrl' });
  }

  const shouldFlip = facingMode === 'user';
  const needsMusic = audioMode === 'music' || audioMode === 'music+original';
  const hasMusicUrl = Boolean(musicUrl);
  if (needsMusic && !musicUrl) {
    return res.status(400).json({ error: 'missing musicUrl' });
  }
  let musicPath = '';
  let outputPath = '';

  try {
    const shouldUploadOnly = facingMode === 'environment' && audioMode === 'original' && !hasMusicUrl;
    const shouldMirrorOnly = facingMode === 'user' && audioMode === 'original' && !hasMusicUrl;
    const duration = await getVideoDuration(inputFile);
    const args = ['-y'];

    if (needsMusic) {
      let ext = '.mp3';
      try {
        ext = path.extname(new URL(musicUrl).pathname) || '.mp3';
      } catch (error) {
        ext = '.mp3';
      }
      musicPath = path.join(uploadDir, `music-${Date.now()}${ext}`);
      await downloadToFile(musicUrl, musicPath);
    }

    if (!shouldUploadOnly && shouldMirrorOnly) {
      args.push('-i', inputFile);
      outputPath = path.join(uploadDir, `output-${Date.now()}.mp4`);
      args.push('-vf', 'hflip', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'copy');
      args.push('-movflags', '+faststart', outputPath);
    } else if (!shouldUploadOnly) {
      if (!['original', 'mute', 'music', 'music+original'].includes(audioMode)) {
        return res.status(400).json({ error: 'invalid audioMode' });
      }
      if (audioMode === 'music' || audioMode === 'music+original') {
        args.push('-i', inputFile, '-ss', String(parseFloat(musicStart) || 0), '-i', musicPath);
      } else {
        args.push('-i', inputFile);
      }
      outputPath = path.join(uploadDir, `output-${Date.now()}.mp4`);
      const videoFilters = shouldFlip ? 'hflip' : '';
      const baseVideoArgs = [];
      if (videoFilters) {
        baseVideoArgs.push('-vf', videoFilters);
      }
      if (audioMode === 'original') {
        if (shouldFlip) {
          args.push(...baseVideoArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'copy');
        } else {
          args.push('-c:v', 'copy', '-c:a', 'copy');
        }
        args.push('-movflags', '+faststart', outputPath);
      } else if (audioMode === 'mute') {
        args.push(...baseVideoArgs, '-map', '0:v:0', '-an');
        if (shouldFlip) {
          args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
        } else {
          args.push('-c:v', 'copy');
        }
        args.push('-movflags', '+faststart', outputPath);
      } else if (audioMode === 'music') {
        const volumeValue = Math.max(0, Math.min(1, parseFloat(musicVolume) || 0));
        const trimFilter = Number.isFinite(duration) ? `atrim=0:${duration},asetpts=N/SR/TB` : 'asetpts=N/SR/TB';
        const filter = `[1:a]volume=${volumeValue}[ma];[ma]${trimFilter}[a]`;
        args.push(
          '-filter_complex', filter,
          '-map', '0:v:0', '-map', '[a]',
          ...baseVideoArgs,
          '-shortest',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
          '-c:a', 'aac',
          '-movflags', '+faststart',
          outputPath
        );
      } else if (audioMode === 'music+original') {
        const volumeValue = Math.max(0, Math.min(1, parseFloat(musicVolume) || 0));
        const filter = `[1:a]volume=${volumeValue}[ma];[0:a][ma]amix=inputs=2:duration=first:dropout_transition=2[a]`;
        args.push(
          '-filter_complex', filter,
          '-map', '0:v:0', '-map', '[a]',
          ...baseVideoArgs,
          '-shortest',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
          '-c:a', 'aac',
          '-movflags', '+faststart',
          outputPath
        );
      }
    }

    if (!shouldUploadOnly) {
      await runFfmpeg(args);
    }

    const fileToUpload = shouldUploadOnly ? inputFile : outputPath;
    if (!fs.existsSync(fileToUpload)) {
      throw new Error('Upload failed: output file was not created');
    }

    const uploadStream = fs.createReadStream(fileToUpload);
    const uploadRes = await new Promise((resolve, reject) => {
      uploadStream.on('error', (error) => {
        console.error('[MUX_PUT_STREAM_ERROR]', error);
        reject(error);
      });
      fetch(muxUploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4' },
        body: uploadStream,
        duplex: 'half'
      })
        .then(resolve)
        .catch(reject);
    });
    if (!uploadRes.ok) {
      throw new Error(`Mux upload failed: ${uploadRes.status}`);
    }

    const assetId = buildAssetId(muxUploadUrl);
    return res.json({ status: 'success', asset_id: assetId });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'processing failed' });
  } finally {
    [inputFile, musicPath, outputPath].forEach((filePath) => {
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (error) {}
      }
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});

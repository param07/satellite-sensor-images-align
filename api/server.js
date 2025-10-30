// simple Express server with file upload + job orchestration (jobs.json)
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import { promises as fsp } from 'fs';

// Fix __dirname since ESM doesn't have it
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'outputs');
const JOBS_FILE = path.join(__dirname, 'jobs.json');
const WORKER_DIR = path.join(__dirname, '..', 'worker');
const SCRIPT_NAME = 'worker_downsample.py';
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';

const SIZE_THRESHOLD_MB = 150; // Only downsample above this size
const DOWNSAMPLE_FACTOR = 0.25;

// Detect environment: if running inside Docker, use 'worker'; else localhost
const workerHost =
  process.env.WORKER_URL ||
  (process.env.DOCKER_ENV === "true" ? "http://worker:5000" : "http://localhost:5000");

const workerBase = workerHost;

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const id = uuidv4();
        cb(null, `${id}-${file.originalname}`);
    }
});
const upload = multer({ storage });


const app = express();

app.use(cors({
    origin: '*',
    exposedHeaders: ['Content-Type'],
}));
app.use(express.json());


const PORT = 8080;
app.listen(PORT, () => console.log('API listening', PORT));

app.get('/', (req, res) => {
    res.send('Hello World!')
})

// POST /api/upload => saves file and returns { imageId, filename, size }
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const filename = req.file.filename;

        const imageId = path.basename(filename, path.extname(filename));
        const filePath = path.join(UPLOAD_DIR, filename);
        const size = req.file.size;
        const fileSizeMB = req.file.size / (1024 * 1024);
        const metaPath = path.join(UPLOAD_DIR, `${imageId}.json`);
        const previewName = `${imageId}_preview.tif`;

        const meta = {
            imageId,
            originalFileName: req.file.originalname,
            savedFileName: filename,
            size,
            previewFileName: "", // for file of size > 150Mb
            status: "processing",
            uploadedAt: new Date().toISOString(),
            error: null
        };
        
        // If below threshold, we can mark ready immediately and no preview is required
        if (fileSizeMB <= SIZE_THRESHOLD_MB) {
            meta.previewFileName = "";
            meta.status = "ready";
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            return res.json({ imageId, filename: req.file.originalname, size });
        }

        meta.previewFileName = previewName;
        meta.status = "processing";
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); // write early

        const previewPath = path.join(UPLOAD_DIR, previewName);
        // const scriptPath = path.join(WORKER_DIR, SCRIPT_NAME);

        console.log(`File > ${SIZE_THRESHOLD_MB} MB — creating preview at ${previewPath}`);

        // Spawn worker and pass the meta path so the worker can update status
        // const py = spawn(PYTHON_BIN, [
        //     scriptPath,
        //     "--input", filePath,
        //     "--output", previewPath,
        //     "--scale", DOWNSAMPLE_FACTOR.toString(),
        //     "--meta", metaPath
        // ], {
        //     cwd: __dirname,
        //     env: process.env
        // });

        // py.stdout.on("data", (d) => console.log("[worker]", d.toString().trim()));
        // py.stderr.on("data", (d) => console.error("[worker-err]", d.toString()));
        // py.on("close", (code) => console.log("Downsample worker exited", code));

        // return res.json({ imageId, filename: req.file.originalname, size });
        const body = {
            input: filePath,
            output: previewPath,
            scale: DOWNSAMPLE_FACTOR,
            meta: metaPath
        };

        fetch(`${workerBase}/downsample`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
        .then(res => res.json())
        .then(json => console.log("Worker downsample:", json))
        .catch(err => console.error("Worker downsample error:", err));

        return res.json({ imageId, filename: req.file.originalname, size });

    } catch (err) {
        console.error('Upload error', err);
        return res.status(500).json({ error: 'Upload failed', message: err.message });
    }
});


// GET /api/rasters/:imageId.tif — secure on-demand streaming
app.get('/api/rasters/:imageId.tif', (req, res) => {
    const { imageId } = req.params;
    const metaPath = path.join(UPLOAD_DIR, `${imageId}.json`);
    if (!fs.existsSync(metaPath)) {
        return res.status(404).json({ error: 'Raster not found' });
    }

    const meta = JSON.parse(fs.readFileSync(metaPath));
    // If processing isn't finished, return 202 so frontend can poll/wait
    if (meta.status && meta.status !== "ready") {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(202).json({ status: meta.status, message: 'Raster preview is still processing' });
    }
    // Choose the file to serve: preview if available/expected, otherwise the original saved file
    const filePath = meta.previewFileName
        ? path.join(UPLOAD_DIR, meta.previewFileName)
        : path.join(UPLOAD_DIR, meta.savedFileName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    // Stream file securely
    res.setHeader('Content-Type', 'image/tiff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

});

// ensure jobs.json exists
async function ensureJobsFile() {
    try {
        await fsp.access(JOBS_FILE);
    } catch (e) {
        await fsp.writeFile(JOBS_FILE, JSON.stringify({}, null, 2));
    }
}

// Read jobs DB (simple JSON object: { jobId: {...} })
async function readJobs() {
    await ensureJobsFile();
    const txt = await fsp.readFile(JOBS_FILE, 'utf8');
    return JSON.parse(txt || '{}');
}

// Write jobs DB
async function writeJobs(jobs) {
    await fsp.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

// Update a single job entry
async function updateJob(jobId, patch) {
    const jobs = await readJobs();
    jobs[jobId] = { ...(jobs[jobId] || {}), ...patch };
    await writeJobs(jobs);
    return jobs[jobId];
}


// POST /api/jobs -> create a job and spawn worker
app.post('/api/jobs', async (req, res) => {
    try {
        const { imageAId, imageBId, aoi } = req.body || {};
        if (!imageAId || !imageBId || !aoi) {
            return res.status(400).json({ error: 'Missing imageAId, imageBId or aoi' });
        }

        // Validate uploaded files exist
        const metaA = path.join(UPLOAD_DIR, `${imageAId}.json`);
        const metaB = path.join(UPLOAD_DIR, `${imageBId}.json`);
        if (!fs.existsSync(metaA) || !fs.existsSync(metaB)) {
            return res.status(400).json({ error: 'One or both images not found on server' });
        }

        const jobId = uuidv4();
        const jobDir = path.join(OUTPUT_DIR, jobId);
        if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

        // prepare job entry
        const jobEntry = {
            jobId,
            status: 'queued',
            createdAt: new Date().toISOString(),
            imageAId,
            imageBId,
            aoi,
            progress: 0,
            error: null,
            outputs: null,
            logs: []
        };

        const jobs = await readJobs();
        jobs[jobId] = jobEntry;
        await writeJobs(jobs);

        // spawn python worker
        const workerScript = path.join(WORKER_DIR, 'worker.py');
        const imageAFile = getSavedFilePath(imageAId);
        const imageBFile = getSavedFilePath(imageBId);

        // Build AOI string as "north=<..>;south=<..>;east=<..>;west=<..>"
        const aoiStr = `north=${aoi.north};south=${aoi.south};east=${aoi.east};west=${aoi.west}`;

        const body = {
            imageA: imageAFile,
            imageB: imageBFile,
            aoi: aoi,
            outDir: jobDir,
            jobId: jobId
        };
        // Update job status to running
        await updateJob(jobId, { status: 'running', startedAt: new Date().toISOString(), progress: 0 });
        fetch(`${workerBase}/process_aoi`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
        .then(async (resp) => {
            if (!resp.ok) {
                const t = await resp.text();
                console.error("Worker process error:", t);
                await updateJob(jobId, { status: "error", error: t });
            } else {
                const data = await resp.json();
                if (data.status === "done") {
                    await updateJob(jobId, {
                        status: "done",
                        outputs: {
                            imageAUrl: `/api/outputs/${jobId}/A_clipped.tif`,
                            imageBUrl: `/api/outputs/${jobId}/B_clipped_aligned.tif`
                        },
                        progress: 100
                    });
                }
            }
        })
        .catch(async (err) => {
            console.error("Error calling worker process:", err);
            await updateJob(jobId, { status: "error", error: err.message });
        });

        // Return job id immediately
        return res.json({ jobId });

    } catch (err) {
        console.error('POST /api/jobs error', err);
        return res.status(500).json({ error: 'Failed to create job', message: err.message });
    }
});


// GET /api/jobs/:jobId -> return job status
app.get('/api/jobs/:jobId', async (req, res) => {
    const { jobId } = req.params;
    try {
        const jobs = await readJobs();
        if (!jobs[jobId]) return res.status(404).json({ error: 'Job not found' });
        return res.json(jobs[jobId]);
    } catch (err) {
        console.error('GET /api/jobs/:jobId err', err);
        return res.status(500).json({ error: 'Failed to read job', message: err.message });
    }
});

// Serve outputs folder (safe-ish; files are under data/outputs/<jobId>/)
app.use('/api/outputs', express.static(OUTPUT_DIR, {
    index: false,
    extensions: ['tif', 'tiff', 'png', 'jpg']
}));

// helper: resolve saved file path from imageId metadata file
function getSavedFilePath(imageId) {
    try {
        const metaPath = path.join(UPLOAD_DIR, `${imageId}.json`);
        if (!fs.existsSync(metaPath)) return null;
        const meta = JSON.parse(fs.readFileSync(metaPath));
        const filename = meta.savedFileName || meta.savedFilename || meta.savedFile;
        if (!filename) return null;
        return path.join(UPLOAD_DIR, filename);
    } catch (e) {
        console.error('getSavedFilePath error', e);
        return null;
    }
}


// Example: GET /api/rasters/clip/:jobId/A or /api/rasters/clip/:jobId/B
app.get('/api/rasters/clip/:jobId/:which', async (req, res) => {
    const { jobId, which } = req.params;
    const tifName = (which === 'A')
        ? 'A_clipped.tif'
        : (which === 'B')
            ? 'B_clipped_aligned.tif'
            : null;

    if (!tifName) {
        return res.status(400).json({ error: 'Invalid raster type. Use A or B.' });
    }

    const tifPath = path.join(OUTPUT_DIR, jobId, tifName);

    if (!fs.existsSync(tifPath)) {
        // still processing or not yet written
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(202).json({ status: 'processing', message: 'File not ready yet' });
    }

    // Check file size — if >150 MB, serve downsample preview
    const stats = fs.statSync(tifPath);
    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > SIZE_THRESHOLD_MB) {
        const previewPath = path.join(OUTPUT_DIR, jobId, `preview_${tifName}`);
        const scriptPath = path.join(WORKER_DIR, SCRIPT_NAME);

        // Generate preview asynchronously if not already exists
        if (!fs.existsSync(previewPath)) {
            console.log(`[preview] Generating downsample for ${tifName}`);
            // const py = spawn(PYTHON_BIN, [
            //     scriptPath,
            //     '--input', tifPath,
            //     '--output', previewPath,
            //     '--scale', DOWNSAMPLE_FACTOR.toString()
            // ], { cwd: WORKER_DIR, env: process.env });

            // py.stdout.on('data', d => console.log('[preview]', d.toString().trim()));
            // py.stderr.on('data', d => console.error('[preview-err]', d.toString().trim()));
            const body = {
                input: tifPath,
                output: previewPath,
                scale: DOWNSAMPLE_FACTOR
            };
            fetch(`${workerBase}/downsample`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            }).catch(err => console.error("Worker preview downsample error:", err));
        }

        // Return 202 while preview not yet ready
        if (!fs.existsSync(previewPath)) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.status(202).json({ status: 'processing', message: 'Preview not ready yet' });
        }

        res.setHeader('Content-Type', 'image/tiff');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const stream = fs.createReadStream(previewPath);
        return stream.pipe(res);
    }

    // Normal case: serve final processed TIFF
    res.setHeader('Content-Type', 'image/tiff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = fs.createReadStream(tifPath);
    stream.pipe(res);
});

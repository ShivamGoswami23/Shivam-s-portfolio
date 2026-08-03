require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// On Vercel the deployed bundle itself is read-only - only /tmp is writable,
// and it's wiped on every cold start (not shared across instances either).
// Everywhere else (Render, local), the app's own directory is writable and
// actually persists. Seed /tmp from the committed files on first write so
// reads/writes at least succeed instead of throwing EROFS.
const IS_VERCEL = !!process.env.VERCEL;
const WRITABLE_ROOT = IS_VERCEL ? '/tmp' : __dirname;
const BUNDLE_DATA_DIR = path.join(__dirname, 'data');
const BUNDLE_IMAGES_DIR = path.join(__dirname, 'images');
const BUNDLE_RESUME_PATH = path.join(__dirname, 'Shivam-Goswami-Resume.pdf');

const PROJECTS_FILE = path.join(WRITABLE_ROOT, 'data', 'projects.json');
const CERTIFICATES_FILE = path.join(WRITABLE_ROOT, 'data', 'certificates.json');
const MESSAGES_FILE = path.join(WRITABLE_ROOT, 'data', 'messages.json');
const SITE_FILE = path.join(WRITABLE_ROOT, 'data', 'site.json');
const RESUME_DATA_FILE = path.join(WRITABLE_ROOT, 'data', 'resume.json');
const IMAGES_DIR = path.join(WRITABLE_ROOT, 'images');
const PORTRAIT_PATH = path.join(IMAGES_DIR, 'shivam-portrait.jpg');
const RESUME_PATH = path.join(WRITABLE_ROOT, 'Shivam-Goswami-Resume.pdf');

function seedWritableStorage() {
    if (!IS_VERCEL) return;
    fs.mkdirSync(path.join(WRITABLE_ROOT, 'data'), { recursive: true });
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    for (const file of fs.readdirSync(BUNDLE_DATA_DIR)) {
        const dest = path.join(WRITABLE_ROOT, 'data', file);
        if (!fs.existsSync(dest)) fs.copyFileSync(path.join(BUNDLE_DATA_DIR, file), dest);
    }
    for (const file of fs.readdirSync(BUNDLE_IMAGES_DIR)) {
        const dest = path.join(IMAGES_DIR, file);
        if (!fs.existsSync(dest)) fs.copyFileSync(path.join(BUNDLE_IMAGES_DIR, file), dest);
    }
    if (!fs.existsSync(RESUME_PATH) && fs.existsSync(BUNDLE_RESUME_PATH)) {
        fs.copyFileSync(BUNDLE_RESUME_PATH, RESUME_PATH);
    }
}
seedWritableStorage();

// JSON data (messages/projects/certificates/site/resume) lives in a real,
// shared database when one's configured - a local/Render file only exists on
// that one instance/disk, which is exactly why messages saved on Vercel
// weren't showing up in the admin panel (a different serverless instance,
// with its own empty /tmp, served that later request). Falls back to the
// file-based behavior when no Supabase project is connected.
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

async function readJsonStore(key, filePath) {
    if (supabase) {
        const { data, error } = await supabase.from('kv_store').select('value').eq('key', key).maybeSingle();
        if (error) throw new Error('Supabase read failed: ' + error.message);
        if (data) return data.value;
        const seed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const { error: seedErr } = await supabase.from('kv_store').upsert({ key, value: seed });
        if (seedErr) throw new Error('Supabase seed failed: ' + seedErr.message);
        return seed;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function writeJsonStore(key, filePath, data) {
    if (supabase) {
        const { error } = await supabase.from('kv_store').upsert({ key, value: data });
        if (error) throw new Error('Supabase write failed: ' + error.message);
        return;
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Uploaded image files (project thumbnails, certificate scans) have the same
// problem as the JSON data: writing them to /tmp only puts them on whichever
// single Vercel instance handled that request, so they'd show up broken as
// soon as a different instance serves the page. Supabase Storage is real,
// shared, persistent file storage - falls back to local disk when it's not
// configured (matches the JSON data layer's fallback behavior).
async function uploadFileToStorage(buffer, storagePath, contentType) {
    if (supabase) {
        const { error } = await supabase.storage.from('images').upload(storagePath, buffer, {
            contentType,
            upsert: true,
        });
        if (error) throw new Error('Supabase storage upload failed: ' + error.message);
        const { data } = supabase.storage.from('images').getPublicUrl(storagePath);
        return data.publicUrl;
    }
    fs.writeFileSync(path.join(IMAGES_DIR, storagePath), buffer);
    return `images/${storagePath}`;
}

// Serves a fixed-name asset (a photo slot, the resume PDF) that may live in
// Supabase Storage instead of on local disk - redirects to the storage URL
// when configured, otherwise serves the local file as before.
//
// The redirect target is a fixed URL (hero.jpg, resume.pdf, ...) with no
// cache-busting of its own, so a browser (or Supabase's own CDN) can happily
// keep serving the old cached image forever after a new upload overwrites
// it - the version number is appended as a query param specifically to
// invalidate that cache every time the underlying file actually changes.
async function serveStorageFile(storagePath, localPath, res, version) {
    if (supabase) {
        const { data } = supabase.storage.from('images').getPublicUrl(storagePath);
        const url = version ? `${data.publicUrl}?v=${version}` : data.publicUrl;
        return res.redirect(url);
    }
    res.sendFile(localPath);
}

// Three independently-editable homepage photo slots (hero, about, background).
// Each falls back to a copy of the original portrait until an admin uploads
// its own image, and "delete" resets it back to that same default.
const PHOTO_SLOTS = {
    hero: path.join(IMAGES_DIR, 'shivam-hero.jpg'),
    about: path.join(IMAGES_DIR, 'shivam-about.jpg'),
    craft: path.join(IMAGES_DIR, 'shivam-craft.jpg'),
};

function ensurePhotoSlotsExist() {
    for (const slotPath of Object.values(PHOTO_SLOTS)) {
        if (!fs.existsSync(slotPath) && fs.existsSync(PORTRAIT_PATH)) {
            fs.copyFileSync(PORTRAIT_PATH, slotPath);
        }
    }
}

// iPhones sometimes export photos with a .jpg extension (and even an
// "image/jpeg" browser-reported mimetype) while the actual bytes are still
// HEIC/HEIF - browsers can't render that, so it silently shows as a broken
// image. Detect it from the real file signature so we can reject it with a
// clear, actionable message instead of writing an unusable file.
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];
function isHeic(buffer) {
    return buffer.length > 12
        && buffer.slice(4, 8).toString('ascii') === 'ftyp'
        && HEIF_BRANDS.includes(buffer.slice(8, 12).toString('ascii'));
}

// Re-encodes to guarantee the bytes on disk actually match what they claim to
// be, regardless of what the browser reported as the mimetype/extension.
async function normalizeImageBuffer(buffer, { forceJpeg = false } = {}) {
    if (isHeic(buffer)) {
        throw new Error('That looks like an iPhone HEIC photo, which browsers can\'t display. Please convert it to JPG first (iPhone: Settings > Camera > Formats > Most Compatible, or use "Export as JPEG" when sharing the photo), then upload again.');
    }
    const image = sharp(buffer).rotate();
    return forceJpeg ? image.jpeg({ quality: 90 }).toBuffer() : image.toBuffer();
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (/^image\/(png|jpe?g|webp|gif|svg\+xml|heic|heif)$/.test(file.mimetype)) return cb(null, true);
        cb(new Error('Only image files are allowed'));
    },
});

// For fixed-name overwrites (profile photo, resume) - hold the file in memory,
// we decide the final filename/location ourselves after validating it.
const uploadMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Vercel's Hobby-plan functions get killed at ~10s, and the whole email
// attempt has to fit inside that (on top of everything else the request
// already did) - so use a single short-timeout attempt there instead of the
// multi-retry approach Render/local can afford.
const MAIL_TIMEOUT_MS = IS_VERCEL ? 7000 : 10000;
const MAIL_MAX_ATTEMPTS = IS_VERCEL ? 1 : 3;

let mailTransporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    mailTransporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD,
        },
        connectionTimeout: MAIL_TIMEOUT_MS,
        greetingTimeout: MAIL_TIMEOUT_MS,
        socketTimeout: MAIL_TIMEOUT_MS,
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendContactNotification(msg, attempt = 1) {
    if (!mailTransporter) {
        console.log('Email not configured (missing GMAIL_USER/GMAIL_APP_PASSWORD) - skipping notification email.');
        return;
    }
    try {
        await mailTransporter.sendMail({
            from: `Portfolio Contact Form <${process.env.GMAIL_USER}>`,
            to: process.env.NOTIFY_EMAIL || process.env.GMAIL_USER,
            replyTo: msg.email,
            subject: `New portfolio message from ${msg.name}`,
            text: `From: ${msg.name} <${msg.email}>\n\n${msg.message}`,
            html: `<p><strong>From:</strong> ${escapeHtml(msg.name)} &lt;${escapeHtml(msg.email)}&gt;</p><p>${escapeHtml(msg.message).replace(/\n/g, '<br>')}</p>`,
        });
        console.log('Notification email sent for message ' + msg.id + ' (attempt ' + attempt + ')');
    } catch (err) {
        console.error('Failed to send notification email (attempt ' + attempt + '):', err.message);
        if (attempt < MAIL_MAX_ATTEMPTS) {
            await sleep(attempt * 2000);
            return sendContactNotification(msg, attempt + 1);
        }
        console.error('Giving up on notification email for message ' + msg.id + ' after ' + attempt + ' attempt(s).');
    }
}

app.use(express.json());

// Stateless admin auth: a signed, expiring cookie instead of a server-side
// session. express-session's default in-memory store only exists on
// whichever single instance created it - on Vercel, a different serverless
// instance (which happens constantly) has never heard of that session,
// so logins would randomly appear to "not be logged in" on the very next
// request. A signed cookie carries everything needed to verify itself, so
// it works identically no matter which instance handles the request.
const ADMIN_COOKIE = 'admin_token';
const ADMIN_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 8; // 8 hours
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';

function signAdminToken() {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_COOKIE_MAX_AGE_MS })).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function isValidAdminToken(token) {
    if (!token) return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (sig !== expectedSig) return false;
    try {
        return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
    } catch {
        return false;
    }
}

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};
    return Object.fromEntries(header.split(';').map((c) => {
        const idx = c.indexOf('=');
        return [c.slice(0, idx).trim(), decodeURIComponent(c.slice(idx + 1))];
    }));
}

function setAdminCookie(req, res, token) {
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    const maxAge = token ? Math.floor(ADMIN_COOKIE_MAX_AGE_MS / 1000) : 0;
    res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${token || ''}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}`);
}

const readProjects = () => readJsonStore('projects', PROJECTS_FILE);
const writeProjects = (projects) => writeJsonStore('projects', PROJECTS_FILE, projects);

const readCertificates = () => readJsonStore('certificates', CERTIFICATES_FILE);
const writeCertificates = (certificates) => writeJsonStore('certificates', CERTIFICATES_FILE, certificates);

const readMessages = () => readJsonStore('messages', MESSAGES_FILE);
const writeMessages = (messages) => writeJsonStore('messages', MESSAGES_FILE, messages);

const readSite = () => readJsonStore('site', SITE_FILE);
const writeSite = (site) => writeJsonStore('site', SITE_FILE, site);

const readResumeData = () => readJsonStore('resumeData', RESUME_DATA_FILE);
const writeResumeData = (data) => writeJsonStore('resumeData', RESUME_DATA_FILE, data);

function generateResumePdf(data) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const sectionHeading = (text) => {
            doc.moveDown(0.6);
            doc.fontSize(13).font('Helvetica-Bold').fillColor('#000').text(text.toUpperCase());
            doc.moveDown(0.3);
        };

        doc.fontSize(26).font('Helvetica-Bold').fillColor('#000').text(data.name || '');
        doc.fontSize(14).font('Helvetica').fillColor('#444').text(data.title || '');
        doc.moveDown(0.4);
        doc.fontSize(10).font('Helvetica').fillColor('#666')
            .text([data.phone, data.email].filter(Boolean).join('    |    '));
        doc.moveDown(0.5);
        doc.strokeColor('#cccccc').moveTo(50, doc.y).lineTo(545, doc.y).stroke();

        if (data.summary) {
            doc.moveDown(0.6);
            doc.fontSize(11).font('Helvetica').fillColor('#000').text(data.summary);
        }

        if (Array.isArray(data.skills) && data.skills.length) {
            sectionHeading('Key Skills');
            doc.fontSize(11).font('Helvetica').fillColor('#000').text(data.skills.join('   •   '));
        }

        if (Array.isArray(data.experience) && data.experience.length) {
            sectionHeading('Professional Experience');
            data.experience.forEach((exp, i) => {
                doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text(exp.company || '');
                doc.fontSize(10).font('Helvetica-Oblique').fillColor('#666')
                    .text([exp.role, exp.duration].filter(Boolean).join('   •   '));
                doc.moveDown(0.2);
                if (exp.description) {
                    doc.fontSize(10.5).font('Helvetica').fillColor('#000').text(exp.description);
                }
                if (i < data.experience.length - 1) doc.moveDown(0.5);
            });
        }

        if (Array.isArray(data.education) && data.education.length) {
            sectionHeading('Education');
            data.education.forEach((edu, i) => {
                doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text(edu.degree || '');
                doc.fontSize(10).font('Helvetica-Oblique').fillColor('#666')
                    .text([edu.institution, edu.duration, edu.score].filter(Boolean).join('   •   '));
                if (i < data.education.length - 1) doc.moveDown(0.4);
            });
        }

        if (data.extracurricular) {
            sectionHeading('Extracurricular Activities');
            doc.fontSize(11).font('Helvetica').fillColor('#000').text(data.extracurricular);
        }

        doc.end();
    });
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function renderProjectsHtml(projects) {
    return projects.map((p, i) => `
                <div class="project-wrapper">
                    <div class="project-anim"></div>
                    <div class="${i === 0 ? 'first ' : ''}project">
                        <img class="pro-img" src="${escapeHtml(p.image)}">
                        <a href="${escapeHtml(p.url)}" target="_blank">
                            <h1>${escapeHtml(p.title)}</h1>
                        </a>
                        <a href="${escapeHtml(p.url)}" target="_blank"><i class="ri-arrow-right-up-line"></i></a>
                    </div>
                </div>`).join('\n');
}

function renderCertificatesHtml(certificates) {
    if (!certificates.length) {
        return '<p class="empty-hint">No certificates added yet — check back soon.</p>';
    }
    return certificates.map((c, i) => `
                <div class="cert">
                    <h3 class="scale"><span>(${String(i + 1).padStart(2, '0')})</span><br><a href="${escapeHtml(c.image)}" class="cert-link" target="_blank">${escapeHtml(c.title)}</a><br><span class="cert-subtitle">${escapeHtml(c.issuer)}</span></h3>
                    <div class="cert-img scale"><a href="${escapeHtml(c.image)}" class="cert-link" target="_blank"><img src="${escapeHtml(c.image)}" alt="${escapeHtml(c.title)}"></a></div>
                </div>`).join('\n');
}

function requireAuth(req, res, next) {
    if (isValidAdminToken(parseCookies(req)[ADMIN_COOKIE])) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

// Public homepage: server-renders the current project list + asset versions into index.html
app.get('/', async (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    const projects = await readProjects();
    const certificates = await readCertificates();
    const site = await readSite();

    html = html.replace('<!-- PROJECTS_PLACEHOLDER -->', renderProjectsHtml(projects));
    html = html.replace('<!-- CERTIFICATES_PLACEHOLDER -->', renderCertificatesHtml(certificates));
    html = html.replaceAll('{{PHOTO_VERSION}}', site.photoVersion);
    html = html.replaceAll('{{RESUME_VERSION}}', site.resumeVersion);
    html = html.replaceAll('{{HERO_PHOTO_VERSION}}', site.heroPhotoVersion || 1);
    html = html.replaceAll('{{ABOUT_PHOTO_VERSION}}', site.aboutPhotoVersion || 1);
    html = html.replaceAll('{{CRAFT_PHOTO_VERSION}}', site.craftPhotoVersion || 1);

    res.send(html);
});

// Public read-only API
app.get('/api/projects', async (req, res) => {
    res.json(await readProjects());
});

app.get('/api/certificates', async (req, res) => {
    res.json(await readCertificates());
});

app.get('/api/site', async (req, res) => {
    res.json(await readSite());
});

// Admin auth
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        setAdminCookie(req, res, signAdminToken());
        return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/admin/logout', (req, res) => {
    setAdminCookie(req, res, null);
    res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
    res.json({ isAdmin: isValidAdminToken(parseCookies(req)[ADMIN_COOKIE]) });
});

// Admin project CRUD
app.post('/api/admin/projects', requireAuth, async (req, res) => {
    const { title, url, image } = req.body || {};
    if (!title || !url) return res.status(400).json({ error: 'title and url are required' });

    const projects = await readProjects();
    const newProject = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        title,
        url,
        image: image || 'images/plentycart.svg',
    };
    projects.push(newProject);
    await writeProjects(projects);
    res.status(201).json(newProject);
});

app.put('/api/admin/projects/:id', requireAuth, async (req, res) => {
    const projects = await readProjects();
    const idx = projects.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });

    const { title, url, image } = req.body || {};
    if (title !== undefined) projects[idx].title = title;
    if (url !== undefined) projects[idx].url = url;
    if (image !== undefined) projects[idx].image = image;
    await writeProjects(projects);
    res.json(projects[idx]);
});

app.delete('/api/admin/projects/:id', requireAuth, async (req, res) => {
    const projects = await readProjects();
    const idx = projects.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });

    const [removed] = projects.splice(idx, 1);
    await writeProjects(projects);
    res.json(removed);
});

// Admin certificate CRUD
app.post('/api/admin/certificates', requireAuth, async (req, res) => {
    const { title, issuer, image } = req.body || {};
    if (!title || !image) return res.status(400).json({ error: 'title and image are required' });

    const certificates = await readCertificates();
    const newCertificate = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        title,
        issuer: issuer || '',
        image,
    };
    certificates.push(newCertificate);
    await writeCertificates(certificates);
    res.status(201).json(newCertificate);
});

app.put('/api/admin/certificates/:id', requireAuth, async (req, res) => {
    const certificates = await readCertificates();
    const idx = certificates.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Certificate not found' });

    const { title, issuer, image } = req.body || {};
    if (title !== undefined) certificates[idx].title = title;
    if (issuer !== undefined) certificates[idx].issuer = issuer;
    if (image !== undefined) certificates[idx].image = image;
    await writeCertificates(certificates);
    res.json(certificates[idx]);
});

app.delete('/api/admin/certificates/:id', requireAuth, async (req, res) => {
    const certificates = await readCertificates();
    const idx = certificates.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Certificate not found' });

    const [removed] = certificates.splice(idx, 1);
    await writeCertificates(certificates);
    res.json(removed);
});

// Public contact form submission
app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'name, email, and message are required' });
    }

    const messages = await readMessages();
    const newMessage = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        name,
        email,
        message,
        createdAt: new Date().toISOString(),
    };
    messages.unshift(newMessage);
    await writeMessages(messages);

    if (IS_VERCEL) {
        // Serverless functions can freeze/terminate right after the response
        // is sent - a fire-and-forget send here would frequently never
        // complete. Await it so the function stays alive until it's done.
        await sendContactNotification(newMessage);
    } else {
        // Not awaited - the visitor's form submission responds immediately;
        // the email attempt (with its own retries) keeps running in the background.
        sendContactNotification(newMessage);
    }

    res.status(201).json({ ok: true });
});

// Admin: view/delete contact messages
app.get('/api/admin/messages', requireAuth, async (req, res) => {
    res.json(await readMessages());
});

app.delete('/api/admin/messages/:id', requireAuth, async (req, res) => {
    const messages = await readMessages();
    const idx = messages.findIndex((m) => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Message not found' });

    const [removed] = messages.splice(idx, 1);
    await writeMessages(messages);
    res.json(removed);
});

// Admin: image upload (for project thumbnails, etc.)
app.post('/api/admin/upload', requireAuth, (req, res) => {
    upload.single('image')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        try {
            let buffer = req.file.buffer;
            let ext = 'svg';
            let contentType = 'image/svg+xml';
            if (req.file.mimetype !== 'image/svg+xml') {
                buffer = await normalizeImageBuffer(req.file.buffer);
                const format = (await sharp(buffer).metadata()).format;
                ext = format === 'jpeg' ? 'jpg' : format;
                contentType = `image/${ext}`;
            }
            const safeName = crypto.randomBytes(8).toString('hex') + '.' + ext;
            const imagePath = await uploadFileToStorage(buffer, safeName, contentType);
            res.json({ path: imagePath });
        } catch (convErr) {
            res.status(400).json({ error: convErr.message });
        }
    });
});

// Admin: upload/delete one of the three homepage photo slots (hero/about/craft)
const PHOTO_SLOT_VERSION_KEYS = {
    hero: 'heroPhotoVersion',
    about: 'aboutPhotoVersion',
    craft: 'craftPhotoVersion',
};

app.post('/api/admin/upload-photo/:slot', requireAuth, (req, res) => {
    const slotPath = PHOTO_SLOTS[req.params.slot];
    if (!slotPath) return res.status(400).json({ error: 'Unknown photo slot' });

    uploadMemory.single('photo')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        if (!/^image\/(png|jpe?g|webp|heic|heif)$/.test(req.file.mimetype)) {
            return res.status(400).json({ error: 'Please upload a JPG, PNG, or WEBP image' });
        }

        try {
            const normalized = await normalizeImageBuffer(req.file.buffer, { forceJpeg: true });
            if (supabase) {
                await uploadFileToStorage(normalized, `${req.params.slot}.jpg`, 'image/jpeg');
            } else {
                fs.writeFileSync(slotPath, normalized);
            }
        } catch (convErr) {
            return res.status(400).json({ error: convErr.message });
        }

        const versionKey = PHOTO_SLOT_VERSION_KEYS[req.params.slot];
        const site = await readSite();
        site[versionKey] = (site[versionKey] || 1) + 1;
        await writeSite(site);

        res.json({ ok: true, version: site[versionKey] });
    });
});

app.delete('/api/admin/upload-photo/:slot', requireAuth, async (req, res) => {
    const slotPath = PHOTO_SLOTS[req.params.slot];
    if (!slotPath) return res.status(400).json({ error: 'Unknown photo slot' });
    if (!fs.existsSync(PORTRAIT_PATH)) return res.status(500).json({ error: 'Default photo missing' });

    if (supabase) {
        const defaultBuffer = fs.readFileSync(PORTRAIT_PATH);
        await uploadFileToStorage(defaultBuffer, `${req.params.slot}.jpg`, 'image/jpeg');
    } else {
        fs.copyFileSync(PORTRAIT_PATH, slotPath);
    }

    const versionKey = PHOTO_SLOT_VERSION_KEYS[req.params.slot];
    const site = await readSite();
    site[versionKey] = (site[versionKey] || 1) + 1;
    await writeSite(site);

    res.json({ ok: true, version: site[versionKey] });
});

// Admin: structured resume content editor (auto-generates the PDF on save)
app.get('/api/admin/resume-data', requireAuth, async (req, res) => {
    res.json(await readResumeData());
});

app.put('/api/admin/resume-data', requireAuth, async (req, res) => {
    const data = req.body || {};
    if (!data.name) return res.status(400).json({ error: 'Name is required' });

    try {
        const pdfBuffer = await generateResumePdf(data);
        if (supabase) {
            await uploadFileToStorage(pdfBuffer, 'resume.pdf', 'application/pdf');
        } else {
            fs.writeFileSync(RESUME_PATH, pdfBuffer);
        }
        await writeResumeData(data);

        const site = await readSite();
        site.resumeVersion = (site.resumeVersion || 1) + 1;
        await writeSite(site);

        res.json({ ok: true, resumeVersion: site.resumeVersion });
    } catch (err) {
        console.error('Failed to generate resume PDF:', err.message);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// Admin: replace the resume PDF everywhere
app.post('/api/admin/upload-resume', requireAuth, (req, res) => {
    uploadMemory.single('resume')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        if (req.file.mimetype !== 'application/pdf') {
            return res.status(400).json({ error: 'Please upload a PDF file' });
        }

        if (supabase) {
            await uploadFileToStorage(req.file.buffer, 'resume.pdf', 'application/pdf');
        } else {
            fs.writeFileSync(RESUME_PATH, req.file.buffer);
        }

        const site = await readSite();
        site.resumeVersion = (site.resumeVersion || 1) + 1;
        await writeSite(site);

        res.json({ ok: true, resumeVersion: site.resumeVersion });
    });
});

// Serve the photo slots/resume from Supabase Storage when configured (so
// admin uploads actually show up, instead of a different serverless
// instance's empty /tmp), falling back to local disk otherwise.
app.get('/images/:filename', async (req, res, next) => {
    const match = req.params.filename.match(/^shivam-(hero|about|craft)\.jpg$/);
    if (!match) return next();
    const site = await readSite();
    const version = site[PHOTO_SLOT_VERSION_KEYS[match[1]]];
    await serveStorageFile(`${match[1]}.jpg`, PHOTO_SLOTS[match[1]], res, version);
});
app.get('/Shivam-Goswami-Resume.pdf', async (req, res) => {
    const site = await readSite();
    await serveStorageFile('resume.pdf', RESUME_PATH, res, site.resumeVersion);
});
app.use('/images', express.static(IMAGES_DIR));
app.use(express.static(__dirname));

ensurePhotoSlotsExist();

if (!IS_VERCEL) {
    app.listen(PORT, () => {
        console.log(`Portfolio running at http://localhost:${PORT}`);
        console.log(`Admin panel at    http://localhost:${PORT}/admin`);
    });
}

module.exports = app;

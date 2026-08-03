require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

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
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
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
        if (attempt < 3) {
            await sleep(attempt * 2000);
            return sendContactNotification(msg, attempt + 1);
        }
        console.error('Giving up on notification email for message ' + msg.id + ' after 3 attempts.');
    }
}

app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hours
}));

function readProjects() {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
}

function writeProjects(projects) {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function readCertificates() {
    return JSON.parse(fs.readFileSync(CERTIFICATES_FILE, 'utf-8'));
}

function writeCertificates(certificates) {
    fs.writeFileSync(CERTIFICATES_FILE, JSON.stringify(certificates, null, 2));
}

function readMessages() {
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
}

function writeMessages(messages) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

function readSite() {
    return JSON.parse(fs.readFileSync(SITE_FILE, 'utf-8'));
}

function writeSite(site) {
    fs.writeFileSync(SITE_FILE, JSON.stringify(site, null, 2));
}

function readResumeData() {
    return JSON.parse(fs.readFileSync(RESUME_DATA_FILE, 'utf-8'));
}

function writeResumeData(data) {
    fs.writeFileSync(RESUME_DATA_FILE, JSON.stringify(data, null, 2));
}

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
                    <h3 class="scale"><span>(${String(i + 1).padStart(2, '0')})</span><br><a href="${escapeHtml(c.image)}" class="cert-link" target="_blank">${escapeHtml(c.title)}</a><br><span style="font-family: Gilroy, sans-serif; font-size: 1.5vw; text-transform: none; color: var(--gray); display: block; margin-top: 1vw;">${escapeHtml(c.issuer)}</span></h3>
                    <div class="cert-img scale"><a href="${escapeHtml(c.image)}" class="cert-link" target="_blank"><img src="${escapeHtml(c.image)}" alt="${escapeHtml(c.title)}"></a></div>
                </div>`).join('\n');
}

function requireAuth(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

// Public homepage: server-renders the current project list + asset versions into index.html
app.get('/', (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    const projects = readProjects();
    const certificates = readCertificates();
    const site = readSite();

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
app.get('/api/projects', (req, res) => {
    res.json(readProjects());
});

app.get('/api/certificates', (req, res) => {
    res.json(readCertificates());
});

app.get('/api/site', (req, res) => {
    res.json(readSite());
});

// Admin auth
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/session', (req, res) => {
    res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// Admin project CRUD
app.post('/api/admin/projects', requireAuth, (req, res) => {
    const { title, url, image } = req.body || {};
    if (!title || !url) return res.status(400).json({ error: 'title and url are required' });

    const projects = readProjects();
    const newProject = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        title,
        url,
        image: image || 'images/plentycart.svg',
    };
    projects.push(newProject);
    writeProjects(projects);
    res.status(201).json(newProject);
});

app.put('/api/admin/projects/:id', requireAuth, (req, res) => {
    const projects = readProjects();
    const idx = projects.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });

    const { title, url, image } = req.body || {};
    if (title !== undefined) projects[idx].title = title;
    if (url !== undefined) projects[idx].url = url;
    if (image !== undefined) projects[idx].image = image;
    writeProjects(projects);
    res.json(projects[idx]);
});

app.delete('/api/admin/projects/:id', requireAuth, (req, res) => {
    const projects = readProjects();
    const idx = projects.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });

    const [removed] = projects.splice(idx, 1);
    writeProjects(projects);
    res.json(removed);
});

// Admin certificate CRUD
app.post('/api/admin/certificates', requireAuth, (req, res) => {
    const { title, issuer, image } = req.body || {};
    if (!title || !image) return res.status(400).json({ error: 'title and image are required' });

    const certificates = readCertificates();
    const newCertificate = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        title,
        issuer: issuer || '',
        image,
    };
    certificates.push(newCertificate);
    writeCertificates(certificates);
    res.status(201).json(newCertificate);
});

app.put('/api/admin/certificates/:id', requireAuth, (req, res) => {
    const certificates = readCertificates();
    const idx = certificates.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Certificate not found' });

    const { title, issuer, image } = req.body || {};
    if (title !== undefined) certificates[idx].title = title;
    if (issuer !== undefined) certificates[idx].issuer = issuer;
    if (image !== undefined) certificates[idx].image = image;
    writeCertificates(certificates);
    res.json(certificates[idx]);
});

app.delete('/api/admin/certificates/:id', requireAuth, (req, res) => {
    const certificates = readCertificates();
    const idx = certificates.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Certificate not found' });

    const [removed] = certificates.splice(idx, 1);
    writeCertificates(certificates);
    res.json(removed);
});

// Public contact form submission
app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'name, email, and message are required' });
    }

    const messages = readMessages();
    const newMessage = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        name,
        email,
        message,
        createdAt: new Date().toISOString(),
    };
    messages.unshift(newMessage);
    writeMessages(messages);

    // Not awaited - the visitor's form submission responds immediately;
    // the email attempt (with its own retries) keeps running in the background.
    sendContactNotification(newMessage);

    res.status(201).json({ ok: true });
});

// Admin: view/delete contact messages
app.get('/api/admin/messages', requireAuth, (req, res) => {
    res.json(readMessages());
});

app.delete('/api/admin/messages/:id', requireAuth, (req, res) => {
    const messages = readMessages();
    const idx = messages.findIndex((m) => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Message not found' });

    const [removed] = messages.splice(idx, 1);
    writeMessages(messages);
    res.json(removed);
});

// Admin: image upload (for project thumbnails, etc.)
app.post('/api/admin/upload', requireAuth, (req, res) => {
    upload.single('image')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        try {
            let buffer = req.file.buffer;
            let ext = '.svg';
            if (req.file.mimetype !== 'image/svg+xml') {
                buffer = await normalizeImageBuffer(req.file.buffer);
                const format = (await sharp(buffer).metadata()).format;
                ext = '.' + (format === 'jpeg' ? 'jpg' : format);
            }
            const safeName = crypto.randomBytes(8).toString('hex') + ext;
            fs.writeFileSync(path.join(IMAGES_DIR, safeName), buffer);
            res.json({ path: `images/${safeName}` });
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
            fs.writeFileSync(slotPath, normalized);
        } catch (convErr) {
            return res.status(400).json({ error: convErr.message });
        }

        const versionKey = PHOTO_SLOT_VERSION_KEYS[req.params.slot];
        const site = readSite();
        site[versionKey] = (site[versionKey] || 1) + 1;
        writeSite(site);

        res.json({ ok: true, version: site[versionKey] });
    });
});

app.delete('/api/admin/upload-photo/:slot', requireAuth, (req, res) => {
    const slotPath = PHOTO_SLOTS[req.params.slot];
    if (!slotPath) return res.status(400).json({ error: 'Unknown photo slot' });
    if (!fs.existsSync(PORTRAIT_PATH)) return res.status(500).json({ error: 'Default photo missing' });

    fs.copyFileSync(PORTRAIT_PATH, slotPath);

    const versionKey = PHOTO_SLOT_VERSION_KEYS[req.params.slot];
    const site = readSite();
    site[versionKey] = (site[versionKey] || 1) + 1;
    writeSite(site);

    res.json({ ok: true, version: site[versionKey] });
});

// Admin: structured resume content editor (auto-generates the PDF on save)
app.get('/api/admin/resume-data', requireAuth, (req, res) => {
    res.json(readResumeData());
});

app.put('/api/admin/resume-data', requireAuth, async (req, res) => {
    const data = req.body || {};
    if (!data.name) return res.status(400).json({ error: 'Name is required' });

    try {
        const pdfBuffer = await generateResumePdf(data);
        fs.writeFileSync(RESUME_PATH, pdfBuffer);
        writeResumeData(data);

        const site = readSite();
        site.resumeVersion = (site.resumeVersion || 1) + 1;
        writeSite(site);

        res.json({ ok: true, resumeVersion: site.resumeVersion });
    } catch (err) {
        console.error('Failed to generate resume PDF:', err.message);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// Admin: replace the resume PDF everywhere
app.post('/api/admin/upload-resume', requireAuth, (req, res) => {
    uploadMemory.single('resume')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        if (req.file.mimetype !== 'application/pdf') {
            return res.status(400).json({ error: 'Please upload a PDF file' });
        }

        fs.writeFileSync(RESUME_PATH, req.file.buffer);

        const site = readSite();
        site.resumeVersion = (site.resumeVersion || 1) + 1;
        writeSite(site);

        res.json({ ok: true, resumeVersion: site.resumeVersion });
    });
});

// Serve the writable copies of images/resume first (so admin uploads show up
// instead of the original read-only bundle copies), then everything else.
app.use('/images', express.static(IMAGES_DIR));
app.use('/Shivam-Goswami-Resume.pdf', (req, res) => res.sendFile(RESUME_PATH));
app.use(express.static(__dirname));

ensurePhotoSlotsExist();

if (!IS_VERCEL) {
    app.listen(PORT, () => {
        console.log(`Portfolio running at http://localhost:${PORT}`);
        console.log(`Admin panel at    http://localhost:${PORT}/admin`);
    });
}

module.exports = app;

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;
const PROJECTS_FILE = path.join(__dirname, 'data', 'projects.json');
const MESSAGES_FILE = path.join(__dirname, 'data', 'messages.json');
const SITE_FILE = path.join(__dirname, 'data', 'site.json');
const RESUME_DATA_FILE = path.join(__dirname, 'data', 'resume.json');
const IMAGES_DIR = path.join(__dirname, 'images');
const PORTRAIT_PATH = path.join(IMAGES_DIR, 'shivam-portrait.jpg');
const RESUME_PATH = path.join(__dirname, 'Shivam-Goswami-Resume.pdf');

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, IMAGES_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            const safeName = crypto.randomBytes(8).toString('hex') + ext;
            cb(null, safeName);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (/^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(file.mimetype)) return cb(null, true);
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
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD,
        },
    });
}

async function sendContactNotification(msg) {
    if (!mailTransporter) {
        console.log('Email not configured (missing GMAIL_APP_PASSWORD) - skipping notification email.');
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
        console.log('Notification email sent for message ' + msg.id);
    } catch (err) {
        console.error('Failed to send notification email:', err.message);
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

function requireAuth(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

// Public homepage: server-renders the current project list + asset versions into index.html
app.get('/', (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    const projects = readProjects();
    const site = readSite();

    html = html.replace('<!-- PROJECTS_PLACEHOLDER -->', renderProjectsHtml(projects));
    html = html.replaceAll('{{PHOTO_VERSION}}', site.photoVersion);
    html = html.replaceAll('{{RESUME_VERSION}}', site.resumeVersion);

    res.send(html);
});

// Public read-only API
app.get('/api/projects', (req, res) => {
    res.json(readProjects());
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
    upload.single('image')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        res.json({ path: `images/${req.file.filename}` });
    });
});

// Admin: replace the site's own profile/hero photo everywhere
app.post('/api/admin/upload-photo', requireAuth, (req, res) => {
    uploadMemory.single('photo')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        if (!/^image\/(png|jpe?g|webp)$/.test(req.file.mimetype)) {
            return res.status(400).json({ error: 'Please upload a JPG, PNG, or WEBP image' });
        }

        fs.writeFileSync(PORTRAIT_PATH, req.file.buffer);

        const site = readSite();
        site.photoVersion = (site.photoVersion || 1) + 1;
        writeSite(site);

        res.json({ ok: true, photoVersion: site.photoVersion });
    });
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

app.use(express.static(__dirname));

app.listen(PORT, () => {
    console.log(`Portfolio running at http://localhost:${PORT}`);
    console.log(`Admin panel at    http://localhost:${PORT}/admin`);
});

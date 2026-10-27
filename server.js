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
//
// `downloadName` forces a "save file" instead of opening it in the browser
// (Supabase supports this via its own ?download= parameter).
async function serveStorageFile(storagePath, localPath, res, version, downloadName) {
    if (supabase) {
        const { data } = supabase.storage.from('images').getPublicUrl(storagePath);
        const params = new URLSearchParams();
        if (version) params.set('v', version);
        if (downloadName) params.set('download', downloadName);
        const query = params.toString();
        return res.redirect(query ? `${data.publicUrl}?${query}` : data.publicUrl);
    }
    if (downloadName) return res.download(localPath, downloadName);
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

function formatMessageDate(iso) {
    return new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
    }) + ' IST';
}

// Table-based layout with inline styles only - Gmail/Outlook strip <style>
// blocks and most modern CSS, so this is the only reliable way to get a
// consistently structured email.
function renderContactEmailHtml(msg) {
    const name = escapeHtml(msg.name);
    const email = escapeHtml(msg.email);
    const body = escapeHtml(msg.message).replace(/\r?\n/g, '<br>');
    const date = escapeHtml(formatMessageDate(msg.createdAt));
    const replyHref = `mailto:${encodeURIComponent(msg.email)}?subject=${encodeURIComponent('Re: Your message on my portfolio')}`;
    const label = 'font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#888888;padding:0 0 4px;';
    const value = 'font-size:15px;color:#111111;padding:0 0 18px;';

    return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f0f0f0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:32px 12px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;">
      <tr><td style="background:#111111;padding:22px 28px;">
        <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9a9a9a;">Portfolio Contact Form</div>
        <div style="font-size:20px;font-weight:700;color:#ffffff;padding-top:6px;">New message from ${name}</div>
      </td></tr>
      <tr><td style="padding:28px 28px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="${label}">Name</td></tr>
          <tr><td style="${value}font-weight:600;">${name}</td></tr>
          <tr><td style="${label}">Email</td></tr>
          <tr><td style="${value}"><a href="mailto:${email}" style="color:#111111;">${email}</a></td></tr>
          <tr><td style="${label}">Received</td></tr>
          <tr><td style="${value}">${date}</td></tr>
          <tr><td style="${label}">Message</td></tr>
          <tr><td style="padding:0 0 24px;">
            <div style="background:#f6f6f6;border-left:3px solid #111111;border-radius:6px;padding:16px 18px;font-size:15px;line-height:1.6;color:#222222;">${body}</div>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 28px 28px;">
        <a href="${replyHref}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:999px;">Reply to ${name}</a>
      </td></tr>
      <tr><td style="background:#fafafa;border-top:1px solid #eeeeee;padding:14px 28px;font-size:12px;color:#999999;">
        Sent automatically from your portfolio. Hitting reply in your inbox goes straight to ${email}.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function renderContactEmailText(msg) {
    return [
        'New portfolio message',
        '',
        `Name:     ${msg.name}`,
        `Email:    ${msg.email}`,
        `Received: ${formatMessageDate(msg.createdAt)}`,
        '',
        'Message:',
        msg.message,
    ].join('\n');
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
            replyTo: `"${msg.name.replace(/"/g, '')}" <${msg.email}>`,
            subject: `New portfolio message from ${msg.name}`,
            text: renderContactEmailText(msg),
            html: renderContactEmailHtml(msg),
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

// Older saved resume data (from before projects/college projects/structured
// extracurriculars existed) is upgraded on the fly so it still renders and
// still loads into the admin editor.
function normalizeResumeData(data = {}) {
    const list = (v) => (Array.isArray(v) ? v : []);
    const text = (v) => (v == null ? '' : String(v));
    let extracurricular = data.extracurricular;
    if (typeof extracurricular === 'string') {
        extracurricular = extracurricular.trim() ? [{ title: extracurricular.trim(), detail: '' }] : [];
    }
    return {
        name: text(data.name),
        title: text(data.title),
        phone: text(data.phone),
        email: text(data.email),
        summary: text(data.summary),
        skills: list(data.skills).map(text).filter(Boolean),
        experience: list(data.experience).map((exp) => ({
            company: text(exp.company),
            role: text(exp.role),
            duration: text(exp.duration),
            description: text(exp.description),
            projects: list(exp.projects).map((p) => ({
                name: text(p.name),
                url: text(p.url),
                bullets: list(p.bullets).map(text).filter(Boolean),
            })),
            website: text(exp.website),
        })),
        collegeProjectsDuration: text(data.collegeProjectsDuration),
        collegeProjects: list(data.collegeProjects).map((p) => ({ name: text(p.name), tech: text(p.tech) })),
        education: list(data.education).map((edu) => ({
            degree: text(edu.degree),
            institution: text(edu.institution),
            duration: text(edu.duration),
            score: text(edu.score),
        })),
        extracurricular: list(extracurricular).map((x) => ({ title: text(x.title), detail: text(x.detail) })),
    };
}

// Layout mirrors the original Word resume: big name, contact lines, black
// rules between sections, underlined letter-spaced headings, company/date on
// one line, bulleted project details, and Education | Extracurricular side by
// side with a vertical divider. PT Sans (OFL, bundled in fonts/) stands in
// for the original Trebuchet MS, which can't be redistributed.
const RESUME_FONTS = {
    regular: path.join(__dirname, 'fonts', 'PT_Sans-Web-Regular.ttf'),
    bold: path.join(__dirname, 'fonts', 'PT_Sans-Web-Bold.ttf'),
};

function generateResumePdf(rawData) {
    const data = normalizeResumeData(rawData);
    return new Promise((resolve, reject) => {
        const M = { top: 48, bottom: 48, left: 58, right: 58 };
        const doc = new PDFDocument({ size: 'A4', margins: M, info: { Title: `${data.name} - Resume`, Author: data.name } });
        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.registerFont('R', RESUME_FONTS.regular);
        doc.registerFont('B', RESUME_FONTS.bold);

        const X = M.left;
        const W = doc.page.width - M.left - M.right;
        const BODY = 10.5;
        const pageBottom = () => doc.page.height - M.bottom;
        const ensureSpace = (h) => { if (doc.y + h > pageBottom()) doc.addPage(); };

        const rule = (gapBefore = 10, gapAfter = 14) => {
            doc.y += gapBefore;
            ensureSpace(gapAfter + 30);
            doc.save().lineWidth(0.8).strokeColor('#000').moveTo(X, doc.y).lineTo(X + W, doc.y).stroke().restore();
            doc.y += gapAfter;
        };

        const heading = (label, { underline = true, x = X, width = W, right = '' } = {}) => {
            ensureSpace(40);
            const y = doc.y;
            if (right) doc.font('B').fontSize(BODY).fillColor('#000').text(right, x, y + 1, { width, align: 'right' });
            const text = label.toUpperCase();
            const spacing = 1.1;
            doc.font('B').fontSize(12).fillColor('#000').text(text, x, y, { width, characterSpacing: spacing });
            // PDFKit's own underline also spans the trailing letter-spacing,
            // overshooting the word - draw it to the exact text width instead.
            if (underline) {
                const lineW = Math.min(width, doc.widthOfString(text, { characterSpacing: spacing }) - spacing);
                const uy = y + doc.currentLineHeight() - 1;
                doc.save().lineWidth(0.9).strokeColor('#000').moveTo(x, uy).lineTo(x + lineW, uy).stroke().restore();
            }
            doc.y += 6;
        };

        const paragraph = (str, { x = X, width = W, font = 'R', size = BODY, gap = 4 } = {}) => {
            str.split(/\r?\n/).filter((l) => l.trim()).forEach((line) => {
                ensureSpace(doc.font(font).fontSize(size).heightOfString(line, { width, lineGap: 1.5 }));
                doc.font(font).fontSize(size).fillColor('#000').text(line, x, doc.y, { width, lineGap: 1.5 });
                doc.y += gap;
            });
        };

        // Header
        doc.font('B').fontSize(40).fillColor('#000').text(data.name, X, doc.y, { width: W });
        doc.y += 2;
        doc.font('R').fontSize(BODY);
        [data.phone, data.email].filter(Boolean).forEach((line) => doc.text(line, X, doc.y, { width: W }));
        rule(8, 18);

        // Title + summary
        if (data.title || data.summary) {
            if (data.title) heading(data.title, { underline: false });
            if (data.summary) paragraph(data.summary, { gap: 0 });
            rule(14, 18);
        }

        // Key competencies, filled column by column like the original
        if (data.skills.length) {
            heading('Key Competencies');
            const cols = data.skills.length > 8 ? 3 : 2;
            const perCol = Math.ceil(data.skills.length / cols);
            const colW = Math.min(170, W / cols);
            const lineH = doc.font('R').fontSize(BODY).currentLineHeight(true) + 1.5;
            ensureSpace(perCol * lineH);
            const top = doc.y;
            data.skills.forEach((skill, i) => {
                doc.font('R').fontSize(BODY).fillColor('#000')
                    .text(skill, X + Math.floor(i / perCol) * colW, top + (i % perCol) * lineH, { width: colW - 10, lineBreak: false });
            });
            doc.y = top + perCol * lineH;
            rule(8, 18);
        }

        // Professional experience
        if (data.experience.length) {
            heading('Professional Experience');
            data.experience.forEach((exp, i) => {
                if (i > 0) doc.y += 12;
                ensureSpace(60);
                const y = doc.y;
                doc.font('B').fontSize(BODY).fillColor('#000');
                if (exp.duration) doc.text(exp.duration, X, y, { width: W, align: 'right' });
                doc.text(exp.company, X, y, { width: W * 0.65 });
                if (exp.role) doc.text(exp.role, X, doc.y, { width: W });
                doc.y += 6;
                if (exp.description) paragraph(exp.description);

                exp.projects.forEach((p) => {
                    doc.y += 4;
                    ensureSpace(40);
                    doc.font('B').fontSize(BODY).fillColor('#000')
                        .text(`Project: ${p.name}`, X, doc.y, { width: W, continued: Boolean(p.url) });
                    if (p.url) doc.font('R').text(`  |  ${p.url}`);
                    doc.y += 5;
                    p.bullets.forEach((b) => {
                        const tx = X + 22;
                        const tw = W - 22;
                        ensureSpace(doc.font('R').fontSize(BODY).heightOfString(b, { width: tw, lineGap: 1.5 }));
                        const by = doc.y;
                        doc.font('R').fontSize(BODY).text('•', X + 8, by, { lineBreak: false });
                        doc.text(b, tx, by, { width: tw, lineGap: 1.5 });
                        doc.y += 3.5;
                    });
                });

                if (exp.website) {
                    doc.y += 4;
                    paragraph(`Website: ${exp.website}`, { gap: 0 });
                }
            });
        }

        // Other college projects
        if (data.collegeProjects.length) {
            rule(16, 18);
            heading('Other College Projects', { right: data.collegeProjectsDuration });
            data.collegeProjects.forEach((p) => {
                ensureSpace(30);
                doc.font('B').fontSize(9.5).fillColor('#000').text(p.name, X, doc.y, { width: W });
                if (p.tech) doc.font('R').fontSize(BODY).text(p.tech, X, doc.y, { width: W / 2 });
                doc.y += 8;
            });
        }

        // Education | Extracurricular, side by side
        if (data.education.length || data.extracurricular.length) {
            rule(data.collegeProjects.length ? 4 : 16, 18);
            const leftW = W * 0.47;
            const rightX = X + W * 0.53;
            const rightW = W - W * 0.53;
            const lh = (str, font, size, width) => doc.font(font).fontSize(size).heightOfString(str || ' ', { width, lineGap: 1.5 });
            const eduLines = (edu) => {
                const lines = edu.institution.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                if (edu.duration) {
                    if (lines.length) lines[lines.length - 1] += `, ${edu.duration}`;
                    else lines.push(edu.duration);
                }
                if (edu.score) lines.push(edu.score);
                return lines;
            };
            const leftH = 26 + data.education.reduce((h, edu) => h + 12 + lh(edu.degree, 'B', BODY, leftW)
                + eduLines(edu).reduce((s, l) => s + lh(l, 'R', BODY, leftW), 0), 0);
            const rightH = 26 + data.extracurricular.reduce((h, x) => h + 10 + lh(x.title, 'B', BODY, rightW) + lh(x.detail, 'R', 9.5, rightW), 0);
            ensureSpace(Math.max(leftH, rightH));

            const top = doc.y;
            if (data.education.length) {
                heading('Education & Certifications', { x: X, width: leftW });
                data.education.forEach((edu, i) => {
                    if (i > 0) doc.y += 12;
                    doc.font('B').fontSize(BODY).fillColor('#000').text(edu.degree, X, doc.y, { width: leftW, lineGap: 1.5 });
                    eduLines(edu).forEach((l) => doc.font('R').fontSize(BODY).text(l, X, doc.y, { width: leftW, lineGap: 1.5 }));
                });
            }
            const leftBottom = doc.y;

            doc.y = top;
            if (data.extracurricular.length) {
                heading('Extracurricular Activities', { x: rightX, width: rightW });
                data.extracurricular.forEach((x, i) => {
                    if (i > 0) doc.y += 10;
                    doc.font('B').fontSize(BODY).fillColor('#000').text(x.title, rightX, doc.y, { width: rightW, lineGap: 1.5 });
                    if (x.detail) doc.font('R').fontSize(9.5).text(x.detail, rightX, doc.y, { width: rightW, lineGap: 1.5 });
                });
            }
            const bottom = Math.max(leftBottom, doc.y);

            if (data.education.length && data.extracurricular.length) {
                const divX = X + W * 0.5;
                doc.save().lineWidth(0.8).strokeColor('#000').moveTo(divX, top - 4).lineTo(divX, bottom).stroke().restore();
            }
            doc.y = bottom;
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
                        ${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank">
                            <h1>${escapeHtml(p.title)}</h1>
                        </a>
                        <a href="${escapeHtml(p.url)}" target="_blank"><svg class="hicon hicon-extlink" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="ext-box" d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" /><g class="ext-arrow"><path d="M11 13l9 -9" /><path d="M15 4h5v5" /></g></svg></a>` : `<h1>${escapeHtml(p.title)}</h1>
                        <span class="project-private">Private</span>`}
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

// On Vercel without Supabase, every write lands in a single instance's /tmp
// and silently disappears - the admin panel surfaces this as a warning
// instead of just showing "No messages yet".
app.get('/api/admin/session', (req, res) => {
    res.json({
        isAdmin: isValidAdminToken(parseCookies(req)[ADMIN_COOKIE]),
        storage: supabase ? 'supabase' : 'file',
        persistent: Boolean(supabase) || !IS_VERCEL,
    });
});

// Admin project CRUD
app.post('/api/admin/projects', requireAuth, async (req, res) => {
    const { title, url, image } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title is required' });

    const projects = await readProjects();
    const newProject = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        title,
        url: url || '',
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

// Admin: turn a live website into a project thumbnail. The browser takes the
// screenshot itself (via thum.io / mShots / Microlink, which can take ~10s -
// longer than a Vercel Hobby function is allowed to run) and hands us the
// resulting image URL; this endpoint only downloads, resizes and stores it.
// There's intentionally no og:image fallback - for these sites it's a logo.
const PROJECT_THUMB_WIDTH = 1600;
const PROJECT_THUMB_HEIGHT = 1000;
const MAX_REMOTE_IMAGE_BYTES = 15 * 1024 * 1024;

function parseHttpUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return /^https?:$/.test(url.protocol) ? url : null;
    } catch {
        return null;
    }
}

async function fetchWithTimeout(url, ms) {
    return fetch(url, {
        signal: AbortSignal.timeout(ms),
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioThumbnailBot/1.0)' },
    });
}

app.post('/api/admin/projects/import-image', requireAuth, async (req, res) => {
    const source = parseHttpUrl(req.body?.imageUrl);
    if (!source) return res.status(400).json({ error: 'A valid screenshot image URL is required' });
    try {
        const imgRes = await fetchWithTimeout(source.href, 8000);
        if (!imgRes.ok) throw new Error(`Image download failed (${imgRes.status})`);
        if (!/^image\//.test(imgRes.headers.get('content-type') || '')) throw new Error('That URL is not an image');
        const raw = Buffer.from(await imgRes.arrayBuffer());
        if (raw.length > MAX_REMOTE_IMAGE_BYTES) throw new Error('Image is too large');

        // Same 16:10 frame as the other project thumbnails; screenshots are
        // anchored to the top so the site's header/hero is what's kept.
        const thumb = await sharp(raw)
            .resize(PROJECT_THUMB_WIDTH, PROJECT_THUMB_HEIGHT, { fit: 'cover', position: 'top' })
            .jpeg({ quality: 85, mozjpeg: true })
            .toBuffer();
        const imagePath = await uploadFileToStorage(thumb, crypto.randomBytes(8).toString('hex') + '.jpg', 'image/jpeg');
        res.json({ path: imagePath });
    } catch (err) {
        const message = err.name === 'TimeoutError' ? 'The site took too long to respond' : err.message;
        res.status(400).json({ error: message });
    }
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/contact', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'name, email, and message are required' });
    }
    if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (name.length > 100 || email.length > 200 || message.length > 5000) {
        return res.status(400).json({ error: 'Message is too long' });
    }

    const newMessage = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        name,
        email,
        message,
        read: false,
        createdAt: new Date().toISOString(),
    };

    // A storage failure must not lose the message - the email notification
    // below still delivers it even if saving didn't work.
    try {
        const messages = await readMessages();
        messages.unshift(newMessage);
        await writeMessages(messages);
    } catch (err) {
        console.error('Failed to save contact message ' + newMessage.id + ':', err.message);
    }

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

app.patch('/api/admin/messages/:id', requireAuth, async (req, res) => {
    const messages = await readMessages();
    const msg = messages.find((m) => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    if (typeof req.body?.read === 'boolean') msg.read = req.body.read;
    await writeMessages(messages);
    res.json(msg);
});

app.post('/api/admin/messages/mark-all-read', requireAuth, async (req, res) => {
    const messages = await readMessages();
    messages.forEach((m) => { m.read = true; });
    await writeMessages(messages);
    res.json({ ok: true });
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
    res.json(normalizeResumeData(await readResumeData()));
});

// Renders the PDF from the editor's current (unsaved) contents so the admin
// can check the layout before publishing it.
app.post('/api/admin/resume-preview', requireAuth, async (req, res) => {
    try {
        const pdfBuffer = await generateResumePdf(req.body || {});
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="resume-preview.pdf"');
        res.send(pdfBuffer);
    } catch (err) {
        console.error('Failed to generate resume preview:', err.message);
        res.status(500).json({ error: 'Failed to generate preview' });
    }
});

app.put('/api/admin/resume-data', requireAuth, async (req, res) => {
    const data = normalizeResumeData(req.body);
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
    const downloadName = req.query.download ? 'Shivam-Goswami-Resume.pdf' : undefined;
    await serveStorageFile('resume.pdf', RESUME_PATH, res, site.resumeVersion, downloadName);
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

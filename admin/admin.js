const bootScreen = document.getElementById('boot-screen');
const loginScreen = document.getElementById('login-screen');
const adminScreen = document.getElementById('admin-screen');

const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');

const projectsList = document.getElementById('projects-list');
const projectForm = document.getElementById('project-form');
const formTitle = document.getElementById('form-title');
const formError = document.getElementById('form-error');
const saveBtn = document.getElementById('save-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');
const logoutBtn = document.getElementById('logout-btn');

const projectIdInput = document.getElementById('project-id');
const projectTitleInput = document.getElementById('project-title');
const projectUrlInput = document.getElementById('project-url');
const projectImageInput = document.getElementById('project-image');
const projectImageFileInput = document.getElementById('project-image-file');
const imagePreview = document.getElementById('image-preview');
const uploadStatus = document.getElementById('upload-status');

const messagesList = document.getElementById('messages-list');
const messagesLayout = document.getElementById('messages-layout');
const messageDetail = document.getElementById('message-detail');
const messageSearch = document.getElementById('message-search');
const unreadBadge = document.getElementById('unread-badge');

const state = {
    messages: [],
    projects: [],
    certificates: [],
    messageFilter: 'all',
    messageQuery: '',
    selectedMessageId: null,
};

// HELPERS

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

function escapeAttr(str) {
    return escapeHtml(str || '').replace(/"/g, '&quot;');
}

// Uploads return either a site-relative path (images/abc.jpg, local disk
// mode) or a full Supabase Storage URL (https://..., when Supabase is
// configured) - only the first needs a leading slash.
function resolveImageSrc(image) {
    return /^https?:\/\//.test(image) ? image : `/${image}`;
}

function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?';
}

function formatDate(iso, withTime = false) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return withTime
        ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return formatDate(iso);
}

function toast(text, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'error' : ''}`;
    el.innerHTML = `<i class="${type === 'error' ? 'ri-error-warning-line' : 'ri-checkbox-circle-line'}"></i><span>${escapeHtml(text)}</span>`;
    document.getElementById('toast-root').appendChild(el);
    setTimeout(() => {
        el.classList.add('hide');
        setTimeout(() => el.remove(), 250);
    }, 3200);
}

const confirmModal = document.getElementById('confirm-modal');

function confirmDialog({ title = 'Are you sure?', text = '', okLabel = 'Delete' } = {}) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    okBtn.textContent = okLabel;
    confirmModal.style.display = 'flex';
    okBtn.focus();

    return new Promise((resolve) => {
        const close = (result) => {
            confirmModal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            confirmModal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKey);
            resolve(result);
        };
        const onOk = () => close(true);
        const onCancel = () => close(false);
        const onBackdrop = (e) => { if (e.target === confirmModal) close(false); };
        const onKey = (e) => { if (e.key === 'Escape') close(false); };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        confirmModal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
    });
}

// Wraps fetch for admin-only endpoints: if the session cookie is missing or
// expired, the API returns 401 - without this check, code that assumes the
// response body is always the expected data (an array, an object) would
// silently misread {"error":"Unauthorized"} as "no data" instead of
// recognizing the session dropped and prompting a fresh login.
async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401) {
        showLogin('Your session expired - please log in again.');
        return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

function jsonBody(method, payload) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

// NAVIGATION

const TAB_TITLES = {
    dashboard: 'Dashboard',
    messages: 'Messages',
    photo: 'Photos',
    resume: 'Resume',
    projects: 'Projects',
    certificates: 'Certificates',
};

function selectTab(name) {
    if (!TAB_TITLES[name]) name = 'dashboard';
    document.querySelectorAll('.sidebar-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    document.getElementById('page-title').textContent = TAB_TITLES[name];
    adminScreen.classList.remove('sidebar-open');
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    window.scrollTo(0, 0);
}

document.querySelectorAll('.sidebar-tab').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
});

document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => {
        if (el.dataset.filter) setMessageFilter(el.dataset.filter);
        selectTab(el.dataset.goto);
    });
});

document.getElementById('menu-btn').addEventListener('click', () => adminScreen.classList.toggle('sidebar-open'));
document.getElementById('sidebar-overlay').addEventListener('click', () => adminScreen.classList.remove('sidebar-open'));

// AUTH

let messagePoll = null;

function showAdmin(session) {
    bootScreen.style.display = 'none';
    loginScreen.style.display = 'none';
    adminScreen.style.display = 'flex';
    document.getElementById('storage-warning').style.display = session && session.persistent === false ? 'flex' : 'none';
    selectTab(location.hash.slice(1));

    loadProjects();
    loadCertificates();
    loadMessages();
    loadSiteAssets();
    loadResumeData();

    // Pick up new contact messages without a manual reload.
    clearInterval(messagePoll);
    messagePoll = setInterval(() => {
        if (document.visibilityState === 'visible') loadMessages({ silent: true });
    }, 60000);
}

function showLogin(message) {
    clearInterval(messagePoll);
    bootScreen.style.display = 'none';
    adminScreen.style.display = 'none';
    loginScreen.style.display = 'flex';
    loginError.textContent = message || '';
}

async function checkSession() {
    try {
        const res = await fetch('/api/admin/session');
        const data = await res.json();
        if (data.isAdmin) showAdmin(data);
        else showLogin();
    } catch {
        showLogin('Could not reach the server. Please try again.');
    }
}

document.getElementById('toggle-password').addEventListener('click', (e) => {
    const input = document.getElementById('login-password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.innerHTML = `<i class="${show ? 'ri-eye-off-line' : 'ri-eye-line'}"></i>`;
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';

    try {
        const res = await fetch('/api/admin/login', jsonBody('POST', {
            username: document.getElementById('login-username').value,
            password: document.getElementById('login-password').value,
        }));

        if (res.ok) {
            loginForm.reset();
            await checkSession();
        } else {
            const data = await res.json().catch(() => ({}));
            loginError.textContent = data.error || 'Login failed';
        }
    } catch {
        loginError.textContent = 'Could not reach the server. Please try again.';
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Sign In';
    }
});

logoutBtn.addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin();
});

// DASHBOARD

function renderDashboard() {
    const unread = state.messages.filter((m) => !m.read).length;
    document.getElementById('stat-messages').textContent = state.messages.length;
    document.getElementById('stat-unread').textContent = unread;
    document.getElementById('stat-projects').textContent = state.projects.length;
    document.getElementById('stat-certificates').textContent = state.certificates.length;

    unreadBadge.textContent = unread;
    unreadBadge.style.display = unread ? 'inline-flex' : 'none';
    document.title = unread ? `(${unread}) Admin | Shivam Goswami` : 'Admin | Shivam Goswami';

    const recent = document.getElementById('recent-messages');
    recent.innerHTML = '';
    if (!state.messages.length) {
        recent.innerHTML = '<p class="empty-state"><i class="ri-inbox-line"></i>No messages yet.</p>';
        return;
    }
    state.messages.slice(0, 5).forEach((m) => {
        const item = document.createElement('button');
        item.className = 'recent-item';
        item.innerHTML = `
            <span class="avatar">${escapeHtml(initials(m.name))}</span>
            <div class="info">
                <strong>${escapeHtml(m.name)}</strong>
                <span>${escapeHtml(m.message)}</span>
            </div>
            <span class="upload-status">${escapeHtml(timeAgo(m.createdAt))}</span>
            ${m.read ? '' : '<span class="unread-dot"></span>'}
        `;
        item.addEventListener('click', () => {
            selectTab('messages');
            openMessage(m.id);
        });
        recent.appendChild(item);
    });
}

// MESSAGES

async function loadMessages({ silent = false } = {}) {
    try {
        const messages = await fetchJson('/api/admin/messages');
        if (!messages) return;
        const hadIds = new Set(state.messages.map((m) => m.id));
        const fresh = silent ? messages.filter((m) => !hadIds.has(m.id)).length : 0;
        state.messages = messages;
        renderMessages();
        renderDashboard();
        if (fresh) toast(`${fresh} new message${fresh > 1 ? 's' : ''}`);
    } catch (err) {
        if (!silent) toast(err.message, 'error');
    }
}

function setMessageFilter(filter) {
    state.messageFilter = filter;
    document.querySelectorAll('#message-filters .pill').forEach((p) => p.classList.toggle('active', p.dataset.filter === filter));
    renderMessages();
}

document.querySelectorAll('#message-filters .pill').forEach((pill) => {
    pill.addEventListener('click', () => setMessageFilter(pill.dataset.filter));
});

messageSearch.addEventListener('input', () => {
    state.messageQuery = messageSearch.value.trim().toLowerCase();
    renderMessages();
});

document.getElementById('refresh-messages-btn').addEventListener('click', async () => {
    await loadMessages();
    toast('Messages refreshed');
});

document.getElementById('mark-all-read-btn').addEventListener('click', async () => {
    if (!state.messages.some((m) => !m.read)) return toast('Everything is already read');
    try {
        if (await fetchJson('/api/admin/messages/mark-all-read', { method: 'POST' }) === null) return;
        state.messages.forEach((m) => { m.read = true; });
        renderMessages();
        renderDashboard();
        toast('All messages marked as read');
    } catch (err) {
        toast(err.message, 'error');
    }
});

function filteredMessages() {
    return state.messages.filter((m) => {
        if (state.messageFilter === 'unread' && m.read) return false;
        if (state.messageFilter === 'read' && !m.read) return false;
        if (!state.messageQuery) return true;
        return [m.name, m.email, m.message].some((v) => String(v || '').toLowerCase().includes(state.messageQuery));
    });
}

function renderMessages() {
    const unread = state.messages.filter((m) => !m.read).length;
    document.getElementById('count-all').textContent = state.messages.length;
    document.getElementById('count-unread').textContent = unread;
    document.getElementById('count-read').textContent = state.messages.length - unread;

    const list = filteredMessages();
    messagesList.innerHTML = '';

    if (!list.length) {
        const text = state.messages.length ? 'No messages match this filter.' : 'No messages yet.';
        messagesList.innerHTML = `<tr><td colspan="6"><p class="empty-state"><i class="ri-inbox-line"></i>${text}</p></td></tr>`;
    }

    list.forEach((m) => {
        const row = document.createElement('tr');
        row.className = `${m.read ? 'is-read' : 'is-unread'} ${m.id === state.selectedMessageId ? 'selected' : ''}`;
        row.innerHTML = `
            <td class="col-status">${m.read ? '' : '<span class="unread-dot" title="Unread"></span>'}</td>
            <td class="cell-name">${escapeHtml(m.name)}<span class="cell-sub">${escapeHtml(timeAgo(m.createdAt))} · ${escapeHtml(m.message)}</span></td>
            <td class="hide-sm">${escapeHtml(m.email)}</td>
            <td class="hide-md cell-preview">${escapeHtml(m.message)}</td>
            <td class="hide-sm cell-date" title="${escapeAttr(formatDate(m.createdAt, true))}">${escapeHtml(timeAgo(m.createdAt))}</td>
            <td class="col-actions">
                <button class="icon-btn row-icon-btn toggle-read" title="${m.read ? 'Mark as unread' : 'Mark as read'}">
                    <i class="${m.read ? 'ri-mail-unread-line' : 'ri-mail-open-line'}"></i>
                </button>
                <button class="icon-btn row-icon-btn delete-msg" title="Delete"><i class="ri-delete-bin-line"></i></button>
            </td>
        `;
        row.addEventListener('click', () => openMessage(m.id));
        row.querySelector('.toggle-read').addEventListener('click', (e) => { e.stopPropagation(); setMessageRead(m, !m.read); });
        row.querySelector('.delete-msg').addEventListener('click', (e) => { e.stopPropagation(); deleteMessage(m); });
        messagesList.appendChild(row);
    });

    renderMessageDetail();
}

function openMessage(id) {
    state.selectedMessageId = id;
    const m = state.messages.find((x) => x.id === id);
    // Opening a message marks it read, like an email inbox.
    if (m && !m.read) setMessageRead(m, true, { quiet: true });
    else renderMessages();
    if (window.innerWidth <= 1100) messageDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderMessageDetail() {
    const m = state.messages.find((x) => x.id === state.selectedMessageId);
    if (!m) {
        state.selectedMessageId = null;
        messageDetail.style.display = 'none';
        messagesLayout.classList.remove('has-detail');
        return;
    }

    const replyHref = `mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent('Re: Your message on my portfolio')}`;
    messageDetail.style.display = 'flex';
    messagesLayout.classList.add('has-detail');
    messageDetail.innerHTML = `
        <div class="detail-head">
            <span class="avatar">${escapeHtml(initials(m.name))}</span>
            <div class="who">
                <h3>${escapeHtml(m.name)}</h3>
                <p>${escapeHtml(formatDate(m.createdAt, true))}</p>
            </div>
            <button class="icon-btn close-detail" aria-label="Close"><i class="ri-close-line"></i></button>
        </div>
        <div>
            <p class="field-label">Email</p>
            <div class="detail-email">
                <a href="mailto:${escapeAttr(m.email)}">${escapeHtml(m.email)}</a>
                <button class="icon-btn row-icon-btn copy-email" title="Copy email"><i class="ri-file-copy-line"></i></button>
            </div>
        </div>
        <div>
            <p class="field-label">Message</p>
            <div class="detail-body">${escapeHtml(m.message)}</div>
        </div>
        <div class="detail-actions">
            <a class="btn btn-primary" href="${escapeAttr(replyHref)}"><i class="ri-reply-line"></i> Reply by Email</a>
            <button class="btn btn-secondary toggle-read">
                <i class="${m.read ? 'ri-mail-unread-line' : 'ri-mail-open-line'}"></i> ${m.read ? 'Mark unread' : 'Mark read'}
            </button>
            <button class="btn btn-danger-soft delete-msg"><i class="ri-delete-bin-line"></i> Delete</button>
        </div>
    `;
    messageDetail.querySelector('.close-detail').addEventListener('click', () => {
        state.selectedMessageId = null;
        renderMessages();
    });
    messageDetail.querySelector('.copy-email').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(m.email);
            toast('Email copied');
        } catch {
            toast('Could not copy email', 'error');
        }
    });
    messageDetail.querySelector('.toggle-read').addEventListener('click', () => setMessageRead(m, !m.read));
    messageDetail.querySelector('.delete-msg').addEventListener('click', () => deleteMessage(m));
}

async function setMessageRead(m, read, { quiet = false } = {}) {
    const previous = m.read;
    m.read = read;
    renderMessages();
    renderDashboard();
    try {
        if (await fetchJson(`/api/admin/messages/${m.id}`, jsonBody('PATCH', { read })) === null) return;
        if (!quiet) toast(read ? 'Marked as read' : 'Marked as unread');
    } catch (err) {
        m.read = previous;
        renderMessages();
        renderDashboard();
        toast(err.message, 'error');
    }
}

async function deleteMessage(m) {
    const ok = await confirmDialog({ title: 'Delete message?', text: `The message from "${m.name}" will be permanently deleted.` });
    if (!ok) return;
    try {
        if (await fetchJson(`/api/admin/messages/${m.id}`, { method: 'DELETE' }) === null) return;
        state.messages = state.messages.filter((x) => x.id !== m.id);
        if (state.selectedMessageId === m.id) state.selectedMessageId = null;
        renderMessages();
        renderDashboard();
        toast('Message deleted');
    } catch (err) {
        toast(err.message, 'error');
    }
}

// PHOTOS / RESUME FILE

const PHOTO_SLOT_FILES = { hero: 'shivam-hero.jpg', about: 'shivam-about.jpg', craft: 'shivam-craft.jpg' };
const PHOTO_SLOT_VERSION_KEYS = { hero: 'heroPhotoVersion', about: 'aboutPhotoVersion', craft: 'craftPhotoVersion' };

async function loadSiteAssets() {
    const res = await fetch('/api/site');
    const site = await res.json();
    for (const slot of Object.keys(PHOTO_SLOT_FILES)) {
        const version = site[PHOTO_SLOT_VERSION_KEYS[slot]] || 1;
        document.getElementById(`current-photo-${slot}`).src = `/images/${PHOTO_SLOT_FILES[slot]}?v=${version}`;
    }
    document.getElementById('current-resume').href = `/Shivam-Goswami-Resume.pdf?v=${site.resumeVersion}`;
    document.getElementById('download-resume').href = `/Shivam-Goswami-Resume.pdf?v=${site.resumeVersion}&download=1`;
}

document.querySelectorAll('.photo-slot-file').forEach((input) => {
    input.addEventListener('change', async (e) => {
        const slot = input.dataset.slot;
        const file = e.target.files[0];
        if (!file) return;

        const status = document.getElementById(`photo-status-${slot}`);
        const reminder = document.getElementById('photo-linkedin-reminder');
        reminder.style.display = 'none';
        status.textContent = 'Uploading...';

        const formData = new FormData();
        formData.append('photo', file);

        try {
            if (await fetchJson(`/api/admin/upload-photo/${slot}`, { method: 'POST', body: formData }) === null) return;
            status.textContent = '';
            toast('Photo updated');
            if (slot === 'hero') reminder.style.display = 'block';
            loadSiteAssets();
        } catch (err) {
            status.textContent = '';
            toast(err.message, 'error');
        } finally {
            e.target.value = '';
        }
    });
});

document.querySelectorAll('.photo-slot-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
        const slot = btn.dataset.slot;
        const ok = await confirmDialog({ title: 'Reset photo?', text: 'This photo will be reset back to the default.', okLabel: 'Reset' });
        if (!ok) return;

        const status = document.getElementById(`photo-status-${slot}`);
        status.textContent = 'Resetting...';

        try {
            if (await fetchJson(`/api/admin/upload-photo/${slot}`, { method: 'DELETE' }) === null) return;
            toast('Photo reset to default');
            loadSiteAssets();
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            status.textContent = '';
        }
    });
});

document.getElementById('resume-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reminder = document.getElementById('resume-linkedin-reminder');
    reminder.style.display = 'none';
    toast('Uploading resume…');

    const formData = new FormData();
    formData.append('resume', file);

    try {
        if (await fetchJson('/api/admin/upload-resume', { method: 'POST', body: formData }) === null) return;
        toast('Resume PDF updated');
        reminder.style.display = 'block';
        loadSiteAssets();
    } catch (err) {
        toast(err.message, 'error');
    } finally {
        e.target.value = '';
    }
});

// PROJECTS

function resetForm() {
    captureToken++; // ignore any screenshot still in flight for the old form
    projectUrlOnLoad = '';
    fetchImageBtn.disabled = false;
    saveBtn.disabled = false;
    projectIdInput.value = '';
    projectForm.reset();
    formTitle.textContent = 'Add New Project';
    saveBtn.textContent = 'Add Project';
    cancelEditBtn.style.display = 'none';
    formError.textContent = '';
    uploadStatus.textContent = '';
    updateImagePreview();
}

function updateImagePreview() {
    const val = projectImageInput.value.trim();
    if (val) {
        imagePreview.src = resolveImageSrc(val);
        imagePreview.style.display = 'block';
    } else {
        imagePreview.style.display = 'none';
    }
}

projectImageInput.addEventListener('input', updateImagePreview);

projectImageFileInput.addEventListener('change', async () => {
    const file = projectImageFileInput.files[0];
    if (!file) return;

    uploadStatus.textContent = 'Uploading...';
    const formData = new FormData();
    formData.append('image', file);

    try {
        const data = await fetchJson('/api/admin/upload', { method: 'POST', body: formData });
        if (!data) return;
        projectImageInput.value = data.path;
        updateImagePreview();
        uploadStatus.textContent = 'Uploaded ✓';
    } catch (err) {
        uploadStatus.textContent = err.message;
    } finally {
        projectImageFileInput.value = '';
    }
});

cancelEditBtn.addEventListener('click', resetForm);

// SITE SCREENSHOTS
//
// A screenshot service renders the live homepage in a real browser. That can
// take ~10s - longer than a Vercel Hobby function may run - so the browser
// waits for the screenshot here, and the server then just downloads the
// (now cached) image, resizes and stores it.
//
// 1. thum.io  - waits a few seconds so lazy-loaded hero images are in.
// 2. WordPress mShots - renders in the background; polled until ready.
// 3. Microlink - last resort (free plan: 50 screenshots/day).
// The site's og:image is deliberately NOT used as a fallback: on sites like
// Mintex Care/Staffing it's just the logo. If every service fails, the
// current image is kept.

function isHttpUrl(value) {
    try {
        return /^https?:$/.test(new URL(value).protocol);
    } catch {
        return false;
    }
}

// Loading it as an <img> makes thum.io render and cache it without needing
// CORS; resolves once the screenshot actually exists.
function preloadImage(src, timeoutMs) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        const timer = setTimeout(() => { img.src = ''; reject(new Error('timeout')); }, timeoutMs);
        img.onload = () => { clearTimeout(timer); resolve(img); };
        img.onerror = () => { clearTimeout(timer); reject(new Error('failed')); };
        img.src = src;
    });
}

async function thumioScreenshot(pageUrl) {
    // maxAge/1 = reuse a cached render for at most an hour, so "Refresh image"
    // really shows the site as it is now.
    const src = `https://image.thum.io/get/width/1440/crop/900/viewportWidth/1440/wait/4/maxAge/1/noanimate/${pageUrl}`;
    const img = await preloadImage(src, 60000);
    if (img.naturalWidth < 600) throw new Error('bad screenshot');
    return src;
}

// mShots answers with a small "generating…" placeholder until the real
// 1440px render is ready, so poll (cache-busted) until we get full width.
async function mshotsScreenshot(pageUrl) {
    const base = `https://s0.wp.com/mshots/v1/${encodeURIComponent(pageUrl)}?w=1440&h=900`;
    for (let attempt = 0; attempt < 12; attempt++) {
        const src = `${base}&r=${Date.now()}`;
        try {
            const img = await preloadImage(src, 20000);
            if (img.naturalWidth >= 1200) return src;
        } catch {
            // placeholder or transient error - keep polling
        }
        await new Promise((r) => setTimeout(r, 4000));
    }
    throw new Error('mShots timed out');
}

async function microlinkScreenshot(pageUrl) {
    const params = new URLSearchParams({
        url: pageUrl,
        screenshot: 'true',
        meta: 'false',
        'viewport.width': '1440',
        'viewport.height': '900',
        waitForTimeout: '3000',
    });
    const res = await fetch(`https://api.microlink.io/?${params}`, { signal: AbortSignal.timeout(45000) });
    const data = await res.json();
    if (data.status !== 'success' || !data.data?.screenshot?.url) throw new Error(data.message || 'failed');
    return data.data.screenshot.url;
}

async function captureSiteImage(pageUrl) {
    for (const take of [thumioScreenshot, mshotsScreenshot, microlinkScreenshot]) {
        let imageUrl;
        try {
            imageUrl = await take(pageUrl);
        } catch {
            continue; // this service failed - try the next one
        }
        try {
            const result = await fetchJson('/api/admin/projects/import-image', jsonBody('POST', { imageUrl }));
            return result && result.path;
        } catch {
            // download/resize failed for this one - try the next service
        }
    }
    throw new Error('the screenshot services are busy right now. Your current image was kept - try again in a few minutes, or upload one.');
}

const fetchImageBtn = document.getElementById('project-fetch-image');
let projectUrlOnLoad = '';
let captureToken = 0;

async function fetchProjectImageFromUrl({ auto = false } = {}) {
    const url = projectUrlInput.value.trim();
    if (!isHttpUrl(url)) {
        if (!auto) uploadStatus.textContent = 'Enter a valid Live URL (https://...) first.';
        return;
    }

    // Only the latest capture wins if the URL is changed again mid-fetch.
    const token = ++captureToken;
    uploadStatus.textContent = 'Taking a screenshot of the site… (this can take ~15 seconds)';
    fetchImageBtn.disabled = true;
    saveBtn.disabled = true;

    try {
        const path = await captureSiteImage(url);
        if (token !== captureToken || !path) return;
        projectImageInput.value = path;
        updateImagePreview();
        uploadStatus.textContent = 'Screenshot captured ✓';
    } catch (err) {
        if (token === captureToken) uploadStatus.textContent = 'Could not capture the site: ' + err.message;
    } finally {
        if (token === captureToken) {
            fetchImageBtn.disabled = false;
            saveBtn.disabled = false;
        }
    }
}

fetchImageBtn.addEventListener('click', () => fetchProjectImageFromUrl());

projectUrlInput.addEventListener('change', () => {
    const url = projectUrlInput.value.trim();
    if (url && url !== projectUrlOnLoad) fetchProjectImageFromUrl({ auto: true });
});

async function refreshProjectImage(p, btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="ri-loader-4-line"></i> Capturing…';
    try {
        const path = await captureSiteImage(p.url);
        if (!path) return;
        if (await fetchJson(`/api/admin/projects/${p.id}`, jsonBody('PUT', { image: path })) === null) return;
        toast(`"${p.title}" image updated`);
        loadProjects();
    } catch (err) {
        toast('Could not capture the site: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="ri-camera-lens-line"></i> Refresh image';
    }
}

async function loadProjects() {
    const res = await fetch('/api/projects');
    state.projects = await res.json();
    renderProjects(state.projects);
    renderDashboard();
}

function renderProjects(projects) {
    projectsList.innerHTML = '';

    if (!projects.length) {
        projectsList.innerHTML = '<p class="empty-state"><i class="ri-briefcase-line"></i>No projects yet — add your first one below.</p>';
        return;
    }

    projects.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'item-row';
        row.innerHTML = `
            <img src="${escapeAttr(resolveImageSrc(p.image))}" alt="">
            <div class="info">
                <strong>${escapeHtml(p.title)}</strong>
                <span>${escapeHtml(p.url || 'Private / not public')}</span>
            </div>
            <div class="row-actions">
                ${p.url ? '<button class="btn btn-secondary btn-sm refresh-img-btn" title="Take a fresh screenshot of the live site"><i class="ri-camera-lens-line"></i> Refresh image</button>' : ''}
                <button class="btn btn-secondary btn-sm edit-btn"><i class="ri-edit-line"></i> Edit</button>
                <button class="btn btn-danger-soft btn-sm delete-btn"><i class="ri-delete-bin-line"></i> Delete</button>
            </div>
        `;
        const refreshBtn = row.querySelector('.refresh-img-btn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => refreshProjectImage(p, refreshBtn));
        row.querySelector('.edit-btn').addEventListener('click', () => startEdit(p));
        row.querySelector('.delete-btn').addEventListener('click', () => deleteProject(p));
        projectsList.appendChild(row);
    });
}

function startEdit(p) {
    captureToken++;
    projectUrlOnLoad = p.url || '';
    fetchImageBtn.disabled = false;
    saveBtn.disabled = false;
    projectIdInput.value = p.id;
    projectTitleInput.value = p.title;
    projectUrlInput.value = p.url;
    projectImageInput.value = p.image;
    formTitle.textContent = 'Edit Project';
    saveBtn.textContent = 'Save Changes';
    cancelEditBtn.style.display = 'inline-flex';
    formError.textContent = '';
    uploadStatus.textContent = '';
    updateImagePreview();
    projectForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteProject(p) {
    const ok = await confirmDialog({ title: 'Delete project?', text: `"${p.title}" will be removed from your portfolio. This can't be undone.` });
    if (!ok) return;
    try {
        if (await fetchJson(`/api/admin/projects/${p.id}`, { method: 'DELETE' }) === null) return;
        toast('Project deleted');
        loadProjects();
    } catch (err) {
        toast(err.message, 'error');
    }
}

projectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.textContent = '';

    const payload = {
        title: projectTitleInput.value.trim(),
        url: projectUrlInput.value.trim(),
        image: projectImageInput.value.trim(),
    };

    const id = projectIdInput.value;
    const isEdit = Boolean(id);
    saveBtn.disabled = true;

    try {
        const data = await fetchJson(isEdit ? `/api/admin/projects/${id}` : '/api/admin/projects', jsonBody(isEdit ? 'PUT' : 'POST', payload));
        if (!data) return;
        toast(isEdit ? 'Project updated' : 'Project added');
        resetForm();
        loadProjects();
    } catch (err) {
        formError.textContent = err.message;
    } finally {
        saveBtn.disabled = false;
    }
});

// CERTIFICATES

const certificatesList = document.getElementById('certificates-list');
const certificateForm = document.getElementById('certificate-form');
const certFormTitle = document.getElementById('cert-form-title');
const certFormError = document.getElementById('cert-form-error');
const certSaveBtn = document.getElementById('cert-save-btn');
const certCancelEditBtn = document.getElementById('cert-cancel-edit-btn');

const certIdInput = document.getElementById('cert-id');
const certTitleInput = document.getElementById('cert-title');
const certIssuerInput = document.getElementById('cert-issuer');
const certImageInput = document.getElementById('cert-image');
const certImageFileInput = document.getElementById('cert-image-file');
const certImagePreview = document.getElementById('cert-image-preview');
const certUploadStatus = document.getElementById('cert-upload-status');

function resetCertForm() {
    certIdInput.value = '';
    certificateForm.reset();
    certFormTitle.textContent = 'Add New Certificate';
    certSaveBtn.textContent = 'Add Certificate';
    certCancelEditBtn.style.display = 'none';
    certFormError.textContent = '';
    certUploadStatus.textContent = '';
    updateCertImagePreview();
}

function updateCertImagePreview() {
    const val = certImageInput.value.trim();
    if (val) {
        certImagePreview.src = resolveImageSrc(val);
        certImagePreview.style.display = 'block';
    } else {
        certImagePreview.style.display = 'none';
    }
}

certImageInput.addEventListener('input', updateCertImagePreview);

if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

async function pdfFileToImageBlob(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

certImageFileInput.addEventListener('change', async () => {
    const file = certImageFileInput.files[0];
    if (!file) return;

    const isPdf = file.type === 'application/pdf';
    certUploadStatus.textContent = isPdf ? 'Converting PDF...' : 'Uploading...';

    try {
        let uploadFile = file;
        if (isPdf) {
            const blob = await pdfFileToImageBlob(file);
            uploadFile = new File([blob], 'certificate.png', { type: 'image/png' });
            certUploadStatus.textContent = 'Uploading...';
        }

        const formData = new FormData();
        formData.append('image', uploadFile);

        const data = await fetchJson('/api/admin/upload', { method: 'POST', body: formData });
        if (!data) return;
        certImageInput.value = data.path;
        updateCertImagePreview();
        certUploadStatus.textContent = 'Uploaded ✓';
    } catch (err) {
        certUploadStatus.textContent = isPdf ? 'Could not convert PDF: ' + err.message : err.message;
    } finally {
        certImageFileInput.value = '';
    }
});

certCancelEditBtn.addEventListener('click', resetCertForm);

async function loadCertificates() {
    const res = await fetch('/api/certificates');
    state.certificates = await res.json();
    renderCertificates(state.certificates);
    renderDashboard();
}

function renderCertificates(certificates) {
    certificatesList.innerHTML = '';

    if (!certificates.length) {
        certificatesList.innerHTML = '<p class="empty-state"><i class="ri-award-line"></i>No certificates yet — add your first one below.</p>';
        return;
    }

    certificates.forEach((c) => {
        const row = document.createElement('div');
        row.className = 'item-row';
        row.innerHTML = `
            <img src="${escapeAttr(resolveImageSrc(c.image))}" alt="">
            <div class="info">
                <strong>${escapeHtml(c.title)}</strong>
                <span>${escapeHtml(c.issuer || '')}</span>
            </div>
            <div class="row-actions">
                <button class="btn btn-secondary btn-sm edit-btn"><i class="ri-edit-line"></i> Edit</button>
                <button class="btn btn-danger-soft btn-sm delete-btn"><i class="ri-delete-bin-line"></i> Delete</button>
            </div>
        `;
        row.querySelector('.edit-btn').addEventListener('click', () => startEditCert(c));
        row.querySelector('.delete-btn').addEventListener('click', () => deleteCertificate(c));
        certificatesList.appendChild(row);
    });
}

function startEditCert(c) {
    certIdInput.value = c.id;
    certTitleInput.value = c.title;
    certIssuerInput.value = c.issuer || '';
    certImageInput.value = c.image;
    certFormTitle.textContent = 'Edit Certificate';
    certSaveBtn.textContent = 'Save Changes';
    certCancelEditBtn.style.display = 'inline-flex';
    certFormError.textContent = '';
    certUploadStatus.textContent = '';
    updateCertImagePreview();
    certificateForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteCertificate(c) {
    const ok = await confirmDialog({ title: 'Delete certificate?', text: `"${c.title}" will be removed from your portfolio. This can't be undone.` });
    if (!ok) return;
    try {
        if (await fetchJson(`/api/admin/certificates/${c.id}`, { method: 'DELETE' }) === null) return;
        toast('Certificate deleted');
        loadCertificates();
    } catch (err) {
        toast(err.message, 'error');
    }
}

certificateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    certFormError.textContent = '';

    const payload = {
        title: certTitleInput.value.trim(),
        issuer: certIssuerInput.value.trim(),
        image: certImageInput.value.trim(),
    };

    const id = certIdInput.value;
    const isEdit = Boolean(id);
    certSaveBtn.disabled = true;

    try {
        const data = await fetchJson(isEdit ? `/api/admin/certificates/${id}` : '/api/admin/certificates', jsonBody(isEdit ? 'PUT' : 'POST', payload));
        if (!data) return;
        toast(isEdit ? 'Certificate updated' : 'Certificate added');
        resetCertForm();
        loadCertificates();
    } catch (err) {
        certFormError.textContent = err.message;
    } finally {
        certSaveBtn.disabled = false;
    }
});

// RESUME EDITOR

const experienceRowsEl = document.getElementById('experience-rows');
const educationRowsEl = document.getElementById('education-rows');
const resumeForm = document.getElementById('resume-form');
const resumeStatus = document.getElementById('resume-status');
const resumeFormError = document.getElementById('resume-form-error');
const resumeSaveBtn = document.getElementById('resume-save-btn');

const collegeProjectRowsEl = document.getElementById('college-project-rows');
const extracurricularRowsEl = document.getElementById('extracurricular-rows');

// A removable card; `fields` is the inner HTML, `label` names the remove button.
function entryRow(className, fields, label = 'Remove') {
    const row = document.createElement('div');
    row.className = `entry-row ${className}`;
    row.innerHTML = `${fields}<button type="button" class="btn btn-danger-soft btn-sm remove-entry-btn"><i class="ri-delete-bin-line"></i> ${label}</button>`;
    row.querySelector(':scope > .remove-entry-btn').addEventListener('click', () => row.remove());
    return row;
}

function projectRowHtml(p = {}) {
    return entryRow('project-entry', `
        <div class="entry-row-top">
            <input type="text" class="proj-name" placeholder="Project name (e.g. Mintex Care (Home Care Website))" value="${escapeAttr(p.name)}" />
            <input type="text" class="proj-url" placeholder="Website (optional, e.g. www.mintexcare.com)" value="${escapeAttr(p.url)}" />
        </div>
        <textarea class="proj-bullets" rows="5" placeholder="One bullet point per line">${escapeHtml((p.bullets || []).join('\n'))}</textarea>
    `, 'Remove project');
}

function experienceRowHtml(exp = {}) {
    const row = entryRow('experience-entry', `
        <div class="entry-row-top">
            <input type="text" class="exp-company" placeholder="Company" value="${escapeAttr(exp.company)}" />
            <input type="text" class="exp-role" placeholder="Role" value="${escapeAttr(exp.role)}" />
        </div>
        <input type="text" class="exp-duration" placeholder="Duration (e.g. 07/2025 - Present)" value="${escapeAttr(exp.duration)}" />
        <textarea class="exp-description" placeholder="Description (optional - each line becomes its own paragraph)" rows="3">${escapeHtml(exp.description || '')}</textarea>
        <div class="sub-section">
            <div class="resume-subsection-header">
                <h4>Projects</h4>
                <button type="button" class="btn btn-secondary btn-sm add-project-btn"><i class="ri-add-line"></i> Add Project</button>
            </div>
            <div class="project-rows sub-rows"></div>
        </div>
        <input type="text" class="exp-website" placeholder="Company website (optional, e.g. www.mintextech.com)" value="${escapeAttr(exp.website)}" />
    `, 'Remove experience');
    const projectRows = row.querySelector('.project-rows');
    (exp.projects || []).forEach((p) => projectRows.appendChild(projectRowHtml(p)));
    row.querySelector('.add-project-btn').addEventListener('click', () => projectRows.appendChild(projectRowHtml()));
    return row;
}

function educationRowHtml(edu = {}) {
    return entryRow('education-entry', `
        <div class="entry-row-top">
            <input type="text" class="edu-degree" placeholder="Degree" value="${escapeAttr(edu.degree)}" />
            <input type="text" class="edu-duration" placeholder="Duration (e.g. 2023 - 2025)" value="${escapeAttr(edu.duration)}" />
        </div>
        <textarea class="edu-institution" rows="3" placeholder="University / college - one line per row, exactly as it should appear">${escapeHtml(edu.institution || '')}</textarea>
        <input type="text" class="edu-score" placeholder="Score / Percentage" value="${escapeAttr(edu.score)}" />
    `);
}

function collegeProjectRowHtml(p = {}) {
    return entryRow('college-entry', `
        <div class="entry-row-top">
            <input type="text" class="cp-name" placeholder="Project name (e.g. Foody (Sem-3))" value="${escapeAttr(p.name)}" />
            <input type="text" class="cp-tech" placeholder="Technologies" value="${escapeAttr(p.tech)}" />
        </div>
    `);
}

function extracurricularRowHtml(x = {}) {
    return entryRow('extra-entry', `
        <div class="entry-row-top">
            <input type="text" class="ex-title" placeholder="Activity (e.g. Taekwondo)" value="${escapeAttr(x.title)}" />
            <input type="text" class="ex-detail" placeholder="Achievement / detail" value="${escapeAttr(x.detail)}" />
        </div>
    `);
}

document.getElementById('add-experience-btn').addEventListener('click', () => {
    experienceRowsEl.appendChild(experienceRowHtml());
});

document.getElementById('add-education-btn').addEventListener('click', () => {
    educationRowsEl.appendChild(educationRowHtml());
});

document.getElementById('add-college-project-btn').addEventListener('click', () => {
    collegeProjectRowsEl.appendChild(collegeProjectRowHtml());
});

document.getElementById('add-extracurricular-btn').addEventListener('click', () => {
    extracurricularRowsEl.appendChild(extracurricularRowHtml());
});

async function loadResumeData() {
    let data;
    try {
        data = await fetchJson('/api/admin/resume-data');
    } catch (err) {
        return toast(err.message, 'error');
    }
    if (!data) return;

    document.getElementById('resume-name').value = data.name || '';
    document.getElementById('resume-title').value = data.title || '';
    document.getElementById('resume-phone').value = data.phone || '';
    document.getElementById('resume-email').value = data.email || '';
    document.getElementById('resume-summary').value = data.summary || '';
    document.getElementById('resume-skills').value = (data.skills || []).join(', ');
    document.getElementById('resume-college-duration').value = data.collegeProjectsDuration || '';

    const fill = (el, items, makeRow) => {
        el.innerHTML = '';
        (items || []).forEach((item) => el.appendChild(makeRow(item)));
    };
    fill(experienceRowsEl, data.experience, experienceRowHtml);
    fill(collegeProjectRowsEl, data.collegeProjects, collegeProjectRowHtml);
    fill(educationRowsEl, data.education, educationRowHtml);
    fill(extracurricularRowsEl, data.extracurricular, extracurricularRowHtml);
}

const valueOf = (root, selector) => root.querySelector(selector).value.trim();
const rowsOf = (el, cls) => Array.from(el.querySelectorAll(`:scope > .entry-row.${cls}`));

function collectExperience() {
    return rowsOf(experienceRowsEl, 'experience-entry').map((row) => ({
        company: valueOf(row, '.exp-company'),
        role: valueOf(row, '.exp-role'),
        duration: valueOf(row, '.exp-duration'),
        description: valueOf(row, '.exp-description'),
        projects: rowsOf(row.querySelector('.project-rows'), 'project-entry').map((p) => ({
            name: valueOf(p, '.proj-name'),
            url: valueOf(p, '.proj-url'),
            bullets: p.querySelector('.proj-bullets').value.split('\n')
                .map((b) => b.trim().replace(/^[•\-*]\s*/, '')).filter(Boolean),
        })).filter((p) => p.name || p.bullets.length),
        website: valueOf(row, '.exp-website'),
    }));
}

function collectEducation() {
    return rowsOf(educationRowsEl, 'education-entry').map((row) => ({
        degree: valueOf(row, '.edu-degree'),
        institution: valueOf(row, '.edu-institution'),
        duration: valueOf(row, '.edu-duration'),
        score: valueOf(row, '.edu-score'),
    }));
}

function collectResume() {
    return {
        name: document.getElementById('resume-name').value.trim(),
        title: document.getElementById('resume-title').value.trim(),
        phone: document.getElementById('resume-phone').value.trim(),
        email: document.getElementById('resume-email').value.trim(),
        summary: document.getElementById('resume-summary').value.trim(),
        skills: document.getElementById('resume-skills').value.split(',').map((s) => s.trim()).filter(Boolean),
        experience: collectExperience(),
        collegeProjectsDuration: document.getElementById('resume-college-duration').value.trim(),
        collegeProjects: rowsOf(collegeProjectRowsEl, 'college-entry')
            .map((row) => ({ name: valueOf(row, '.cp-name'), tech: valueOf(row, '.cp-tech') }))
            .filter((p) => p.name || p.tech),
        education: collectEducation(),
        extracurricular: rowsOf(extracurricularRowsEl, 'extra-entry')
            .map((row) => ({ title: valueOf(row, '.ex-title'), detail: valueOf(row, '.ex-detail') }))
            .filter((x) => x.title || x.detail),
    };
}

const resumePreviewBtn = document.getElementById('resume-preview-btn');

resumePreviewBtn.addEventListener('click', async () => {
    resumeFormError.textContent = '';
    // Open the tab synchronously so popup blockers allow it, then fill it in.
    const win = window.open('', '_blank');
    resumePreviewBtn.disabled = true;
    try {
        const res = await fetch('/api/admin/resume-preview', jsonBody('POST', collectResume()));
        if (res.status === 401) {
            if (win) win.close();
            return showLogin('Your session expired - please log in again.');
        }
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Preview failed');
        const url = URL.createObjectURL(await res.blob());
        if (win) win.location.href = url;
        else window.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
        if (win) win.close();
        resumeFormError.textContent = err.message;
    } finally {
        resumePreviewBtn.disabled = false;
    }
});

resumeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    resumeFormError.textContent = '';
    resumeStatus.textContent = 'Generating PDF...';
    resumeSaveBtn.disabled = true;
    document.getElementById('resume-linkedin-reminder').style.display = 'none';

    const payload = collectResume();

    try {
        if (await fetchJson('/api/admin/resume-data', jsonBody('PUT', payload)) === null) return;
        toast('Resume saved and PDF generated');
        document.getElementById('resume-linkedin-reminder').style.display = 'block';
        loadSiteAssets();
    } catch (err) {
        resumeFormError.textContent = err.message;
    } finally {
        resumeStatus.textContent = '';
        resumeSaveBtn.disabled = false;
    }
});

checkSession();

const loginScreen = document.getElementById('login-screen');
const adminScreen = document.getElementById('admin-screen');

const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

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

function showAdmin() {
    loginScreen.style.display = 'none';
    adminScreen.style.display = 'block';
    loadProjects();
    loadCertificates();
    loadMessages();
    loadSiteAssets();
    loadResumeData();
}

async function loadSiteAssets() {
    const res = await fetch('/api/site');
    const site = await res.json();
    document.getElementById('current-photo').src = `/images/shivam-portrait.jpg?v=${site.photoVersion}`;
    document.getElementById('current-resume').href = `/Shivam-Goswami-Resume.pdf?v=${site.resumeVersion}`;
}

document.getElementById('photo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const status = document.getElementById('photo-status');
    const reminder = document.getElementById('photo-linkedin-reminder');
    reminder.style.display = 'none';
    status.textContent = 'Uploading...';

    const formData = new FormData();
    formData.append('photo', file);

    try {
        const res = await fetch('/api/admin/upload-photo', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');

        status.textContent = 'Uploaded ✓';
        reminder.style.display = 'block';
        loadSiteAssets();
    } catch (err) {
        status.textContent = err.message;
    } finally {
        e.target.value = '';
    }
});

document.getElementById('resume-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const status = document.getElementById('resume-status');
    const reminder = document.getElementById('resume-linkedin-reminder');
    reminder.style.display = 'none';
    status.textContent = 'Uploading...';

    const formData = new FormData();
    formData.append('resume', file);

    try {
        const res = await fetch('/api/admin/upload-resume', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');

        status.textContent = 'Uploaded ✓';
        reminder.style.display = 'block';
        loadSiteAssets();
    } catch (err) {
        status.textContent = err.message;
    } finally {
        e.target.value = '';
    }
});

function showLogin() {
    loginScreen.style.display = 'flex';
    adminScreen.style.display = 'none';
}

async function checkSession() {
    const res = await fetch('/api/admin/session');
    const data = await res.json();
    if (data.isAdmin) showAdmin();
    else showLogin();
}

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
        loginForm.reset();
        showAdmin();
    } else {
        const data = await res.json().catch(() => ({}));
        loginError.textContent = data.error || 'Login failed';
    }
});

logoutBtn.addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin();
});

function resetForm() {
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
        imagePreview.src = `/${val}`;
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
        const res = await fetch('/api/admin/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');

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

async function loadProjects() {
    const res = await fetch('/api/projects');
    const projects = await res.json();
    renderProjects(projects);
}

function renderProjects(projects) {
    projectsList.innerHTML = '';

    if (!projects.length) {
        projectsList.innerHTML = '<p class="empty-state">No projects yet — add your first one below.</p>';
        return;
    }

    projects.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'project-row';
        row.innerHTML = `
            <img src="/${p.image}" alt="">
            <div class="info">
                <strong>${escapeHtml(p.title)}</strong>
                <span>${escapeHtml(p.url)}</span>
            </div>
            <div class="row-actions">
                <button class="edit-btn">Edit</button>
                <button class="delete-btn">Delete</button>
            </div>
        `;
        row.querySelector('.edit-btn').addEventListener('click', () => startEdit(p));
        row.querySelector('.delete-btn').addEventListener('click', () => deleteProject(p));
        projectsList.appendChild(row);
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function startEdit(p) {
    projectIdInput.value = p.id;
    projectTitleInput.value = p.title;
    projectUrlInput.value = p.url;
    projectImageInput.value = p.image;
    formTitle.textContent = 'Edit Project';
    saveBtn.textContent = 'Save Changes';
    cancelEditBtn.style.display = 'inline-block';
    formError.textContent = '';
    uploadStatus.textContent = '';
    updateImagePreview();
    projectForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteProject(p) {
    if (!confirm(`Delete "${p.title}"? This can't be undone.`)) return;
    const res = await fetch(`/api/admin/projects/${p.id}`, { method: 'DELETE' });
    if (res.ok) {
        loadProjects();
    } else {
        alert('Failed to delete project.');
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

    const res = await fetch(isEdit ? `/api/admin/projects/${id}` : '/api/admin/projects', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (res.ok) {
        resetForm();
        loadProjects();
    } else {
        const data = await res.json().catch(() => ({}));
        formError.textContent = data.error || 'Something went wrong.';
    }
});

async function loadMessages() {
    const res = await fetch('/api/admin/messages');
    const messages = await res.json();
    renderMessages(messages);
}

function renderMessages(messages) {
    messagesList.innerHTML = '';

    if (!messages.length) {
        messagesList.innerHTML = '<p class="empty-state">No messages yet.</p>';
        return;
    }

    messages.forEach((m) => {
        const row = document.createElement('div');
        row.className = 'message-row';
        const date = new Date(m.createdAt).toLocaleString();
        row.innerHTML = `
            <div class="message-top">
                <div class="message-from">
                    <strong>${escapeHtml(m.name)}</strong>
                    <a href="mailto:${escapeHtml(m.email)}">${escapeHtml(m.email)}</a>
                </div>
                <span class="message-date">${escapeHtml(date)}</span>
            </div>
            <p class="message-body">${escapeHtml(m.message)}</p>
            <button class="delete-btn">Delete</button>
        `;
        row.querySelector('.delete-btn').addEventListener('click', () => deleteMessage(m));
        messagesList.appendChild(row);
    });
}

async function deleteMessage(m) {
    if (!confirm(`Delete message from "${m.name}"?`)) return;
    const res = await fetch(`/api/admin/messages/${m.id}`, { method: 'DELETE' });
    if (res.ok) {
        loadMessages();
    } else {
        alert('Failed to delete message.');
    }
}

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
        certImagePreview.src = `/${val}`;
        certImagePreview.style.display = 'block';
    } else {
        certImagePreview.style.display = 'none';
    }
}

certImageInput.addEventListener('input', updateCertImagePreview);

certImageFileInput.addEventListener('change', async () => {
    const file = certImageFileInput.files[0];
    if (!file) return;

    certUploadStatus.textContent = 'Uploading...';
    const formData = new FormData();
    formData.append('image', file);

    try {
        const res = await fetch('/api/admin/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');

        certImageInput.value = data.path;
        updateCertImagePreview();
        certUploadStatus.textContent = 'Uploaded ✓';
    } catch (err) {
        certUploadStatus.textContent = err.message;
    } finally {
        certImageFileInput.value = '';
    }
});

certCancelEditBtn.addEventListener('click', resetCertForm);

async function loadCertificates() {
    const res = await fetch('/api/certificates');
    const certificates = await res.json();
    renderCertificates(certificates);
}

function renderCertificates(certificates) {
    certificatesList.innerHTML = '';

    if (!certificates.length) {
        certificatesList.innerHTML = '<p class="empty-state">No certificates yet — add your first one below.</p>';
        return;
    }

    certificates.forEach((c) => {
        const row = document.createElement('div');
        row.className = 'project-row';
        row.innerHTML = `
            <img src="/${c.image}" alt="">
            <div class="info">
                <strong>${escapeHtml(c.title)}</strong>
                <span>${escapeHtml(c.issuer || '')}</span>
            </div>
            <div class="row-actions">
                <button class="edit-btn">Edit</button>
                <button class="delete-btn">Delete</button>
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
    certCancelEditBtn.style.display = 'inline-block';
    certFormError.textContent = '';
    certUploadStatus.textContent = '';
    updateCertImagePreview();
    certificateForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteCertificate(c) {
    if (!confirm(`Delete "${c.title}"? This can't be undone.`)) return;
    const res = await fetch(`/api/admin/certificates/${c.id}`, { method: 'DELETE' });
    if (res.ok) {
        loadCertificates();
    } else {
        alert('Failed to delete certificate.');
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

    const res = await fetch(isEdit ? `/api/admin/certificates/${id}` : '/api/admin/certificates', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (res.ok) {
        resetCertForm();
        loadCertificates();
    } else {
        const data = await res.json().catch(() => ({}));
        certFormError.textContent = data.error || 'Something went wrong.';
    }
});

// RESUME EDITOR

const experienceRowsEl = document.getElementById('experience-rows');
const educationRowsEl = document.getElementById('education-rows');
const resumeForm = document.getElementById('resume-form');
const resumeStatus = document.getElementById('resume-status');
const resumeFormError = document.getElementById('resume-form-error');

function experienceRowHtml(exp = {}) {
    const row = document.createElement('div');
    row.className = 'entry-row';
    row.innerHTML = `
        <div class="entry-row-top">
            <input type="text" class="exp-company" placeholder="Company" value="${escapeAttr(exp.company)}" />
            <input type="text" class="exp-role" placeholder="Role" value="${escapeAttr(exp.role)}" />
        </div>
        <input type="text" class="exp-duration" placeholder="Duration (e.g. 07/2025 - Present)" value="${escapeAttr(exp.duration)}" />
        <textarea class="exp-description" placeholder="Description" rows="3">${escapeHtml(exp.description || '')}</textarea>
        <button type="button" class="remove-entry-btn">Remove</button>
    `;
    row.querySelector('.remove-entry-btn').addEventListener('click', () => row.remove());
    return row;
}

function educationRowHtml(edu = {}) {
    const row = document.createElement('div');
    row.className = 'entry-row';
    row.innerHTML = `
        <div class="entry-row-top">
            <input type="text" class="edu-degree" placeholder="Degree" value="${escapeAttr(edu.degree)}" />
            <input type="text" class="edu-duration" placeholder="Duration (e.g. 2023 - 2025)" value="${escapeAttr(edu.duration)}" />
        </div>
        <input type="text" class="edu-institution" placeholder="Institution" value="${escapeAttr(edu.institution)}" />
        <input type="text" class="edu-score" placeholder="Score / Percentage" value="${escapeAttr(edu.score)}" />
        <button type="button" class="remove-entry-btn">Remove</button>
    `;
    row.querySelector('.remove-entry-btn').addEventListener('click', () => row.remove());
    return row;
}

function escapeAttr(str) {
    return escapeHtml(str || '').replace(/"/g, '&quot;');
}

document.getElementById('add-experience-btn').addEventListener('click', () => {
    experienceRowsEl.appendChild(experienceRowHtml());
});

document.getElementById('add-education-btn').addEventListener('click', () => {
    educationRowsEl.appendChild(educationRowHtml());
});

async function loadResumeData() {
    const res = await fetch('/api/admin/resume-data');
    const data = await res.json();

    document.getElementById('resume-name').value = data.name || '';
    document.getElementById('resume-title').value = data.title || '';
    document.getElementById('resume-phone').value = data.phone || '';
    document.getElementById('resume-email').value = data.email || '';
    document.getElementById('resume-summary').value = data.summary || '';
    document.getElementById('resume-skills').value = (data.skills || []).join(', ');
    document.getElementById('resume-extracurricular').value = data.extracurricular || '';

    experienceRowsEl.innerHTML = '';
    (data.experience || []).forEach((exp) => experienceRowsEl.appendChild(experienceRowHtml(exp)));

    educationRowsEl.innerHTML = '';
    (data.education || []).forEach((edu) => educationRowsEl.appendChild(educationRowHtml(edu)));
}

function collectExperience() {
    return Array.from(experienceRowsEl.querySelectorAll('.entry-row')).map((row) => ({
        company: row.querySelector('.exp-company').value.trim(),
        role: row.querySelector('.exp-role').value.trim(),
        duration: row.querySelector('.exp-duration').value.trim(),
        description: row.querySelector('.exp-description').value.trim(),
    }));
}

function collectEducation() {
    return Array.from(educationRowsEl.querySelectorAll('.entry-row')).map((row) => ({
        degree: row.querySelector('.edu-degree').value.trim(),
        institution: row.querySelector('.edu-institution').value.trim(),
        duration: row.querySelector('.edu-duration').value.trim(),
        score: row.querySelector('.edu-score').value.trim(),
    }));
}

resumeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    resumeFormError.textContent = '';
    resumeStatus.textContent = 'Saving...';
    document.getElementById('resume-linkedin-reminder').style.display = 'none';

    const payload = {
        name: document.getElementById('resume-name').value.trim(),
        title: document.getElementById('resume-title').value.trim(),
        phone: document.getElementById('resume-phone').value.trim(),
        email: document.getElementById('resume-email').value.trim(),
        summary: document.getElementById('resume-summary').value.trim(),
        skills: document.getElementById('resume-skills').value.split(',').map((s) => s.trim()).filter(Boolean),
        extracurricular: document.getElementById('resume-extracurricular').value.trim(),
        experience: collectExperience(),
        education: collectEducation(),
    };

    try {
        const res = await fetch('/api/admin/resume-data', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save');

        resumeStatus.textContent = 'Saved ✓';
        document.getElementById('resume-linkedin-reminder').style.display = 'block';
        loadSiteAssets();
    } catch (err) {
        resumeFormError.textContent = err.message;
        resumeStatus.textContent = '';
    }
});

checkSession();

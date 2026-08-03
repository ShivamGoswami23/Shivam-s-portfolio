# ⚡ Shivam Goswami — .NET Developer Portfolio

![Shivam Goswami](images/shivam-portrait.jpg)

A personal portfolio for **Shivam Goswami**, a .NET Developer. The public site is built with HTML5, Vanilla CSS3, JavaScript (ES6+), **GSAP 3**, and **Locomotive Scroll 4** for smooth-scroll animations — plus a small **Node.js / Express** backend that powers a private admin panel for managing the site's content.

---

## 🚀 Featured Projects

| Project Name | Stack & Focus | Live URL |
|---|---|---|
| **Mintex Care** | Home Care Services Website | [mintexcare.com](https://mintexcare.com/) |
| **Mintex Staffing** | Staffing & Recruitment Platform | [mintexstaffing.com](https://www.mintexstaffing.com/) |
| **PLENTYCART** | E-commerce Platform (ASP.NET MVC, React.js, Next.js, SQL Server) | Internal / not yet public |

---

## 🌟 Key Features

- **Modern Black & White Design** — Fjalla One + Gilroy typography, minimalist high-contrast layout.
- **Smooth Locomotive & GSAP Motion** — parallax scrolling, mask text reveals, mouse-follower cursor spotlight.
- **100% Responsive** — fluid layout across mobile, tablet, laptop, and desktop.
- **Skills Stack** — categorized across Frontend, Backend/.NET, Database, Tools, and Engineering Practices.
- **Education Section** — Bachelor's and Master's degrees with institution and score.
- **Admin Panel** (`/admin`, login-protected) —
  - Add / edit / delete portfolio projects, with image upload
  - Edit resume content field-by-field; a PDF is auto-generated and published site-wide on save
  - Upload a new profile photo — updates everywhere on the site instantly
  - View contact form submissions, with an email notification sent automatically
- **Real Contact Form** — submissions are saved and emailed, not just simulated.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend Core** | HTML5, Vanilla CSS3, JavaScript (ES6+) |
| **Animation** | GSAP 3, GSAP ScrollTrigger, Locomotive Scroll 4 |
| **Backend** | Node.js, Express |
| **Auth** | express-session (cookie-based admin login) |
| **Data Storage** | JSON files (`data/`) |
| **File Uploads** | Multer |
| **Email** | Nodemailer (Gmail SMTP) |
| **PDF Generation** | PDFKit (resume) |
| **UI Icons & Fonts** | RemixIcon 3.5, Google Fonts (*Fjalla One*, *Gilroy*) |

---

## 📂 Project Structure

```text
portfolio-design-main/
├── index.html                  # Main portfolio page (server-rendered project list)
├── style.css                   # Site styling
├── script.js                   # Locomotive Scroll, GSAP timelines, contact form logic
├── server.js                   # Express server: public site + admin API
├── package.json
├── .env                         # Local secrets (not committed — see setup below)
├── data/
│   ├── projects.json           # Portfolio projects
│   ├── messages.json           # Contact form submissions
│   ├── resume.json             # Structured resume content
│   └── site.json               # Asset version numbers (cache-busting)
├── admin/
│   ├── index.html              # Admin panel UI
│   ├── admin.css
│   └── admin.js
├── images/                     # Photos, logos, project thumbnails
├── Shivam-Goswami-Resume.pdf   # Auto-generated from data/resume.json
└── Gilroy-*.ttf                # Typography fonts
```

---

## 💻 Local Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/ShivamGoswami23/Shivam-s-portfolio.git
   cd Shivam-s-portfolio
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create a `.env` file** in the project root:
   ```env
   ADMIN_USERNAME=your-username
   ADMIN_PASSWORD=your-password
   SESSION_SECRET=a-long-random-string
   PORT=3000

   GMAIL_USER=your-gmail@gmail.com
   GMAIL_APP_PASSWORD=your-16-char-app-password
   NOTIFY_EMAIL=your-gmail@gmail.com
   ```
   (`GMAIL_APP_PASSWORD` requires 2-Step Verification enabled on the Gmail account — generate one at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).)

4. **Run it**
   ```bash
   npm run dev
   ```

5. Open **http://localhost:3000/** for the public site, and **http://localhost:3000/admin** for the admin panel.

---

## 🌐 Deployment

Deployed on **[Vercel](https://vercel.com)** as a serverless Node function (see `vercel.json`).

This app has a real backend (file storage, sessions, email, PDF generation) that normally expects an always-on host with persistent disk. Vercel's serverless functions don't have that — the bundle itself is read-only, and only `/tmp` is writable, wiped whenever a fresh instance spins up. To make it work anyway, writes are redirected to `/tmp` (seeded from the committed files on cold start). Practically, that means:
- Admin-uploaded content (projects, certificates, photos, contact messages) is not guaranteed to persist — treat anything added through the admin panel as temporary unless it's also committed into the repo.
- Admin login sessions can intermittently drop, since sessions aren't shared across serverless instances.

Environment variables: same as the `.env` file above, added via the Vercel dashboard (Project → Settings → Environment Variables).

---

## 👤 Author

**Shivam Goswami** — .NET Developer
- **GitHub**: [ShivamGoswami23](https://github.com/ShivamGoswami23)
- Reach out via the contact form on the live site.

---

*© 2026 Shivam Goswami. All Rights Reserved.*

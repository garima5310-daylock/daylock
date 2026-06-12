# DayLock — Launch Guide
## How to get this live in ~20 minutes (no coding needed)

---

## YOUR FILE STRUCTURE
Make sure your project looks exactly like this:

```
daylock/
├── public/
│   ├── index.html       ✅ included
│   ├── manifest.json    ✅ included
│   ├── sw.js            ✅ included
│   ├── icon-192.png     ⚠️  generate this (Step 0 below)
│   └── icon-512.png     ⚠️  generate this (Step 0 below)
├── src/
│   ├── index.js         ✅ included
│   └── App.jsx          ✅ included (your main app)
├── package.json         ✅ included
├── vercel.json          ✅ included
└── README.md            ✅ this file
```

---

## STEP 0 — Make your app icons (2 minutes)
1. Open the file `generate-icon.html` in your browser (just double-click it)
2. Click "Download icon-192.png" → save it to the `public/` folder
3. Click "Download icon-512.png" → save it to the `public/` folder

---

## STEP 1 — Create a GitHub account (2 minutes)
1. Go to **github.com**
2. Click "Sign up" → use your email → create account
3. Verify your email

---

## STEP 2 — Upload your project to GitHub (5 minutes)
1. Once logged in, click the **"+"** button (top right) → "New repository"
2. Name it: `daylock`
3. Keep it **Public** (required for free Vercel)
4. Click **"Create repository"**
5. On the next page, click **"uploading an existing file"**
6. Drag and drop ALL your project files/folders into the upload area
   - Drag the `public/` folder
   - Drag the `src/` folder
   - Drag `package.json`, `vercel.json`, `README.md`
7. Scroll down, click **"Commit changes"**

---

## STEP 3 — Deploy on Vercel (5 minutes)
1. Go to **vercel.com**
2. Click "Sign Up" → choose "Continue with GitHub" (use the same account)
3. Click **"Add New Project"**
4. You'll see your `daylock` repo — click **"Import"**
5. Vercel auto-detects it's a React app
6. Click **"Deploy"** — wait about 60 seconds
7. 🎉 You get a live URL like: `https://daylock-yourname.vercel.app`

---

## STEP 4 — Share with your family
Send them this message:

> "Hey! I built an app — try it out.
> Go to: [YOUR VERCEL URL]
> On iPhone: tap the Share button (box with arrow) → 'Add to Home Screen'
> On Android: tap the 3-dot menu → 'Add to Home Screen' or 'Install App'
> It'll appear on your phone like a real app!"

---

## STEP 5 — Add your Anthropic API key
The AI features (summary generation, voice parsing, weekly debrief) need an API key.

1. Go to **console.anthropic.com** → sign up free
2. Click "API Keys" → "Create Key" → copy it
3. In Vercel: go to your project → Settings → Environment Variables
4. Add: `REACT_APP_ANTHROPIC_KEY` = your key
5. Redeploy (Vercel → Deployments → Redeploy)

> ⚠️ NOTE: For now the app calls the API directly from the browser.
> This is fine for family testing. Before going public, you'll want a
> backend server to keep your key private. Ask me when you're ready.

---

## HOW FAMILY MEMBERS INSTALL IT

### iPhone (Safari only — must use Safari):
1. Open the link in **Safari** (not Chrome)
2. Tap the **Share icon** (square with arrow pointing up)
3. Scroll down → tap **"Add to Home Screen"**
4. Tap **"Add"**
5. The DayLock icon appears on their home screen ✅

### Android (Chrome):
1. Open the link in **Chrome**
2. Tap the **3-dot menu** (top right)
3. Tap **"Add to Home Screen"** or **"Install App"**
4. Tap **"Install"**
5. The DayLock icon appears on their home screen ✅

---

## GETTING FEEDBACK FROM FAMILY
Ask them specifically:
- Is the voice feature easy to use?
- Does the day-lock feel motivating or annoying?
- What section do you use most?
- What's confusing?
- Would you use this every day?

---

## UPDATING THE APP
Every time you want to change something:
1. Edit the `App.jsx` file
2. Go to GitHub → your repo → `src/App.jsx` → click the pencil ✏️ icon → paste new code → Commit
3. Vercel automatically redeploys in ~60 seconds
4. Your family gets the update instantly — no re-install needed ✅

---

## COSTS
- GitHub: FREE
- Vercel: FREE (up to 100GB bandwidth/month — more than enough for family)
- Anthropic API: ~$0.01 per AI request (very cheap for family testing)
- Custom domain (optional): ~$12/year on Namecheap or Google Domains

---

## NEED HELP?
If you get stuck on any step, just describe where you are and what you see on screen.

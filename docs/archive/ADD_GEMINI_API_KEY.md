# 🔑 How to Add Your Gemini API Key

## Quick Steps

### 1. Get Your FREE Gemini API Key

**Visit:** https://ai.google.dev/

1. Click **"Get API key in Google AI Studio"**
2. Sign in with your Google account
3. Click **"Create API Key"**
4. Copy the key (looks like: `AIzaSyD...`)

**FREE Tier Limits:**
- ✅ 15 requests per minute
- ✅ 1,500 requests per day
- ✅ 1 million tokens per day
- ✅ **No credit card required!**

---

### 2. Add Key to Your App

**Option A: Using Terminal (Easiest)**

```bash
cd /Users/jgundlapelli/.aisuite/notebook/telangana-app

# Replace YOUR_ACTUAL_KEY_HERE with your real key
echo 'GEMINI_API_KEY=AIzaSyD...' > .env.local
```

**Option B: Edit File Manually**

1. Open file: `/Users/jgundlapelli/.aisuite/notebook/telangana-app/.env.local`

2. Replace this:
   ```
   GEMINI_API_KEY=your_api_key_here
   ```

3. With your actual key:
   ```
   GEMINI_API_KEY=AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

4. Save the file

---

### 3. Restart Your Dev Server

```bash
# Stop the server (Ctrl+C)
# Then start again:
npm run dev
```

**Important:** The server MUST be restarted to read the new `.env.local` file!

---

## How to Verify It's Working

### Test 1: Server Startup
When you run `npm run dev`, you should see:
```
Server started on port 3001
✅ Gemini API configured
```

**If you see:**
```
⚠️ Gemini API key missing - running in simulation mode
```
→ Key not loaded properly, check steps below.

---

### Test 2: Upload Feature
1. Open http://localhost:3000
2. Click **"Add by Aadhaar"** button
3. Upload one of your sample Aadhaar cards
4. Should show "Extracting..." then populate fields

**If it works:** ✅ API key is correct  
**If nothing happens:** Check browser console (F12) for errors

---

## Troubleshooting

### ❌ "API key missing" error

**Check 1: File location**
```bash
ls -la /Users/jgundlapelli/.aisuite/notebook/telangana-app/.env.local
```
Should show the file exists.

**Check 2: File contents**
```bash
cat /Users/jgundlapelli/.aisuite/notebook/telangana-app/.env.local
```
Should show: `GEMINI_API_KEY=AIza...`

**Check 3: No spaces around = sign**
```
✅ CORRECT:   GEMINI_API_KEY=AIzaSyD...
❌ WRONG:     GEMINI_API_KEY = AIzaSyD...
❌ WRONG:     GEMINI_API_KEY= AIzaSyD... (space before key)
```

**Check 4: No quotes needed**
```
✅ CORRECT:   GEMINI_API_KEY=AIzaSyD...
❌ WRONG:     GEMINI_API_KEY="AIzaSyD..."
❌ WRONG:     GEMINI_API_KEY='AIzaSyD...'
```

**Check 5: Restart server**
After editing `.env.local`, you MUST stop (Ctrl+C) and restart `npm run dev`

---

### ❌ "Invalid API key" error

**Possible causes:**
1. **Key copied incorrectly** - Copy again from Google AI Studio
2. **Extra spaces** - Check no spaces at start/end of key
3. **Key expired/revoked** - Create a new one at https://ai.google.dev
4. **API not enabled** - Visit Google AI Studio and accept terms

---

### ❌ Upload button does nothing

**Check browser console:**
1. Press `F12` to open DevTools
2. Click "Console" tab
3. Click "Add by Aadhaar" button
4. Look for red error messages

**Common errors:**
- "Failed to fetch" → Server not running, run `npm run dev`
- "Network error" → Check port 3001 is not blocked
- "429 Too Many Requests" → Free tier limit reached (wait 1 minute)

---

## File Structure

```
telangana-app/
├── .env.local          ← Your API key goes here (NOT committed to git)
├── .gitignore          ← Should include .env.local
├── server.ts           ← Reads process.env.GEMINI_API_KEY
├── src/
│   └── App.tsx         ← Calls /api/extract-aadhaar endpoint
└── package.json
```

**Security:** The `.env.local` file is ignored by git (not pushed to GitHub) so your key stays private.

---

## Example: Complete Setup

### Step-by-step example:

```bash
# 1. Navigate to app folder
cd /Users/jgundlapelli/.aisuite/notebook/telangana-app

# 2. Create/edit .env.local file
nano .env.local

# 3. Add this line (replace with YOUR key):
GEMINI_API_KEY=AIzaSyDxxxxYOUR_ACTUAL_KEY_HERExxxx

# 4. Save file (Ctrl+O, Enter, Ctrl+X in nano)

# 5. Verify file contents
cat .env.local
# Should show: GEMINI_API_KEY=AIza...

# 6. Start server
npm run dev

# 7. Check terminal output - should see:
# "✅ Gemini API configured"
```

---

## API Key Security Best Practices

### ✅ DO:
- Keep `.env.local` file private
- Use different keys for dev/production
- Rotate keys periodically
- Check `.gitignore` includes `.env.local`

### ❌ DON'T:
- Commit `.env.local` to git
- Share your key in screenshots
- Use same key across multiple apps
- Hardcode key in source files

---

## What the API Key Enables

With a valid Gemini API key, these features work:

### 1. Aadhaar Card Extraction
- **Extracts:** Name, DOB, Age, Aadhaar No, Address, District, State, Pincode, Mobile, Relation, Occupation
- **Formats:** PDF, JPG, PNG, DOC
- **Languages:** English + Telugu

### 2. Link Document Extraction
- **Extracts:** 
  - Jurisdiction: District, Mandal, Village, Sub-Registrar, Pincode
  - Document: Doc No, Codes, Pattadar Passbook, Layout File No, House Tax Receipt
  - Property: Survey No, Plot No, Extent, Locality, Boundaries
  - Boundaries: East, West, North, South
- **Formats:** PDF, JPG, PNG, DOC, DOCX
- **Languages:** English + Telugu

### 3. Smart Features
- ✅ Handles handwritten text
- ✅ Transliterates Telugu to English
- ✅ Never guesses uncertain data
- ✅ Leaves fields empty if not clearly visible

---

## Cost Estimate

### FREE Tier (No Card Required):
- **1,500 requests/day** = enough for:
  - 750 Aadhaar extractions/day
  - 375 Link document extractions/day
  - Or mix of both

### Typical Usage:
- **Small office (10 docs/day):** ₹0/month ✅ FREE
- **Medium office (50 docs/day):** ₹0/month ✅ FREE
- **Busy office (200 docs/day):** ₹50-100/month

**You'll likely stay within FREE tier limits!**

---

## Testing Your Setup

### Quick Test Script:

```bash
# 1. Check file exists
cat .env.local

# 2. Start server
npm run dev

# 3. In another terminal, test API:
curl http://localhost:3001/health
# Should return: {"status":"ok"}

# 4. Open browser:
open http://localhost:3000

# 5. Test upload with sample Aadhaar card
```

---

## Need Help?

### If upload features don't work:

1. **Check server terminal** for error messages
2. **Check browser console (F12)** for errors
3. **Verify `.env.local` file** has correct key
4. **Restart server** after editing `.env.local`
5. **Check Gemini API Dashboard** at https://ai.google.dev for usage/errors

---

## Current Status

Your `.env.local` file currently contains:
```
GEMINI_API_KEY=your_api_key_here
```

**Action needed:** Replace `your_api_key_here` with your actual Gemini API key from https://ai.google.dev

---

**Once you add your key and restart the server, all AI extraction features will work! 🚀**

# 🚀 Deployment Checklist for Telangana Registration App

## ✅ Pre-Deployment Checklist

### 1. **Environment Variables**
- [ ] Get Google Gemini API key from https://ai.google.dev
- [ ] Test API key locally first
- [ ] Keep API key secure (never commit to Git)

### 2. **Code Verification**
- [ ] Run `npm install` - ensures all dependencies work
- [ ] Run `npm run build` - verify build succeeds
- [ ] Test locally with `npm start` - verify production build works
- [ ] Check http://localhost:3000/api/health - should return {"status":"ok"}

### 3. **Git Repository**
- [ ] Create `.gitignore` file (exclude node_modules, .env.local, dist)
- [ ] Initialize Git: `git init`
- [ ] Commit code: `git add . && git commit -m "Initial commit"`
- [ ] Create GitHub repository
- [ ] Push to GitHub: `git push -u origin main`

---

## 🎯 Option A: Deploy to Render.com (RECOMMENDED - FREE)

### Steps:
1. [ ] Go to https://render.com and sign up
2. [ ] Click **"New +"** → **"Web Service"**
3. [ ] Connect your GitHub account
4. [ ] Select your repository
5. [ ] Configure deployment:
   - **Name**: `telangana-registration`
   - **Region**: `Singapore` (closest to India)
   - **Branch**: `main`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
6. [ ] Add Environment Variables:
   - Key: `GEMINI_API_KEY`
   - Value: `your_actual_api_key_here`
7. [ ] Click **"Create Web Service"**
8. [ ] Wait 3-5 minutes for deployment

### Post-Deployment:
- [ ] Access your app at: `https://telangana-registration.onrender.com`
- [ ] Test all 9 steps of the wizard
- [ ] Upload test documents
- [ ] Verify AI extraction works
- [ ] Check audit report generation

### Notes:
- ⚠️ Free tier: App sleeps after 15 min inactivity (cold start ~30s)
- ✅ To prevent cold starts: Upgrade to Starter plan ($7/month)
- ✅ Custom domain supported (free SSL included)

---

## 🎯 Option B: Deploy to Railway.app (FREE $5 CREDIT)

### Steps:
1. [ ] Go to https://railway.app and sign up with GitHub
2. [ ] Click **"New Project"** → **"Deploy from GitHub repo"**
3. [ ] Select your repository
4. [ ] Railway auto-detects Node.js - no config needed!
5. [ ] Add Environment Variables:
   - Click **"Variables"** tab
   - Add `GEMINI_API_KEY` = `your_api_key`
6. [ ] Click **"Deploy"**
7. [ ] Wait 2-3 minutes

### Post-Deployment:
- [ ] Get public URL from Railway dashboard
- [ ] Test the application
- [ ] Monitor usage (you have $5 free credit = ~20-40 hours)

### Notes:
- ⚠️ $5 credit runs out after ~20-40 hours of runtime
- ✅ Upgrade to $5/month for always-on
- ✅ No cold starts (better than Render free tier)

---

## 🎯 Option C: Deploy to Vercel (100% FREE)

### Steps:
1. [ ] Ensure `vercel.json` exists in project root (already created)
2. [ ] Install Vercel CLI: `npm install -g vercel`
3. [ ] Login: `vercel login`
4. [ ] Deploy: `vercel`
5. [ ] Follow prompts:
   - Link to existing project? **N**
   - Project name? `telangana-registration`
   - Which directory? `./` (current)
6. [ ] Add environment variable:
   ```bash
   vercel env add GEMINI_API_KEY
   ```
   Paste your API key when prompted
7. [ ] Deploy to production: `vercel --prod`

### Post-Deployment:
- [ ] Access at: `https://telangana-registration.vercel.app`
- [ ] Test all features
- [ ] Monitor for file upload size issues (4.5MB limit on free tier)

### Notes:
- ⚠️ Serverless function timeout: 10 seconds (free tier)
- ⚠️ File uploads limited to 4.5MB
- ✅ Mumbai CDN edge = excellent India performance
- ✅ 100% free forever

---

## 🎯 Option D: Deploy to DigitalOcean (Bangalore - BEST LATENCY)

### Prerequisites:
- [ ] Create DigitalOcean account: https://digitalocean.com
- [ ] $6/month Droplet (1GB RAM, Bangalore datacenter)

### Steps:
1. [ ] Create Droplet:
   - **Image**: Ubuntu 22.04 LTS
   - **Plan**: Basic - $6/month (1GB RAM)
   - **Datacenter**: Bangalore, India
   - **SSH Key**: Add your SSH key
2. [ ] SSH into server:
   ```bash
   ssh root@your_droplet_ip
   ```
3. [ ] Install Node.js:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt-get install -y nodejs
   ```
4. [ ] Install PM2 (process manager):
   ```bash
   npm install -g pm2
   ```
5. [ ] Clone your repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/telangana-app.git
   cd telangana-app
   ```
6. [ ] Install dependencies:
   ```bash
   npm install
   ```
7. [ ] Build application:
   ```bash
   npm run build
   ```
8. [ ] Create `.env.local`:
   ```bash
   nano .env.local
   ```
   Add: `GEMINI_API_KEY=your_api_key_here`
   Save: `Ctrl+X`, `Y`, `Enter`
9. [ ] Start with PM2:
   ```bash
   pm2 start npm --name "telangana-app" -- start
   pm2 save
   pm2 startup
   ```
10. [ ] Setup Nginx (reverse proxy):
    ```bash
    apt-get install -y nginx
    nano /etc/nginx/sites-available/telangana-app
    ```
    Add:
    ```nginx
    server {
        listen 80;
        server_name your_domain_or_ip;
        
        location / {
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
        }
    }
    ```
    Enable site:
    ```bash
    ln -s /etc/nginx/sites-available/telangana-app /etc/nginx/sites-enabled/
    nginx -t
    systemctl restart nginx
    ```

### Post-Deployment:
- [ ] Access at: `http://your_droplet_ip`
- [ ] Test application
- [ ] Setup SSL with Let's Encrypt (optional):
   ```bash
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d your_domain.com
   ```

### Notes:
- ✅ **Best latency** for India users (<10ms)
- ✅ **Full control** over server
- ✅ **No cold starts**
- ✅ Can host multiple apps
- ⚠️ Requires server management knowledge

---

## 📊 Post-Deployment Testing Checklist

### Functional Testing:
- [ ] Homepage loads correctly
- [ ] Step 1: Property details form works
- [ ] Step 2: Executant/Claimant forms work
- [ ] Step 3: Registration form works
- [ ] Step 4: File upload works (test with sample docs)
- [ ] Step 5: AI extraction works
- [ ] Step 6: Template selection works
- [ ] Step 7: Auto-filled deed displays correctly
- [ ] Step 8: AI audit/verification works
- [ ] Step 9: Final review, print, download work
- [ ] Scenario presets load correctly
- [ ] Save to registry works (localStorage)
- [ ] Print functionality works
- [ ] Download .doc/.txt works
- [ ] Copy to clipboard works
- [ ] Bilingual text displays correctly (English + Telugu)

### Performance Testing:
- [ ] Page load time < 3 seconds
- [ ] API responses < 5 seconds
- [ ] File upload works for documents up to 10MB
- [ ] No console errors in browser DevTools
- [ ] Mobile responsive design works

### Security Testing:
- [ ] HTTPS enabled (SSL certificate)
- [ ] API key not exposed in browser
- [ ] File uploads sanitized
- [ ] No sensitive data in logs

---

## 🔧 Troubleshooting Common Issues

### Issue: Build Fails
**Solution:**
```bash
# Clear cache and rebuild
rm -rf node_modules dist
npm install
npm run build
```

### Issue: API Key Not Working
**Solution:**
- Verify key in platform's environment variables dashboard
- Check for extra spaces or quotes
- Restart the deployment

### Issue: Cold Starts Too Slow (Render Free Tier)
**Solution:**
- Use cron job to ping app every 14 minutes:
  ```bash
  # Add to cron-job.org or similar service
  curl https://your-app.onrender.com/api/health
  ```
- OR upgrade to Render Starter ($7/month) for always-on

### Issue: File Upload Fails (Vercel)
**Solution:**
- Reduce file size limit in code
- OR switch to Render/Railway (no file size limits)

### Issue: Slow Response Times
**Solution:**
- Check Gemini API latency
- Use DigitalOcean Bangalore for best India latency
- Enable caching for static assets

---

## 📈 Monitoring & Maintenance

### Daily:
- [ ] Check application is responding
- [ ] Monitor error logs

### Weekly:
- [ ] Review API usage (Gemini costs)
- [ ] Check storage usage
- [ ] Test core functionality

### Monthly:
- [ ] Review costs
- [ ] Update dependencies: `npm update`
- [ ] Backup registry data (if using database in future)
- [ ] Review and optimize performance

---

## 💰 Cost Tracking

### Current Setup:
- **Hosting**: ₹____/month
- **Gemini API**: ₹____/month
- **Domain**: ₹____/year (÷12 = ____/month)
- **SSL**: ₹0 (included free)
- **Total Monthly**: ₹____

### Optimization Tips:
- ✅ Use Gemini API free tier (15 requests/min)
- ✅ Cache common AI responses
- ✅ Compress uploaded documents before processing
- ✅ Use CDN for static assets (already included in platforms)

---

## 🎯 Success Criteria

Your deployment is successful when:
- ✅ App accessible via public URL
- ✅ All 9 steps work end-to-end
- ✅ AI extraction and verification functional
- ✅ Documents can be uploaded and processed
- ✅ Print and download features work
- ✅ Mobile responsive
- ✅ HTTPS enabled
- ✅ No console errors
- ✅ Page load time < 3 seconds
- ✅ API responses < 5 seconds

---

## 📞 Support Resources

- **Render Docs**: https://render.com/docs
- **Railway Docs**: https://docs.railway.app
- **Vercel Docs**: https://vercel.com/docs
- **DigitalOcean Docs**: https://docs.digitalocean.com
- **Gemini API Docs**: https://ai.google.dev/docs

---

## ✅ FINAL STEP

After successful deployment:
1. [ ] Share URL with test users
2. [ ] Gather feedback
3. [ ] Monitor for issues
4. [ ] Plan for scaling if needed
5. [ ] Consider custom domain for professional appearance

**Congratulations! Your app is now live! 🎉**

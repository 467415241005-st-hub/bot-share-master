require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { runCommentBot } = require('./lib/bot-engine');
const session = require('express-session');
const { PrismaSessionStore } = require('@quixo3/prisma-session-store');
const { runLinePersonalBot } = require('./lib/line-user-engine');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const axios = require('axios');

const app = express();
const prisma = global.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') {
    global.prisma = prisma;
}
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. CONFIG & MIDDLEWARE
// ==========================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

app.use(session({
    secret: 'bot-share-master-secret-key',
    resave: false,
    saveUninitialized: false,
    store: new PrismaSessionStore(prisma, {
        checkPeriod: 2 * 60 * 1000,
        dbRecordIdIsSessionId: true,
    }),
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

const isLogin = (req, res, next) => { if (req.session.userId) return next(); res.redirect('/login'); };

// ==========================================
// ⭐ 2. AUTHENTICATION (เข้าสู่ระบบ / ออกจากระบบ)
// ==========================================
app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/'); 
    res.render('login');
});

app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('register');
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await prisma.user.findFirst({ where: { username } });
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user.id;
            req.session.user = user;
            res.redirect('/');
        } else {
            res.send("<script>alert('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง!'); window.history.back();</script>");
        }
    } catch (error) {
        res.status(500).send("Login Error: " + error.message);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ==========================================
// ⭐ 3. ACCOUNT MANAGEMENT (จัดการบัญชีบอท)
// ==========================================
app.post('/api/facebook/add', isLogin, async (req, res) => {
    const { fbEmail, fbPassword, cookies } = req.body;
    try {
        await prisma.botAccount.create({
            data: { 
                userId: req.session.userId, 
                fbEmail, 
                fbPassword, 
                cookies: cookies || "[]" 
            }
        });
        res.redirect('/');
    } catch (error) {
        res.status(500).send("Error adding Facebook: " + error.message);
    }
});

app.post('/api/line/add', isLogin, async (req, res) => {
    const { groupName, loginType, lineEmail, linePassword, cookies } = req.body;
    try {
        await prisma.lineAccount.create({
            data: { 
                userId: req.session.userId, 
                groupName, 
                loginType: loginType || 'CREDENTIALS',
                lineEmail: lineEmail || null,
                linePassword: linePassword || null,
                cookies: cookies || "[]"
            }
        });
        res.redirect('/line');
    } catch (error) {
        res.status(500).send("Error adding LINE: " + error.message);
    }
});

app.delete('/api/line/delete/:id', isLogin, async (req, res) => {
    try {
        await prisma.lineAccount.delete({ where: { id: parseInt(req.params.id) } });
        res.send("OK");
    } catch (error) {
        res.status(500).send("Error deleting LINE");
    }
});

// ==========================================
// ⭐ 4. JOB MANAGEMENT (บันทึกงาน FB & LINE)
// ==========================================
app.post('/api/jobs/add', isLogin, async (req, res) => {
    const { accountId, message, runAt, repeat, mode, keyword, targetUrl } = req.body;
    try {
        let platform = 'FACEBOOK';
        let lineAccountId = null;
        let parsedAccountId = parseInt(accountId);

        if (req.headers.referer.includes('/line')) {
            platform = 'LINE';
            lineAccountId = parsedAccountId;
            parsedAccountId = null;
        }

        await prisma.jobQueue.create({
            data: {
                accountId: parsedAccountId,
                lineAccountId: lineAccountId,
                targetUrl: targetUrl || "",
                message: message,
                runAt: runAt ? new Date(runAt) : new Date(),
                repeat: parseInt(repeat) || 1,
                mode: mode || 'SCHEDULE',
                keyword: keyword || null,
                status: 'PENDING',
                platform: platform 
            }
        });
        res.redirect(platform === 'LINE' ? '/line' : '/');
    } catch (error) {
        res.status(500).send("Error: " + error.message);
    }
});

// ==========================================
// ⭐ 5. CRON & EXECUTION (ระบบรันอัตโนมัติ / ส่งด่วน)
// ==========================================
app.get('/api/cron/worker', async (req, res) => {
    const now = new Date();

    const pendingFbJobs = await prisma.jobQueue.findMany({
        where: { status: "PENDING", runAt: { lte: now }, platform: "FACEBOOK" },
        include: { account: true }
    });
    for (const job of pendingFbJobs) {
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: "RUNNING" } });
        const result = await runCommentBot(job);
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: result } });
    }

    const pendingLineJobs = await prisma.jobQueue.findMany({
        where: { status: "PENDING", runAt: { lte: now }, platform: "LINE" },
        include: { lineAccount: true }
    });
    for (const job of pendingLineJobs) {
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: "RUNNING" } });
        const result = await runLinePersonalBot(job);
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: result } });
    }

    res.json({ processed_fb: pendingFbJobs.length, processed_line: pendingLineJobs.length });
});

app.post('/api/facebook/send-now', isLogin, async (req, res) => {
    const { accountId, targetUrl, message, repeat } = req.body;
    try {
        const job = await prisma.jobQueue.create({
            data: {
                accountId: parseInt(accountId),
                targetUrl,
                message,
                runAt: new Date(),
                status: "RUNNING",
                repeat: parseInt(repeat) || 1,
                platform: "FACEBOOK"
            },
            include: { account: true }
        });
        const result = await runCommentBot(job);
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: result === 'SUCCESS' ? "SUCCESS" : "FAILED" } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/jobs/send-now', isLogin, async (req, res) => {
    const { accountId, message, repeat, targetUrl } = req.body;
    try {
        const job = await prisma.jobQueue.create({
            data: {
                lineAccountId: parseInt(accountId),
                targetUrl: targetUrl || "", 
                message: message,
                runAt: new Date(),
                status: "RUNNING",
                repeat: parseInt(repeat) || 1,
                platform: "LINE"
            },
            include: { lineAccount: true }
        });
        
        const result = await runLinePersonalBot(job);
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: result === 'SUCCESS' ? "SUCCESS" : "FAILED" } });
        
        res.redirect('/line?success=true');
    } catch (error) {
        res.status(500).send("ส่งไม่สำเร็จ: " + error.message);
    }
});

// 1. API ลบบัญชี Facebook
app.delete('/api/facebook/delete/:id', isLogin, async (req, res) => {
    try {
        await prisma.botAccount.delete({ where: { id: parseInt(req.params.id) } });
        res.send("OK");
    } catch (error) {
        res.status(500).send("Error deleting Facebook account");
    }
});

// 2. API ล้างประวัติการทำงานของ Facebook
app.delete('/api/jobs/clear/facebook', isLogin, async (req, res) => {
    try {
        const accounts = await prisma.botAccount.findMany({ where: { userId: req.session.userId } });
        const accountIds = accounts.map(acc => acc.id);
        
        await prisma.jobQueue.deleteMany({
            where: { accountId: { in: accountIds }, platform: 'FACEBOOK' }
        });
        res.send("OK");
    } catch (error) {
        res.status(500).send("Error clearing history");
    }
});

// 3. API ล้างประวัติการทำงานของ LINE
app.delete('/api/jobs/clear/line', isLogin, async (req, res) => {
    try {
        const lineAccounts = await prisma.lineAccount.findMany({ where: { userId: req.session.userId } });
        const lineAccountIds = lineAccounts.map(acc => acc.id);
        
        await prisma.jobQueue.deleteMany({
            where: { lineAccountId: { in: lineAccountIds }, platform: 'LINE' }
        });
        res.send("OK");
    } catch (error) {
        res.status(500).send("Error clearing LINE history");
    }
});


// ==========================================
// ⭐ 6. ROUTES
// ==========================================
app.get('/line', isLogin, async (req, res) => {
    const lineAccounts = await prisma.lineAccount.findMany({ where: { userId: req.session.userId } });
    const accountIds = lineAccounts.map(acc => acc.id); 
    
    const jobs = await prisma.jobQueue.findMany({ 
        where: { lineAccountId: { in: accountIds }, platform: 'LINE' }, 
        orderBy: { id: 'desc' }, 
        take: 10 
    }) || [];
    res.render('line_dashboard', { lineAccounts, jobs, page: 'line' });
});

app.get('/packages', isLogin, (req, res) => res.render('packages', { page: 'packages' }));
app.get('/guide', isLogin, (req, res) => res.render('guide', { page: 'guide' }));
app.get('/topup', isLogin, (req, res) => res.render('topup', { page: 'topup' }));
app.get('/history', isLogin, async (req, res) => {
    const payments = await prisma.payment.findMany({ 
        where: { userId: req.session.userId }, 
        orderBy: { id: 'desc' } 
    });
    res.render('history', { payments, page: 'history' });
});

app.get('/home', isLogin, (req, res) => {
    res.render('home', { page: 'home', user: req.session.user });
});

// Route หน้าหลัก (บอทเฟส)
app.get('/', isLogin, async (req, res) => {
    try {
        const accounts = await prisma.botAccount.findMany({ 
            where: { userId: req.session.userId } 
        });
        const accountIds = accounts.map(acc => acc.id);
        
        const jobs = await prisma.jobQueue.findMany({ 
            where: { 
                accountId: { in: accountIds },
                platform: 'FACEBOOK'
            }, 
            orderBy: { id: 'desc' }, 
            take: 10 
        }) || [];

        res.render('index', { 
            accounts: accounts || [], 
            jobs: jobs, 
            page: 'facebook', 
            user: req.session.user || {} 
        });
    } catch (error) {
        console.error("Error at / route:", error);
        res.status(500).send("เกิดข้อผิดพลาดในการโหลดข้อมูล: " + error.message);
    }
});

// ล้างประวัติ Facebook
app.delete('/api/jobs/clear/facebook', isLogin, async (req, res) => {
    try {
        const accounts = await prisma.botAccount.findMany({ where: { userId: req.session.userId } });
        const accountIds = accounts.map(acc => acc.id);
        await prisma.jobQueue.deleteMany({
            where: { accountId: { in: accountIds }, platform: 'FACEBOOK' }
        });
        res.status(200).send("OK"); // ตรวจสอบว่าส่งสถานะ 200 กลับมา
    } catch (error) {
        console.error(error);
        res.status(500).send("Error");
    }
});

// ล้างประวัติ LINE
app.delete('/api/jobs/clear/line', isLogin, async (req, res) => {
    try {
        const lineAccounts = await prisma.lineAccount.findMany({ where: { userId: req.session.userId } });
        const lineAccountIds = lineAccounts.map(acc => acc.id);
        await prisma.jobQueue.deleteMany({
            where: { lineAccountId: { in: lineAccountIds }, platform: 'LINE' }
        });
        res.status(200).send("OK");
    } catch (error) {
        console.error(error);
        res.status(500).send("Error");
    }
});

app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));
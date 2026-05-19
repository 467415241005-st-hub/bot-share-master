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
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await prisma.user.findFirst({ where: { username } });
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user.id;
            req.session.user = user;
            res.redirect('/line');
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
// ⭐ 3. ACCOUNT MANAGEMENT (จัดการกลุ่ม LINE)
// ==========================================
app.post('/api/line/add', isLogin, async (req, res) => {
    const { groupName, cookies } = req.body;
    try {
        await prisma.lineAccount.create({
            data: { 
                userId: req.session.userId, 
                groupName, 
                loginType: 'COOKIE',
                cookies: cookies || null
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

        // ถ้าเลือกบัญชีจากหน้า LINE
        if (req.headers.referer.includes('/line')) {
            platform = 'LINE';
            lineAccountId = parsedAccountId;
            parsedAccountId = null;
        }

        await prisma.jobQueue.create({
            data: {
                accountId: parsedAccountId,
                lineAccountId: lineAccountId, // ✨ ผูกกับบัญชีไลน์ส่วนตัว
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

    // 1. ประมวลผลงาน Facebook
    const pendingFbJobs = await prisma.jobQueue.findMany({
        where: { status: "PENDING", runAt: { lte: now }, platform: "FACEBOOK" },
        include: { account: true }
    });
    for (const job of pendingFbJobs) {
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: "RUNNING" } });
        const result = await runCommentBot(job);
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: result } });
    }

    // 2. ประมวลผลงาน LINE (บัญชีส่วนตัวผ่าน Playwright)
    const pendingLineJobs = await prisma.jobQueue.findMany({
        where: { status: "PENDING", runAt: { lte: now }, platform: "LINE" },
        include: { lineAccount: true }
    });
    for (const job of pendingLineJobs) {
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: "RUNNING" } });
        const result = await runLinePersonalBot(job); // เรียกใช้บอท Playwright
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
                repeat: parseInt(repeat) || 1
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
        // สร้างงานด่วนและสั่งบอท Playwright รันทันที
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

// ✨ อัปเดตหน้า LINE (ใช้เฉพาะบัญชีส่วนตัว)
app.get('/line', isLogin, async (req, res) => {
    const lineAccounts = await prisma.lineAccount.findMany({ where: { userId: req.session.userId } });
    const accountIds = lineAccounts.map(acc => acc.id); 
    
    const jobs = await prisma.jobQueue.findMany({ 
        where: { lineAccountId: { in: accountIds }, platform: 'LINE' }, 
        orderBy: { id: 'desc' }, 
        take: 10 
    });
    res.render('line_dashboard', { lineAccounts, jobs, page: 'line' });
});

// ✨ เปิดเส้นทางใหม่ (ลบหน้า add-bot ออกแล้ว)
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

app.get('/login', (req, res) => res.render('login'));

app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));
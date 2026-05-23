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
        dbRecordIdFunction: undefined,
    }),
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Middleware ตรวจสอบการล็อกอิน
const isLogin = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    }
    res.redirect('/login');
};

// ==========================================
// 2. AUTH & PAGES ROUTES
// ==========================================
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user.id;
        req.session.user = user;
        return res.redirect('/');
    }
    res.render('login', { error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

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
    res.render('home', { page: 'home', user: req.session.user || {} });
});

// หน้าหลัก Facebook Dashboard
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

// หน้าแดชบอร์ด LINE
app.get('/line', isLogin, async (req, res) => {
    try {
        const lineAccounts = await prisma.lineAccount.findMany({
            where: { userId: req.session.userId }
        });
        const lineAccountIds = lineAccounts.map(acc => acc.id);

        const jobs = await prisma.jobQueue.findMany({
            where: {
                lineAccountId: { in: lineAccountIds },
                platform: 'LINE'
            },
            orderBy: { id: 'desc' },
            take: 10
        }) || [];

        res.render('line_dashboard', {
            lineAccounts: lineAccounts || [],
            jobs: jobs,
            page: 'line',
            user: req.session.user || {}
        });
    } catch (error) {
        console.error(error);
        res.status(500).send("Error loading LINE dashboard");
    }
});

// ==========================================
// 3. FACEBOOK & LINE API ACTIONS
// ==========================================
app.post('/api/facebook/add', isLogin, async (req, res) => {
    const { fbEmail, fbPassword, cookies } = req.body;
    try {
        await prisma.botAccount.create({
            data: { fbEmail, fbPassword, cookies: cookies || "[]", userId: req.session.userId }
        });
        res.redirect('/');
    } catch (err) {
        res.status(500).send("Error adding Facebook account");
    }
});

app.delete('/api/facebook/delete/:id', isLogin, async (req, res) => {
    try {
        await prisma.botAccount.delete({ where: { id: parseInt(req.params.id) } });
        res.send("OK");
    } catch (error) {
        res.status(500).send("Error deleting Facebook account");
    }
});

app.post('/api/jobs/add', isLogin, async (req, res) => {
    const { accountId, targetUrl, message, mode, keyword, repeat } = req.body;
    try {
        await prisma.jobQueue.create({
            data: {
                targetUrl,
                message,
                mode: mode || 'SCHEDULE',
                keyword: keyword || '',
                repeat: parseInt(repeat) || 1,
                platform: 'FACEBOOK',
                accountId: parseInt(accountId)
            }
        });
        res.redirect('/');
    } catch (err) {
        res.status(500).send("Error creating schedule job");
    }
});

app.post('/api/facebook/send-now', isLogin, async (req, res) => {
    const { accountId, targetUrl, message, repeat } = req.body;
    try {
        const account = await prisma.botAccount.findUnique({ where: { id: parseInt(accountId) } });
        if (!account) return res.status(404).json({ error: "ไม่พบข้อมูลบัญชีบอท" });

        // สร้าง Job ในระบบด้วยสถานะ RUNNING ทันที
        const job = await prisma.jobQueue.create({
            data: {
                targetUrl,
                message,
                mode: 'IMMEDIATE',
                repeat: parseInt(repeat) || 1,
                platform: 'FACEBOOK',
                accountId: account.id,
                status: 'RUNNING'
            },
            include: { account: true }
        });

        // สั่งทำงานบอทแบบ Asynchronous (เบื้องหลัง) ไม่ต้องให้หน้าเว็บค้างรอโหลด
        runCommentBot(job).then(async (finalStatus) => {
            await prisma.jobQueue.update({
                where: { id: job.id },
                data: { status: finalStatus }
            });
        }).catch(async (err) => {
            console.error(err);
            await prisma.jobQueue.update({
                where: { id: job.id },
                data: { status: 'FAILED' }
            });
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/jobs/clear/facebook', isLogin, async (req, res) => {
    try {
        const accounts = await prisma.botAccount.findMany({ where: { userId: req.session.userId } });
        const accountIds = accounts.map(acc => acc.id);
        await prisma.jobQueue.deleteMany({
            where: { accountId: { in: accountIds }, platform: 'FACEBOOK' }
        });
        res.status(200).send("OK");
    } catch (error) {
        res.status(500).send("Error clearing Facebook history");
    }
});

// LINE API ACTIONS
app.post('/api/line/add', isLogin, async (req, res) => {
    const { groupName, loginType, lineEmail, linePassword, cookies } = req.body;
    try {
        await prisma.lineAccount.create({
            data: {
                groupName,
                loginType: loginType || 'COOKIE',
                lineEmail: lineEmail || '',
                linePassword: linePassword || '',
                cookies: cookies || '[]',
                userId: req.session.userId
            }
        });
        res.redirect('/line');
    } catch (err) {
        res.status(500).send("Error adding LINE group configuration");
    }
});

app.delete('/api/line/delete/:id', isLogin, async (req, res) => {
    try {
        await prisma.lineAccount.delete({ where: { id: parseInt(req.params.id) } });
        res.send("OK");
    } catch (error) {
        res.status(500).send("Error deleting LINE account");
    }
});

app.post('/api/line/send-now', isLogin, async (req, res) => {
    const { lineAccountId, targetUrl, message, repeat } = req.body;
    try {
        const job = await prisma.jobQueue.create({
            data: {
                targetUrl,
                message,
                mode: 'IMMEDIATE',
                repeat: parseInt(repeat) || 1,
                platform: 'LINE',
                lineAccountId: parseInt(lineAccountId),
                status: 'RUNNING'
            }
        });

        runLinePersonalBot(job).then(async (finalStatus) => {
            await prisma.jobQueue.update({
                where: { id: job.id },
                data: { status: finalStatus }
            });
        }).catch(async () => {
            await prisma.jobQueue.update({
                where: { id: job.id },
                data: { status: 'FAILED' }
            });
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/jobs/clear/line', isLogin, async (req, res) => {
    try {
        const lineAccounts = await prisma.lineAccount.findMany({ where: { userId: req.session.userId } });
        const lineAccountIds = lineAccounts.map(acc => acc.id);
        await prisma.jobQueue.deleteMany({
            where: { lineAccountId: { in: lineAccountIds }, platform: 'LINE' }
        });
        res.status(200).send("OK");
    } catch (error) {
        res.status(500).send("Error clearing LINE history");
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
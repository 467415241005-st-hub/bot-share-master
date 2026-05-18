require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { runCommentBot } = require('./lib/bot-engine');
const session = require('express-session');
const { PrismaSessionStore } = require('@quixo3/prisma-session-store');
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
    const { groupName, groupId, groupUrl } = req.body;
    try {
        await prisma.lineAccount.create({
            data: { 
                userId: req.session.userId, 
                groupName, 
                groupId, 
                groupUrl: groupUrl || "" 
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
        let finalTargetUrl = targetUrl;
        let platform = 'FACEBOOK';
        let parsedAccountId = parseInt(accountId);

        // ถ้าไม่มี targetUrl ส่งมา แปลว่าสั่งงานมาจากหน้า LINE
        if (!targetUrl && accountId) {
            const lineAcc = await prisma.lineAccount.findUnique({ where: { id: parseInt(accountId) } });
            if (lineAcc) {
                finalTargetUrl = lineAcc.groupId;
                platform = 'LINE';
                parsedAccountId = null; // ✨ ไม่ต้องผูกกับบัญชีเฟสบุ๊ก
            }
        }

        await prisma.jobQueue.create({
            data: {
                accountId: parsedAccountId,
                targetUrl: finalTargetUrl || "",
                message: message,
                runAt: runAt ? new Date(runAt) : new Date(),
                repeat: parseInt(repeat) || 1,
                mode: mode || 'SCHEDULE',
                keyword: keyword || null,
                status: 'PENDING',
                platform: platform 
            }
        });

        // ✨ ระบุหน้าเว็บให้ชัดเจน ป้องกันเบราว์เซอร์หลงทาง
        if (platform === 'LINE') {
            res.redirect('/line');
        } else {
            res.redirect('/');
        }

    } catch (error) {
        res.status(500).send("Error adding job: " + error.message);
    }
});

// ==========================================
// ⭐ 5. CRON & EXECUTION (ระบบรันอัตโนมัติ / ส่งด่วน)
// ==========================================
app.get('/api/cron/worker', async (req, res) => {
    const now = new Date();
    const pendingJobs = await prisma.jobQueue.findMany({
        where: { 
            status: "PENDING", 
            runAt: { lte: now },
            platform: "FACEBOOK" // ✨ สั่งให้บอทเฟส รันเฉพาะงานของเฟสบุ๊กเท่านั้น
        },
        include: { account: true }
    });

    for (const job of pendingJobs) {
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: "RUNNING" } });
        const result = await runCommentBot(job);
        
        if (result === 'WAITING') {
            await prisma.jobQueue.update({ where: { id: job.id }, data: { status: "PENDING" } });
        } else {
            await prisma.jobQueue.update({ where: { id: job.id }, data: { status: result } });
        }
    }
    res.json({ processed: pendingJobs.length });
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
    const { accountId, message, repeat } = req.body;
    try {
        const acc = await prisma.lineAccount.findUnique({ where: { id: parseInt(accountId) } });
        if (!acc) return res.status(404).send("ไม่พบกลุ่มไลน์");
        
        const repeatCount = parseInt(repeat) || 1;
        for (let i = 0; i < repeatCount; i++) {
            await axios.post('https://api.line.me/v2/bot/message/push', {
                to: acc.groupId, messages: [{ type: 'text', text: message }]
            }, { headers: { 'Authorization': `Bearer ${process.env.LINE_ACCESS_TOKEN}` } });
            
            if (i < repeatCount - 1) await new Promise(r => setTimeout(r, 1500));
        }
        res.redirect('/line?success=true');
    } catch (error) {
        res.status(500).send("ส่งไม่สำเร็จ: " + error.message);
    }
});

// ==========================================
// ⭐ 6. LINE WEBHOOK (จับคีย์เวิร์ดหลังเรท)
// ==========================================
app.post('/webhook', async (req, res) => {
    res.status(200).send("OK");
    const events = req.body.events;
    if (!events) return;

    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text.trim();
            const groupId = event.source.groupId;

            if (text === '/getid') {
                const targetId = groupId || event.source.userId;
                await axios.post('https://api.line.me/v2/bot/message/reply', {
                    replyToken: event.replyToken,
                    messages: [{ type: 'text', text: `ID ของกลุ่มนี้คือ:\n${targetId}` }]
                }, { headers: { 'Authorization': `Bearer ${process.env.LINE_ACCESS_TOKEN}` } });
            } 
            else if (groupId) {
                const jobs = await prisma.jobQueue.findMany({
                    where: { status: 'PENDING', mode: 'KEYWORD', targetUrl: groupId }
                });
                for (const job of jobs) {
                    if (text.includes(job.keyword)) {
                        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: 'RUNNING' } });
                        const repeatCount = parseInt(job.repeat) || 1;
                        for (let i = 0; i < repeatCount; i++) {
                            await axios.post('https://api.line.me/v2/bot/message/push', {
                                to: groupId, messages: [{ type: 'text', text: job.message }]
                            }, { headers: { 'Authorization': `Bearer ${process.env.LINE_ACCESS_TOKEN}` } });
                            if (i < repeatCount - 1) await new Promise(r => setTimeout(r, 1500));
                        }
                        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: 'SUCCESS' } });
                    }
                }
            }
        }
    }
});

// ==========================================
// ⭐ 7. VIEWS / PAGES (หน้าเว็บทั้งหมด)
// ==========================================
app.get('/', isLogin, async (req, res) => {
    const accounts = await prisma.botAccount.findMany({ where: { userId: req.session.userId } });
    const jobs = await prisma.jobQueue.findMany({ where: { account: { userId: req.session.userId } }, orderBy: { id: 'desc' }, take: 10, include: { account: true } });
    res.render('index', { accounts, jobs, page: 'facebook' });
});

app.get('/line', isLogin, async (req, res) => {
    const lineAccounts = await prisma.lineAccount.findMany({ where: { userId: req.session.userId } });
    res.render('line_dashboard', { lineAccounts, page: 'line' });
});

app.get('/add-bot', isLogin, (req, res) => res.render('add_bot', { page: 'add-bot' }));
app.get('/login', (req, res) => res.render('login'));
app.get('/home', isLogin, (req, res) => res.render('home', { page: 'home' }));

app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));
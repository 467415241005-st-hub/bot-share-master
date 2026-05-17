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

// 1. CONFIG & MIDDLEWARE
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

// 2. CRON WORKER (สำหรับรันงานตั้งเวลาและหลังเรท FB)
app.get('/api/cron/worker', async (req, res) => {
    const now = new Date();
    const pendingJobs = await prisma.jobQueue.findMany({
        where: { status: "PENDING", runAt: { lte: now } },
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

// 3. FACEBOOK API
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

// 4. LINE API (Webhook ดักคีย์เวิร์ดหลังเรท)
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
            // ⭐ ระบบจองหลังเรท LINE
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

// 5. LINE API (ส่งทันทีแบบวนลูป)
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

// --- ROUTES อื่นๆ ---
app.get('/', isLogin, async (req, res) => {
    const accounts = await prisma.botAccount.findMany({ where: { userId: req.session.userId } });
    const jobs = await prisma.jobQueue.findMany({ where: { account: { userId: req.session.userId } }, orderBy: { id: 'desc' }, take: 10, include: { account: true } });
    res.render('index', { accounts, jobs, page: 'facebook' });
});
app.get('/line', isLogin, async (req, res) => {
    const lineAccounts = await prisma.lineAccount.findMany({ where: { userId: req.session.userId } });
    res.render('line_dashboard', { lineAccounts, page: 'line' });
});
app.get('/login', (req, res) => res.render('login'));
app.get('/home', isLogin, (req, res) => res.render('home', { page: 'home' }));

app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));
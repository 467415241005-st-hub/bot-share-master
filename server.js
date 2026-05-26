require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { runCommentBot } = require('./lib/bot-engine');
const { runLinePersonalBot } = require('./lib/line-user-engine');
const session = require('express-session');
const { PrismaSessionStore } = require('@quixo3/prisma-session-store');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const prisma = global.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') global.prisma = prisma;
const PORT = process.env.PORT || 80;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'welloff-platform-secret',
    resave: false,
    saveUninitialized: false,
    store: new PrismaSessionStore(prisma, {
        checkPeriod: 2 * 60 * 1000,
        dbRecordIdIsSessionId: true,
    }),
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// --- Middleware ---
const isLogin = async (req, res, next) => {
    if (req.session && req.session.userId) {
        // อัปเดตข้อมูล user ล่าสุดเสมอ
        req.session.user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        return next();
    }
    res.redirect('/login');
};

// --- Auth Routes ---
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user.id;
        return res.redirect('/');
    }
    res.render('login', { error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// --- Dashboard Routes ---
app.get('/', isLogin, async (req, res) => {
    const accounts = await prisma.botAccount.findMany({ where: { userId: req.session.userId } });
    const jobs = await prisma.jobQueue.findMany({ 
        where: { accountId: { in: accounts.map(a => a.id) }, platform: 'FACEBOOK' }, 
        orderBy: { id: 'desc' }, take: 15 
    });
    res.render('index', { accounts, jobs, page: 'facebook', user: req.session.user });
});

app.get('/line', isLogin, async (req, res) => {
    const lineAccounts = await prisma.lineAccount.findMany({ where: { userId: req.session.userId } });
    const jobs = await prisma.jobQueue.findMany({
        where: { lineAccountId: { in: lineAccounts.map(a => a.id) }, platform: 'LINE' },
        orderBy: { id: 'desc' }, take: 15
    });
    res.render('line_dashboard', { lineAccounts, jobs, page: 'line', user: req.session.user });
});

// --- API จัดการบัญชี (เช็คโควตา) ---
app.post('/api/facebook/add', isLogin, async (req, res) => {
    const { fbEmail, fbPassword } = req.body;
    const user = req.session.user;
    const limit = user.packageStatus === 'PAID' ? 2 : 1;
    
    const count = await prisma.botAccount.count({ where: { userId: user.id } });
    if (count >= limit) return res.send(`<script>alert('โควตา Facebook ของคุณเต็มแล้ว (สูงสุด ${limit} บัญชี)'); window.location.href='/';</script>`);

    await prisma.botAccount.create({ data: { fbEmail, fbPassword, cookies: "[]", userId: user.id } });
    res.redirect('/');
});

app.post('/api/line/add', isLogin, async (req, res) => {
    const { groupName, lineEmail, linePassword } = req.body;
    const user = req.session.user;
    const limit = user.packageStatus === 'PAID' ? 2 : 1;
    
    const count = await prisma.lineAccount.count({ where: { userId: user.id } });
    if (count >= limit) return res.send(`<script>alert('โควตา LINE ของคุณเต็มแล้ว (สูงสุด ${limit} บัญชี)'); window.location.href='/line';</script>`);

    await prisma.lineAccount.create({ data: { groupName, lineEmail, linePassword, userId: user.id } });
    res.redirect('/line');
});

// --- API ส่งงาน (ครอบคลุม ด่วน, ตั้งเวลา, คีย์เวิร์ด) ---
app.post('/api/jobs/send', isLogin, async (req, res) => {
    const { platform, accountId, targetUrl, message, repeat, mode, scheduleTime, keyword } = req.body;
    
    let runAt = new Date();
    if (mode === 'SCHEDULE' && scheduleTime) runAt = new Date(scheduleTime);

    try {
        const jobData = {
            targetUrl, message, repeat: parseInt(repeat) || 1, platform,
            mode: mode || 'IMMEDIATE', keyword: keyword || null, runAt,
            status: mode === 'IMMEDIATE' ? 'RUNNING' : 'PENDING'
        };

        if (platform === 'FACEBOOK') jobData.accountId = parseInt(accountId);
        if (platform === 'LINE') jobData.lineAccountId = parseInt(accountId);

        const job = await prisma.jobQueue.create({ data: jobData, include: { account: true, lineAccount: true } });

        // ถ้ายิงด่วน ให้รันทันที
        if (mode === 'IMMEDIATE') {
            const engine = platform === 'FACEBOOK' ? runCommentBot : runLinePersonalBot;
            engine(job).then(async (status) => {
                await prisma.jobQueue.update({ where: { id: job.id }, data: { status } });
            }).catch(async () => {
                await prisma.jobQueue.update({ where: { id: job.id }, data: { status: 'FAILED' } });
            });
        }
        res.json({ success: true, message: 'บันทึกคำสั่งงานเรียบร้อย' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- ระบบล้างประวัติ (Clear) ---
app.delete('/api/jobs/clear/:platform', isLogin, async (req, res) => {
    const platform = req.params.platform.toUpperCase();
    if(platform === 'FACEBOOK') {
        const accs = await prisma.botAccount.findMany({ where: { userId: req.session.userId } });
        await prisma.jobQueue.deleteMany({ where: { accountId: { in: accs.map(a=>a.id) } } });
    } else {
        const accs = await prisma.lineAccount.findMany({ where: { userId: req.session.userId } });
        await prisma.jobQueue.deleteMany({ where: { lineAccountId: { in: accs.map(a=>a.id) } } });
    }
    res.send("OK");
});

// ==========================================
// BACKGROUND WORKER (รันงานอัตโนมัติ)
// ==========================================
setInterval(async () => {
    try {
        const now = new Date();
        // หางานตั้งเวลาที่ถึงเวลาแล้ว
        const pendingJobs = await prisma.jobQueue.findMany({
            where: { status: 'PENDING', mode: { in: ['SCHEDULE', 'KEYWORD'] }, runAt: { lte: now } },
            include: { account: true, lineAccount: true }
        });

        for (const job of pendingJobs) {
            // ล็อกสถานะป้องกันการรันซ้ำ
            await prisma.jobQueue.update({ where: { id: job.id }, data: { status: 'RUNNING' } });
            
            const engine = job.platform === 'FACEBOOK' ? runCommentBot : runLinePersonalBot;
            engine(job).then(async (status) => {
                // ถ้าเป็น Keyword แล้วไม่เจอคำ ให้กลับไป PENDING รอเช็คใหม่รอบหน้า
                if (job.mode === 'KEYWORD' && status === 'NOT_FOUND') {
                    await prisma.jobQueue.update({ where: { id: job.id }, data: { status: 'PENDING', runAt: new Date(Date.now() + 60000) } });
                } else {
                    await prisma.jobQueue.update({ where: { id: job.id }, data: { status } });
                }
            }).catch(async () => {
                await prisma.jobQueue.update({ where: { id: job.id }, data: { status: 'FAILED' } });
            });
        }
    } catch (err) { console.error("Worker Error:", err); }
}, 60000); // เช็คทุกๆ 1 นาที

app.listen(PORT, () => { console.log(`✅ Welloff Platform running on port ${PORT}`); });
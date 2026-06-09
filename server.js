require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { runCommentBot } = require('./lib/bot-engine');
const { runLinePersonalBot, syncLineGroups } = require('./lib/line-user-engine');
const session = require('express-session');
const { PrismaSessionStore } = require('@quixo3/prisma-session-store');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// --- Multer สำหรับ upload สลิป ---
const slipStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public/uploads/slips');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `slip-${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage: slipStorage, limits: { fileSize: 10 * 1024 * 1024 } });

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
app.get('/register', (req, res) => res.render('register'));
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const exists = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
        if (exists) return res.send(`<script>alert('ชื่อผู้ใช้หรืออีเมลนี้ถูกใช้งานแล้ว'); window.location.href='/register';</script>`);
        const hashed = await bcrypt.hash(password, 10);
        await prisma.user.create({ data: { username, email, password: hashed } });
        res.redirect('/login');
    } catch (err) {
        res.send(`<script>alert('เกิดข้อผิดพลาด: ${err.message}'); window.location.href='/register';</script>`);
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
const isAdmin = async (req, res, next) => {
    if (req.session && req.session.userId) {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        if (user && (user.role === 'admin' || user.role === 'ADMIN')) {
            req.session.user = user;
            return next();
        }
    }
    res.status(403).send('<script>alert("Access Denied"); window.location.href="/";</script>');
};

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
            }).catch(async (err) => {
                console.error("Job Failed:", err);
                await prisma.jobQueue.update({ where: { id: job.id }, data: { status: 'FAILED' } });
            });
        }
        res.json({ success: true, message: 'บันทึกคำสั่งงานเรียบร้อย' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- เพิ่ม API ดึงกลุ่มเป้าหมาย ---
app.post('/api/line/sync', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    
    const { accountId } = req.body;
    try {
        const account = await prisma.lineAccount.findUnique({ where: { id: parseInt(accountId) } });
        if (!account) return res.json({ success: false, error: 'ไม่พบบัญชี' });

        const result = await syncLineGroups(account); // เรียกบอทไปดึงกลุ่ม
        
        if (result.success) {
            // เซฟกลุ่มที่ดึงได้ลง Database
            await prisma.lineAccount.update({
                where: { id: account.id },
                data: { fetchedGroups: JSON.stringify(result.groups) }
            });
            res.json({ success: true, groups: result.groups });
        } else {
            res.json({ success: false, error: result.error });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
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

// --- หน้าเพจอื่นๆ (เพิ่มตรงนี้เพื่อแก้ Cannot GET) ---
app.get('/home', isLogin, (req, res) => res.render('home', { user: req.session.user, page: 'home' }));
app.get('/packages', isLogin, (req, res) => res.render('packages', { user: req.session.user, page: 'packages' }));
app.get('/guide', isLogin, (req, res) => res.render('guide', { user: req.session.user, page: 'guide' }));
app.get('/topup', isLogin, (req, res) => res.render('topup', { user: req.session.user, page: 'topup' }));

// หน้าประวัติเติมเงิน (ต้องดึงข้อมูล Payments จาก DB มาโชว์ด้วย)
app.get('/history', isLogin, async (req, res) => {
    const payments = await prisma.payment.findMany({ 
        where: { userId: req.session.userId }, 
        orderBy: { createdAt: 'desc' } 
    });
    res.render('history', { user: req.session.user, payments, page: 'history' });
});

// ==========================================
// TOPUP — อัปโหลดสลิปเพื่อแจ้งเติมเครดิต
// ==========================================
app.post('/api/topup', isLogin, upload.single('slip'), async (req, res) => {
    try {
        const { amount } = req.body;
        if (!req.file) return res.send(`<script>alert('กรุณาแนบสลิป'); history.back();</script>`);
        const slipUrl = `/uploads/slips/${req.file.filename}`;
        await prisma.payment.create({
            data: { amount: parseFloat(amount), slipUrl, userId: req.session.userId, status: 'PENDING' }
        });
        res.send(`<script>alert('แจ้งเติมเครดิตสำเร็จ! กรุณารอการอนุมัติจาก Admin'); window.location.href='/history';</script>`);
    } catch (e) {
        res.send(`<script>alert('เกิดข้อผิดพลาด: ${e.message}'); history.back();</script>`);
    }
});

// ==========================================
// PACKAGES — ซื้อแพ็คเกจหักเครดิต
// ==========================================
app.post('/api/packages/buy', isLogin, async (req, res) => {
    const { planName, price } = req.body;
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        if (user.credits < price) return res.json({ success: false, error: 'เครดิตไม่เพียงพอ กรุณาเติมเครดิตก่อน' });
        await prisma.user.update({
            where: { id: req.session.userId },
            data: { credits: { decrement: price }, packageStatus: 'PAID' }
        });
        res.json({ success: true, message: `ซื้อแพ็คเกจ ${planName} สำเร็จ` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// ADMIN ROUTES
// ==========================================
app.get('/admin/payments', isAdmin, async (req, res) => {
    const payments = await prisma.payment.findMany({
        where: { status: 'PENDING' },
        include: { user: true },
        orderBy: { createdAt: 'asc' }
    });
    res.render('admin_payments', { user: req.session.user, payments, page: 'admin' });
});

app.post('/api/admin/payments/approve', isAdmin, async (req, res) => {
    const { paymentId } = req.body;
    try {
        const payment = await prisma.payment.findUnique({ where: { id: parseInt(paymentId) } });
        if (!payment) return res.status(404).json({ error: 'ไม่พบรายการ' });
        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'APPROVED' } });
        await prisma.user.update({
            where: { id: payment.userId },
            data: { credits: { increment: payment.amount } }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// LOTTERY — ระบบรายงานผลหวย
// ==========================================

// ตัวแปร in-memory สำหรับเก็บประวัติผลหวย (per user session)
const lotteryHistoryStore = {};

app.get('/lottery', isLogin, (req, res) => {
    const lineAccounts = [];
    // ดึง line accounts ของ user
    prisma.lineAccount.findMany({ where: { userId: req.session.userId } }).then(accs => {
        const history = lotteryHistoryStore[req.session.userId] || [];
        res.render('lottery', { 
            user: req.session.user, 
            lineAccounts: accs,
            lotteryHistory: history.slice(0, 10),
            page: 'lottery' 
        });
    });
});

app.post('/api/lottery/send', isLogin, async (req, res) => {
    const { lineAccountId, round, prize1st, prize2front, prize2back,
            prize3front1, prize3front2, prize3back, nearPrize1, nearPrize2, message } = req.body;
    
    try {
        // ตรวจสอบบัญชี LINE เป็นของ user นี้
        const account = await prisma.lineAccount.findUnique({ where: { id: parseInt(lineAccountId) } });
        if (!account || account.userId !== req.session.userId) {
            return res.status(403).json({ success: false, error: 'ไม่มีสิทธิ์ใช้บัญชีนี้' });
        }

        // ดึงกลุ่มทั้งหมดของบัญชีนี้
        let groups = [];
        if (account.fetchedGroups) {
            try { groups = JSON.parse(account.fetchedGroups); } catch(e) {}
        }
        
        if (groups.length === 0) {
            return res.json({ success: false, error: 'ยังไม่มีกลุ่ม กรุณากด "ดึงกลุ่ม" ในหน้าบอทไลน์ก่อน' });
        }

        // สร้าง job สำหรับแต่ละกลุ่ม (ส่งทุกกลุ่มพร้อมกัน)
        let sentCount = 0;
        for (const group of groups) {
            const groupId = typeof group === 'object' ? group.id : group;
            try {
                const job = await prisma.jobQueue.create({
                    data: {
                        targetUrl: groupId,
                        message,
                        platform: 'LINE',
                        mode: 'IMMEDIATE',
                        status: 'RUNNING',
                        lineAccountId: account.id
                    },
                    include: { lineAccount: true }
                });
                // รันบอทส่งข้อความ
                runLinePersonalBot(job).then(async (status) => {
                    await prisma.jobQueue.update({ where: { id: job.id }, data: { status: status || 'SUCCESS' } });
                }).catch(async () => {
                    await prisma.jobQueue.update({ where: { id: job.id }, data: { status: 'FAILED' } });
                });
                sentCount++;
            } catch(e) { console.error('Lottery send error:', e.message); }
        }

        // บันทึกประวัติ
        if (!lotteryHistoryStore[req.session.userId]) lotteryHistoryStore[req.session.userId] = [];
        lotteryHistoryStore[req.session.userId].unshift({
            round, prize1st, prize2back, sentCount, sentAt: new Date()
        });
        // เก็บแค่ 20 รายการล่าสุด
        if (lotteryHistoryStore[req.session.userId].length > 20) {
            lotteryHistoryStore[req.session.userId].pop();
        }

        res.json({ success: true, sentCount, message: `ส่งผลหวยไปแล้ว ${sentCount} กลุ่ม` });
    } catch (e) {
        console.error('Lottery API error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/lottery/history/clear', isLogin, (req, res) => {
    lotteryHistoryStore[req.session.userId] = [];
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`✅ Welloff Platform running on port ${PORT}`); });
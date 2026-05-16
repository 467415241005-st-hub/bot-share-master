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

// ---------------------------------------------------
// 1. CONFIG & MIDDLEWARE
// ---------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1); // บังคับให้เชื่อถือ Proxy ของ Vercel (ป้องกัน Session หลุด)

// ⭐ เปลี่ยนที่เก็บ Session ไปไว้ในฐานข้อมูล (แก้ปัญหาเด้งไปหน้า Login)
app.use(session({
    secret: 'bot-share-master-secret-key',
    resave: false,
    saveUninitialized: false,
    store: new PrismaSessionStore(
        prisma,
        {
            checkPeriod: 2 * 60 * 1000,
            dbRecordIdIsSessionId: true,
            dbRecordIdFunction: undefined,
        }
    ),
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

// โยนข้อมูล user ไปให้ทุกหน้า EJS
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// ---------------------------------------------------
// 2. AUTH MIDDLEWARE
// ---------------------------------------------------
const isLogin = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

const isAdmin = (req, res, next) => {
    // เช็กตัวพิมพ์เล็ก 'admin' ให้ตรงกับในฐานข้อมูล
    if (req.session.userId && req.session.role === 'admin') return next();
    res.status(403).send("เฉพาะแอดมินเท่านั้น!");
};

// ---------------------------------------------------
// 3. STORAGE CONFIG
// ---------------------------------------------------
const storage = multer.diskStorage({
    destination: './public/uploads/slips',
    filename: (req, file, cb) => {
        cb(null, 'slip-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ---------------------------------------------------
// 4. ROUTES & API
// ---------------------------------------------------

// --- อัปเดต Route หน้าแรกเพื่อให้ดึงข้อมูลสถานะงานมาโชว์ในตาราง ---
app.get('/', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        const accounts = await prisma.botAccount.findMany({ where: { userId: req.session.userId } });
        
        // ดึงประวัติงาน 10 รายการล่าสุดมาโชว์ที่ตาราง
        const jobs = await prisma.jobQueue.findMany({
            where: { account: { userId: req.session.userId } },
            // ⭐ แก้จาก createdAt: 'desc' เปลี่ยนเป็น id: 'desc' 
            orderBy: { id: 'desc' }, 
            take: 10,
            include: { account: true }
        });

        res.render('index', { 
            user, 
            accounts, 
            jobs, // ส่งตัวแปร jobs ไปที่หน้า index.ejs
            page: 'facebook' 
        });
    } catch (error) {
        // ⭐ เปลี่ยนตรงนี้ เพื่อให้มันพ่น Error ของจริงออกมาโชว์บนหน้าเว็บ
        console.error("DASHBOARD ERROR:", error);
        res.status(500).send("Error loading dashboard สาเหตุ: " + error.message); 
    }
});

// Login & Register
app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });

    if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user.id;
        req.session.role = user.role.toLowerCase(); // บังคับเป็นพิมพ์เล็กเพื่อความปลอดภัย
        req.session.user = {
            id: user.id,
            username: user.username,
            role: user.role.toLowerCase(),
            credits: user.credits || 0
        };
        res.redirect('/home');
    } else {
        res.status(401).send("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ⭐ NEW: API สำหรับให้ Vercel Cron มาสั่งรันบอท (แก้ปัญหาบอทไม่คอมเมนต์)
app.get('/api/cron/worker', async (req, res) => {
    const now = new Date();
    const pendingJobs = await prisma.jobQueue.findMany({
        where: { status: "PENDING", runAt: { lte: now } },
        include: { account: true }
    });

    for (const job of pendingJobs) {
        await prisma.jobQueue.update({ where: { id: job.id }, data: { status: "RUNNING" } });
        const success = await runCommentBot(job);
        await prisma.jobQueue.update({
            where: { id: job.id },
            data: { status: success ? "SUCCESS" : "FAILED" }
        });
    }
    res.json({ processed: pendingJobs.length });
});

// Admin Payments (ฉบับแก้ไขส่งค่า User)
app.get('/admin/payments', isAdmin, async (req, res) => {
    const pendingPayments = await prisma.payment.findMany({
        where: { status: 'PENDING' },
        include: { user: true }
    });
    res.render('admin_payments', { 
        payments: pendingPayments,
        user: req.session.user,
        page: 'admin_payments' 
    });
});

// --- อื่นๆ (เหมือนเดิม) ---
app.get('/home', isLogin, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    res.render('home', { user, page: 'home' });
});

app.get('/add-bot', isLogin, async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    res.render('add_bot', { user, page: 'add-bot' });
});

// --- API สำหรับลบบัญชีเฟซบุ๊ก (ฉบับแก้ไข ลบประวัติงานก่อนลบ) ---
app.post('/api/accounts/delete', isLogin, async (req, res) => {
    const { accountId } = req.body;
    try {
        // 1. ลบประวัติงาน (JobQueue) ที่ผูกกับบัญชีนี้ทิ้งก่อน (แก้ปัญหา DB Lock)
        await prisma.jobQueue.deleteMany({
            where: { accountId: parseInt(accountId) }
        });

        // 2. จากนั้นถึงจะลบบัญชีหลักได้อย่างปลอดภัย
        await prisma.botAccount.deleteMany({
            where: { 
                id: parseInt(accountId),
                userId: req.session.userId 
            }
        });
        res.json({ success: true });
    } catch (error) {
        console.error("DELETE ERROR:", error);
        res.status(500).json({ success: false, error: "ไม่สามารถลบบัญชีได้" });
    }
});
// --- API สำหรับส่งคอมเมนต์เฟซบุ๊กทันที ---
app.post('/api/facebook/send-now', isLogin, async (req, res) => {
    const { accountId, targetUrl, message } = req.body;
    try {
        // 1. สร้าง Job ในฐานข้อมูลเป็นสถานะ RUNNING ทันที
        const job = await prisma.jobQueue.create({
            data: {
                accountId: parseInt(accountId),
                targetUrl: targetUrl,
                message: message,
                runAt: new Date(),
                status: "RUNNING"
            },
            include: { account: true }
        });

        // 2. สั่งรันบอททันทีโดยไม่รอ Cron
        const success = await runCommentBot(job);

        // 3. อัปเดตสถานะหลังรันเสร็จ
        await prisma.jobQueue.update({
            where: { id: job.id },
            data: { status: success ? "SUCCESS" : "FAILED" }
        });

        res.json({ success: true });
    } catch (error) {
        console.error("SEND NOW ERROR:", error);
        // ⭐ ส่ง Error Message ไปให้หน้าบ้านแสดงผล
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- หน้า LINE (แก้ไขให้ดึงตาราง lineAccount) ---
app.get('/line', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        // ⭐ เปลี่ยนจาก botAccount เป็น lineAccount
        const lineAccounts = await prisma.lineAccount.findMany({ 
            where: { userId: req.session.userId } 
        });
        
        res.render('line_dashboard', { user, lineAccounts, page: 'line' });
    } catch (error) {
        res.status(500).send("⚠️ DB Error: " + error.message);
    }
});

app.get('/packages', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        res.render('packages', { user, page: 'packages' }, (err, html) => {
            if (err) res.status(500).send("⚠️ EJS Error (หน้า Packages): " + err.message);
            else res.send(html);
        });
    } catch (error) {
        res.status(500).send("⚠️ DB Error: " + error.message);
    }
});

// --- หน้าเติมเครดิต ---
app.get('/topup', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        res.render('topup', { user, page: 'topup' });
    } catch (error) {
        res.status(500).send("⚠️ เกิดข้อผิดพลาด: " + error.message);
    }
});

// --- API สำหรับส่งสลิปเติมเงิน ---
app.post('/api/payments/upload', isLogin, upload.single('slip'), async (req, res) => {
    try {
        const { amount } = req.body;
        const slipPath = req.file ? `/uploads/slips/${req.file.filename}` : null;

        if (!slipPath) return res.status(400).send("กรุณาแนบรูปสลิป");

        await prisma.payment.create({
            data: {
                amount: parseFloat(amount),
                slipImage: slipPath,
                status: 'PENDING',
                userId: req.session.userId
            }
        });

        res.send(`
            <script>
                alert('ส่งสลิปสำเร็จ! รอแอดมินตรวจสอบ');
                window.location.href = '/history';
            </script>
        `);
    } catch (error) {
        res.status(500).send("ไม่สามารถส่งสลิปได้: " + error.message);
    }
});

// --- หน้า History (เพิ่มการดึงข้อมูล Payments) ---
app.get('/history', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        // 1. ดึงประวัติงานบอท
        const jobs = await prisma.jobQueue.findMany({
            where: { account: { userId: req.session.userId } },
            orderBy: { id: 'desc' },
            include: { account: true }
        });
        
        // 2. ⭐ เพิ่มการดึงประวัติการเติมเงิน (payments) ของ User คนนี้
        const payments = await prisma.payment.findMany({
            where: { userId: req.session.userId },
            orderBy: { id: 'desc' }
        });
        
        // ส่งตัวแปรไปให้ครบทั้ง jobs และ payments
        res.render('history', { user, jobs, payments, page: 'history' }, (err, html) => {
            if (err) res.status(500).send("⚠️ EJS Error (หน้า History): " + err.message);
            else res.send(html);
        });
    } catch (error) {
        res.status(500).send("⚠️ DB Error: " + error.message);
    }
});

app.get('/guide', isLogin, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
        res.render('guide', { user, page: 'guide' }, (err, html) => {
            if (err) res.status(500).send("⚠️ EJS Error (หน้า Guide): " + err.message);
            else res.send(html);
        });
    } catch (error) {
        res.status(500).send("⚠️ DB Error: " + error.message);
    }
});

// --- API สำหรับเพิ่มบัญชี Facebook (ฉบับแก้ไขตัด status ออก) ---
app.post('/api/accounts/add', isLogin, async (req, res) => {
    const { fbEmail, fbPassword, cookies } = req.body;
    try {
        await prisma.botAccount.create({
            data: {
                fbEmail,
                fbPassword,
                cookies,
                userId: req.session.userId,
                // ลบบรรทัด status: 'READY' ออก เพราะใน DB ไม่มีคอลัมน์นี้ครับ
            }
        });
        res.redirect('/'); 
    } catch (error) {
        console.error("ADD ACCOUNT ERROR:", error);
        res.status(500).send("ไม่สามารถเพิ่มบัญชีได้ สาเหตุ: " + error.message);
    }
});

// --- API สำหรับส่งข้อความ LINE ทันที (Send Now) ---
app.post('/api/jobs/send-now', isLogin, async (req, res) => {
    const { accountId, message, repeat } = req.body; // ✨ รับค่า repeat มาด้วย
    try {
        const acc = await prisma.lineAccount.findUnique({
            where: { id: parseInt(accountId) }
        });

        if (!acc) return res.status(404).send("ไม่พบข้อมูลกลุ่มไลน์");

        const repeatCount = parseInt(repeat) || 1; // ✨ แปลงเป็นตัวเลข

        // ✨ สั่งให้บอทวนลูปส่งข้อความตามจำนวนที่เลือก
        for (let i = 0; i < repeatCount; i++) {
            await axios.post('https://api.line.me/v2/bot/message/push', {
                to: acc.groupId,
                messages: [{ type: 'text', text: message }]
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.LINE_ACCESS_TOKEN}`
                }
            });
            
            // หน่วงเวลา 1.5 วินาที ระหว่างข้อความ ป้องกันระบบ LINE บล็อก
            if (i < repeatCount - 1) await new Promise(resolve => setTimeout(resolve, 1500));
        }

        console.log(`🟢 ส่งไลน์ด่วนสำเร็จ ${repeatCount} ข้อความ!`);
        res.redirect('/line?success=true');
    } catch (error) {
        console.error("LINE SEND NOW ERROR:", error.response?.data || error.message);
        res.status(500).send("ส่งไม่สำเร็จ: " + (error.response?.data?.message || error.message));
    }
});

// --- API สำหรับรับ Webhook จาก LINE ---
app.post('/webhook', async (req, res) => {
    // 1. ตอบกลับ LINE ทันทีว่ารับทราบแล้ว ป้องกัน Error โดนตัดการเชื่อมต่อ
    res.status(200).send("OK");

    const events = req.body.events;
    if (!events || events.length === 0) return;

    // 2. วนลูปเช็คข้อความที่ส่งเข้ามา
    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text.trim();
            const replyToken = event.replyToken;

            // 3. ถ้าผู้ใช้พิมพ์ /getid
            if (text === '/getid') {
                // ดึง ID (ถ้าพิมพ์ในกลุ่มจะได้ Group ID, ถ้าพิมพ์ส่วนตัวจะได้ User ID)
                const targetId = event.source.groupId || event.source.userId;
                const typeName = event.source.groupId ? "Group ID" : "User ID";
                
                const replyText = `[บอทแชร์] ${typeName} ของคุณคือ:\n${targetId}`;

                // 4. สั่งบอทตอบกลับ
                try {
                    await axios.post('https://api.line.me/v2/bot/message/reply', {
                        replyToken: replyToken,
                        messages: [{ type: 'text', text: replyText }]
                    }, {
                        headers: {
                            'Content-Type': 'application/json',
                            // ⭐ สำคัญ: ต้องมี LINE_ACCESS_TOKEN ในไฟล์ .env ของเซิร์ฟเวอร์
                            'Authorization': `Bearer ${process.env.LINE_ACCESS_TOKEN}` 
                        }
                    });
                } catch (error) {
                    console.error("LINE Reply Error:", error.response?.data || error.message);
                }
            }
        }
    }
});

// --- API สำหรับลบบัญชี LINE ---
app.delete('/api/line/delete/:id', isLogin, async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.lineAccount.delete({
            where: { 
                id: parseInt(id) // มั่นใจว่าเป็นตาราง lineAccount แน่นอน
            }
        });
        res.sendStatus(200);
    } catch (error) {
        console.error("DELETE LINE ERROR:", error);
        res.status(500).send(error.message);
    }
});

// --- API สำหรับเพิ่มบัญชี LINE ---
app.post('/api/line/add', isLogin, async (req, res) => {
    const { groupName, groupId, groupUrl } = req.body;
    try {
        await prisma.lineAccount.create({
            data: {
                groupName,
                groupId,
                groupUrl,
                userId: req.session.userId
            }
        });
        res.redirect('/line'); 
    } catch (error) {
        res.status(500).send("ไม่สามารถเพิ่มกลุ่มไลน์ได้: " + error.message);
    }
});

// --- API สำหรับส่งข้อความ LINE ทันที (Send Now) ---
app.post('/api/jobs/send-now', isLogin, async (req, res) => {
    const { accountId, message } = req.body;
    try {
        // 1. ดึงข้อมูลกลุ่มไลน์จากฐานข้อมูล
        const acc = await prisma.lineAccount.findUnique({
            where: { id: parseInt(accountId) }
        });

        if (!acc) return res.status(404).send("ไม่พบข้อมูลกลุ่มไลน์");

        // 2. ส่งข้อความเข้า LINE (ใช้ Push Message API)
        const response = await axios.post('https://api.line.me/v2/bot/message/push', {
            to: acc.groupId, // ส่งหา Group ID หรือ User ID ที่บันทึกไว้
            messages: [{ type: 'text', text: message }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.LINE_ACCESS_TOKEN}`
            }
        });

        console.log("🟢 ส่งไลน์ด่วนสำเร็จ!");
        res.redirect('/line?success=true'); // ส่งเสร็จให้เด้งกลับหน้าเดิม
    } catch (error) {
        console.error("LINE SEND NOW ERROR:", error.response?.data || error.message);
        res.status(500).send("ส่งไม่สำเร็จ: " + (error.response?.data?.message || error.message));
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server is running on http://localhost:${PORT}`);
});
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// --- สร้างโฟลเดอร์เก็บสลิปถ้ายังไม่มี ---
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
const PORT = process.env.PORT || 80;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// เส้นทาง (Routes) ตามสโคปงานใหม่
// ==========================================

// 1. หน้าแรก (แสดงปุ่มสั่งซื้อ)
app.get('/', (req, res) => {
    res.render('index_checkout', { page: 'checkout' });
});

// 2. API รับแจ้งชำระเงิน (เมื่อลูกค้ากดสแกนและโอนเงินเสร็จ)
app.post('/api/checkout/notify', upload.single('slip'), (req, res) => {
    try {
        // ในสโคปนี้ เราแค่รับไฟล์และข้อมูลมาเก็บไว้ก่อน 
        // อนาคตถ้าอยากเซฟลง DB ให้แอดมินดูค่อยว่ากันอีกที
        const slipPath = req.file ? `/uploads/slips/${req.file.filename}` : null;
        
        console.log(`[Checkout] มีแจ้งโอนเงินเข้ามาใหม่. Slip: ${slipPath}`);
        
        // ดีดกลับไปแจ้งเตือนผู้ใช้งานหน้าเว็บ
        res.send(`<script>
            alert('ส่งหลักฐานสำเร็จ! ระบบกำลังส่งเรื่องไปที่แอดมิน กรุณารอการติดต่อกลับทาง LINE ครับ'); 
            window.location.href='/';
        </script>`);
    } catch (e) {
        console.error("Checkout Error:", e);
        res.send(`<script>alert('เกิดข้อผิดพลาด: ${e.message}'); history.back();</script>`);
    }
});

// 3. API สำหรับให้ Frontend ยิงมาขอ QR Code ของแอดมิน (เอาไปโชว์ใน Modal)
app.get('/api/admin/qrcode', (req, res) => {
    // กำหนดพาธรูปภาพ QR Code ของลูกค้า (แอดมิน)
    // พี่ต้องเอารูป QR Code ไปวางไว้ที่โฟลเดอร์ public/images/admin-qr.png
    res.json({
        success: true,
        qrCodeUrl: '/images/admin-qr.png', 
        lineId: '@admin_line_id' // แก้เป็นไอดีจริงของลูกค้า
    });
});

app.listen(PORT, () => { 
    console.log(`✅ Welloff Checkout Platform running on port ${PORT}`); 
});
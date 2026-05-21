const axios = require('axios');

// 🚨 สำคัญ: LINE Web ปิดให้บริการไปแล้ว การทำบอทผ่านเบราว์เซอร์จะล้มเหลว 100%
// วิธีแก้ที่เสถียรที่สุดคือเปลี่ยนมาใช้ LINE Messaging API (ดึงจาก Token ในระบบ)
async function runLinePersonalBot(job) {
    try {
        console.log(`[LINE] เริ่มทำงานจองแชร์กลุ่ม: ${job.targetUrl}`);
        
        // ดึง Token จากไฟล์สภาพแวดล้อมระบบของคุณ
        const accessToken = process.env.LINE_ACCESS_TOKEN;
        if (!accessToken) {
            console.log("❌ ไม่พบ LINE_ACCESS_TOKEN ในระบบ กรุณาตรวจสอบการตั้งค่า");
            return 'FAILED';
        }

        // 💡 หมายเหตุ: ในระบบ LINE API, ช่องลิงก์เป้าหมาย (targetUrl) ต้องใส่เป็น Group ID 
        // เช่น นำหน้าด้วย C (ตัวอย่าง: C1a2b3c4d5e6f...) แทนการใส่ชื่อกลุ่มปกติ
        const groupId = job.targetUrl.trim();
        const message = job.message;

        const repeatCount = parseInt(job.repeat) || 1;
        let successCount = 0;

        for (let i = 0; i < repeatCount; i++) {
            const response = await axios.post('https://api.line.me/v2/bot/message/push', {
                to: groupId,
                messages: [{ type: 'text', text: message }]
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (response.status === 200) {
                console.log(`✅ [LINE] ส่งข้อความจองรอบที่ ${i+1}/${repeatCount} สำเร็จ`);
                successCount++;
            }
            
            // หน่วงเวลาเพื่อความปลอดภัยของระบบ API
            if (i < repeatCount - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        return successCount > 0 ? 'SUCCESS' : 'FAILED';
    } catch (error) {
        console.error("❌ [LINE] API Error:", error.response ? error.response.data : error.message);
        console.log("💡 คำแนะนำ: ตรวจสอบให้แน่ใจว่าได้ใส่ Group ID ที่ถูกต้องในช่องเป้าหมาย");
        return 'FAILED';
    }
}

module.exports = { runLinePersonalBot };
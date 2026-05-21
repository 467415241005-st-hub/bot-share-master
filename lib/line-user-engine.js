const axios = require('axios');

async function runLinePersonalBot(job) {
    try {
        console.log(`[LINE] เริ่มทำงานจองแชร์กลุ่มเป้าหมาย: ${job.targetUrl}`);
        
        // ดึง Token จากไฟล์ .env ในระบบ
        const accessToken = process.env.LINE_ACCESS_TOKEN;
        if (!accessToken) {
            console.log("❌ ไม่พบ LINE_ACCESS_TOKEN ในระบบ");
            return 'FAILED';
        }

        // 💡 สำคัญ: ในระบบ LINE API ช่องเป้าหมายต้องใส่เป็น Group ID 
        // เช่น C1a2b3c4d5e6f... ไม่ใช่ใส่ชื่อกลุ่ม
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
            
            if (i < repeatCount - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        return successCount > 0 ? 'SUCCESS' : 'FAILED';
    } catch (error) {
        console.error("❌ [LINE] API Error:", error.response ? error.response.data : error.message);
        return 'FAILED';
    }
}

module.exports = { runLinePersonalBot };
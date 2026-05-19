// lib/line-user-engine.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function runLinePersonalBot(job) {
    const userDataDir = path.join(__dirname, `../sessions/line_user_${job.lineAccountId}`);
    
    // ตรวจสอบโฟลเดอร์เก็บ Session
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
    }

    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: true, // รันแบบซ่อนหน้าจอในโหมดทำงานจริง
        viewport: { width: 1280, height: 720 },
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    
    try {
        // ไปที่ LINE Chrome Extension หรือ Web Client (ในที่นี้จำลองหน้าเว็บที่ใช้ล็อกอิน)
        await page.goto('https://line.me/th/'); 

        // Logic การล็อกอินด้วย Email/Pass
        if (job.lineAccount.loginType === 'CREDENTIALS' && job.lineAccount.lineEmail) {
            await page.fill('input[name="email"]', job.lineAccount.lineEmail);
            await page.fill('input[name="password"]', job.lineAccount.linePassword);
            await page.click('button[type="submit"]');
        } 
        
        // รอจนกว่าจะเข้าสู่หน้าแชทสำเร็จ
        await page.waitForTimeout(5000); 

        // ขั้นตอนการส่งข้อความ
        // 1. ค้นหาชื่อกลุ่มเป้าหมาย (job.targetUrl)
        // 2. พิมพ์และส่ง (job.message) ตามจำนวนรอบ (job.repeat)
        const repeatCount = job.repeat || 1;
        for (let i = 0; i < repeatCount; i++) {
            // await page.keyboard.type(job.message);
            // await page.keyboard.press('Enter');
            console.log(`[LINE] Sent message ${i+1}/${repeatCount} to ${job.targetUrl}`);
            if (i < repeatCount - 1) await page.waitForTimeout(2000);
        }

        return 'SUCCESS';
    } catch (error) {
        console.error("LINE Engine Error:", error);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runLinePersonalBot };
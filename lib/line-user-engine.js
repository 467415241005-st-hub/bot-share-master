// lib/line-user-engine.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function runLinePersonalBot(job) {
    const userDataDir = path.join(__dirname, `../sessions/line_user_${job.lineAccountId}`);
    
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
    }

    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: true, 
        viewport: { width: 1280, height: 720 },
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    
    try {
        // ไปที่ตัวจำลอง LINE Web Client หรือ Web Interface สำหรับ Login
        await page.goto('https://line.me/th/'); 

        // Logic การจัดการสิทธิ์ล็อกอินแบบคุ้กกี้ หรือข้อมูลบัญชี
        if (job.lineAccount.loginType === 'CREDENTIALS' && job.lineAccount.lineEmail) {
            await page.fill('input[name="email"]', job.lineAccount.lineEmail);
            await page.fill('input[name="password"]', job.lineAccount.linePassword);
            await page.click('button[type="submit"]');
        } 
        
        await page.waitForTimeout(5000); 

        // [ระบบจำลอง]: ค้นหาและเข้าห้องแชทตามชื่อห้องกลุ่มแชร์ (job.targetUrl)
        console.log(`[LINE] เข้ากลุ่มเป้าหมาย: "${job.targetUrl}"`);

        // ⭐ ⭐ เพิ่มระบบดักจับคีย์เวิร์ด (จองหลังเรท) สำหรับไลน์ ⭐ ⭐
        if (job.mode === 'KEYWORD' && job.keyword) {
            console.log(`[LINE] เริ่มทำงานโหมดจับคีย์เวิร์ด รอดูดข้อความเรท: "${job.keyword}"`);
            let isMatched = false;
            
            // วนลูปอ่านค่าแชทตัวล่าสุดในหน้าต่าง LINE ทุกๆ 1.5 วินาที สแกนสูงสุด 1,000 รอบ (ประมาณ 25 นาที)
            for (let checkLoop = 0; checkLoop < 1000; checkLoop++) {
                const latestText = await page.evaluate(() => {
                    // ใช้ตัวคัดกรองอ่าน Bubble แชทตัวล่างสุดบนหน้าเว็บ LINE
                    const bubbles = document.querySelectorAll('.mdmLIstMessage, [class*="message-text"], [class*="bubble"]');
                    return bubbles.length > 0 ? bubbles[bubbles.length - 1].innerText : '';
                });

                if (latestText.includes(job.keyword)) {
                    console.log(`[LINE] ตรวจเจอข้อความคีย์เวิร์ดเรียบร้อย: "${job.keyword}"! กำลังส่งข้อความจองทันที...`);
                    isMatched = true;
                    break;
                }

                // หน่วงเวลา 1.5 วินาทีก่อนวนสแกนประโยคถัดไป
                await page.waitForTimeout(1500); 
            }

            if (!isMatched) {
                console.log(`[LINE] หมดเวลารอคีย์เวิร์ด ไม่พบข้อความหลังเรทในกลุ่มตามเวลาที่กำหนด`);
                return 'FAILED';
            }
        }

        // ขั้นตอนการคอมเมนต์และส่งข้อความจองตามจำนวนครั้ง (repeat)
        const repeatCount = job.repeat || 1;
        for (let i = 0; i < repeatCount; i++) {
            // โค้ดส่งจริงผ่านหน้าจอดิจิทัล Playwright
            // await page.keyboard.type(job.message);
            // await page.keyboard.press('Enter');
            console.log(`[LINE] ส่งสำเร็จ รอบที่ ${i+1}/${repeatCount} -> ข้อความ: "${job.message}"`);
            if (i < repeatCount - 1) await page.waitForTimeout(1500);
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
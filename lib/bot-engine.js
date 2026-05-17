const puppeteer = require('puppeteer');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: true, // ตั้งเป็น false หากต้องการดูการทำงานสดๆ
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications'] 
    });
    const page = await browser.newPage();

    try {
        // 1. โหลดคุกกี้จาก Database
        const cookies = JSON.parse(job.account.cookies);
        await page.setCookie(...cookies);

        // 2. ไปยังโพสต์เป้าหมาย
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        // ⭐ 3. ระบบดักจับคีย์เวิร์ด (โหมดจองหลังเรท)
        if (job.mode === 'KEYWORD' && job.keyword) {
            const pageText = await page.evaluate(() => document.body.innerText);
            if (!pageText.includes(job.keyword)) {
                console.log(`⏳ [FB] ยังไม่พบคำว่า "${job.keyword}" ในโพสต์นี้...`);
                return 'WAITING'; // ส่งสถานะกลับไปเพื่อให้ระบบ Cron รอรันรอบถัดไป
            }
            console.log(`🎯 [FB] เจอคีย์เวิร์ด "${job.keyword}" แล้ว! เริ่มทำงาน...`);
        }

        // ⭐ 4. ระบบวนลูปคอมเมนต์ (1-5 ครั้ง)
        const repeatCount = parseInt(job.repeat) || 1;
        for (let i = 0; i < repeatCount; i++) {
            await page.waitForSelector('div[role="textbox"]', { timeout: 15000 }); 
            await page.type('div[role="textbox"]', job.message);
            await page.keyboard.press('Enter');
            
            console.log(`✅ [FB] คอมเมนต์รอบที่ ${i+1}/${repeatCount} สำเร็จ`);
            
            // หน่วงเวลาเล็กน้อยระหว่างคอมเมนต์เพื่อป้องกันการโดนบล็อกสแปม
            if (i < repeatCount - 1) {
                await new Promise(resolve => setTimeout(resolve, 2500)); 
            }
        }

        return 'SUCCESS'; 
    } catch (error) {
        console.error("❌ [FB] บอททำงานพลาด:", error.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runCommentBot };
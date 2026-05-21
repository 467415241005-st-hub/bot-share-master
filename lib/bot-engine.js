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
                return 'WAITING'; 
            }
            console.log(`🎯 [FB] เจอคีย์เวิร์ด "${job.keyword}" แล้ว! เริ่มทำงาน...`);
        }

        // ⭐ 4. ระบบวนลูปคอมเมนต์
        const repeatCount = parseInt(job.repeat) || 1;
        for (let i = 0; i < repeatCount; i++) {
            
            // 💡 อัปเดต Selector ให้แม่นยำขึ้น ป้องกันบอทไปพิมพ์ในช่อง Search
            const commentBoxSelector = 'div[contenteditable="true"][role="textbox"]';
            await page.waitForSelector(commentBoxSelector, { timeout: 15000 }); 
            
            // ใช้คำสั่งคลิกโฟกัสก่อน แล้วค่อยพิมพ์ เพื่อความชัวร์ 100%
            await page.focus(commentBoxSelector);
            await page.keyboard.type(job.message);
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
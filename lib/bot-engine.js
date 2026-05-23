const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: 'new', 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        console.log(`[FB] เริ่มทำงานกับบัญชี: ${job.account.fbEmail}`);
        
        // 1. โหลดคุกกี้เข้าเบราว์เซอร์
        const cookies = JSON.parse(job.account.cookies || "[]");
        await page.setCookie(...cookies);

        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // รอช่องพิมพ์ (ลองหลายๆ selector)
        const selectors = ['div[role="textbox"]', 'textarea', 'div[aria-label="เขียนความคิดเห็น..."]'];
        let targetBox = null;
        for(let s of selectors) {
            targetBox = await page.$(s);
            if(targetBox) break;
        }

        if (targetBox) {
            await targetBox.click();
            await page.keyboard.type(job.message, { delay: 50 });
            await page.keyboard.press('Enter');
            console.log("✅ คอมเมนต์สำเร็จ");
            return 'SUCCESS';
        } else {
            // 💡 ถ้าล้มเหลว ให้แคปรูปเก็บไว้ดู
            const errPath = path.join(__dirname, '../public', `error-${Date.now()}.png`);
            await page.screenshot({ path: errPath });
            console.log(`❌ ไม่พบช่องคอมเมนต์ (แคปรูปไว้ที่ ${errPath})`);
            return 'FAILED';
        }
    } catch (e) {
        console.error("❌ Error:", e.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}
module.exports = { runCommentBot };
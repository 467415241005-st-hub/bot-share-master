const puppeteer = require('puppeteer');

async function runCommentBot(job) {
    // 💡 ปรับปรุง Option ให้เข้ากับ VPS
    const browser = await puppeteer.launch({ 
        headless: 'new', // รันแบบไม่มีหน้าจอ
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', // 💡 ตัวนี้สำคัญมากสำหรับ VPS แรมต่ำ
            '--disable-gpu',           // ปิดการใช้ GPU เพราะเซิร์ฟเวอร์ไม่มี
            '--disable-notifications'
        ] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        console.log(`[FB] เริ่มทำงาน: ${job.targetUrl}`);
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // รอให้ช่องพิมพ์ปรากฏ
        await page.waitForSelector('div[role="textbox"]', { timeout: 15000 });
        const targetBox = await page.$('div[role="textbox"]');

        if (targetBox) {
            await targetBox.click();
            await page.keyboard.type(job.message, { delay: 50 });
            await page.keyboard.press('Enter');
            console.log("✅ คอมเมนต์สำเร็จ");
            return 'SUCCESS';
        }
        return 'FAILED';
    } catch (e) {
        console.error("❌ Error:", e.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runCommentBot };
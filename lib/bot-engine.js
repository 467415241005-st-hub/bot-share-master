const puppeteer = require('puppeteer');
const path = require('path');

async function runCommentBot(job) {
    console.log(`[FB-BOT] เริ่มทำงานงาน ID: ${job.id}`);
    
    const browser = await puppeteer.launch({ 
        headless: 'new', 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    try {
        // 1. โหลดคุกกี้
        if (job.account && job.account.cookies && job.account.cookies !== "[]") {
            const cookies = JSON.parse(job.account.cookies);
            await page.setCookie(...cookies);
        }

        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(3000);

        // เช็คว่าต้อง Login ไหม
        const loginBtn = await page.$('a[href*="login"]');
        if (loginBtn || (await page.url()).includes('login')) {
            console.log("[FB-BOT] ไม่พบ Session กำลังล็อกอิน...");
            await page.goto('https://m.facebook.com/login', { waitUntil: 'networkidle2' });
            
            // ใช้ Selector ที่กว้างขึ้น
            await page.waitForSelector('input[name="email"], input[name="pass"]', { timeout: 10000 });
            await page.type('input[name="email"]', job.account.fbEmail, { delay: 50 });
            await page.type('input[name="pass"]', job.account.fbPassword, { delay: 50 });
            await page.click('button[name="login"]');
            await wait(10000); // รอหลังกดล็อกอิน
            
            await page.goto(job.targetUrl, { waitUntil: 'networkidle2' });
        }

        // 2. คอมเมนต์
        const selectors = ['div[contenteditable="true"]', 'textarea', 'input[type="text"]'];
        let targetBox = null;
        for(let s of selectors) {
            targetBox = await page.$(s);
            if(targetBox) break;
        }

        if (targetBox) {
            await targetBox.click();
            await page.keyboard.type(job.message, { delay: 50 });
            await page.keyboard.press('Enter');
            console.log("✅ คอมเมนต์สำเร็จ!");
            return 'SUCCESS';
        } else {
            console.log("❌ หาช่องพิมพ์ไม่เจอ");
            return 'FAILED';
        }
    } catch (e) {
        console.error("❌ FB Error:", e.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}
module.exports = { runCommentBot };
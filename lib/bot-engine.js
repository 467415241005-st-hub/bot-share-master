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
        if (job.account && job.account.cookies && job.account.cookies !== "[]") {
            await page.setCookie(...JSON.parse(job.account.cookies));
        }

        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(3000);

        // เช็คหน้า Login แบบแม่นยำขึ้น
        const loginInput = await page.$('input[name="email"]');
        if (loginInput) {
            console.log("[FB-BOT] กำลังล็อกอิน...");
            await page.type('input[name="email"]', job.account.fbEmail);
            await page.type('input[name="pass"]', job.account.fbPassword);
            await page.click('button[name="login"]');
            await wait(10000); 
            await page.goto(job.targetUrl, { waitUntil: 'networkidle2' });
        }

        // ค้นหาช่องคอมเมนต์
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
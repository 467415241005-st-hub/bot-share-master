const puppeteer = require('puppeteer');
const path = require('path');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: 'new', 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        if (job.account && job.account.cookies) {
            const cookies = JSON.parse(job.account.cookies);
            await page.setCookie(...cookies);
        }

        await page.goto(job.targetUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });

        // 💡 ตรวจสอบหน้า Login ก่อน ถ้าติดหน้านี้คือคุกกี้เสีย
        const isLogin = await page.$('input[name="pass"]');
        if (isLogin) {
            console.log("❌ [FB-BOT] ติดหน้า Login! คุกกี้หมดอายุ");
            return 'FAILED';
        }

        // ค้นหาช่องคอมเมนต์
        const selectors = ['div[contenteditable="true"][role="textbox"]', 'div[role="textbox"]'];
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
        console.error("❌ Error:", e.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}
module.exports = { runCommentBot };
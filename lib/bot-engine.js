const puppeteer = require('puppeteer');

async function runCommentBot(job) {
    // 💡 แก้ไข: ใช้ headless: 'new' เพื่อให้รันบน VPS ได้ปกติ (ไม่มีหน้าจอ)
    const browser = await puppeteer.launch({ 
        headless: 'new', 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications'] 
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        console.log(`[FB] เริ่มทำงาน: ${job.targetUrl}`);
        
        // ฟังก์ชันหน่วงเวลาแบบใหม่ (แทน waitForTimeout)
        const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(5000); 

        const commentSelectors = [
            'div[contenteditable="true"][role="textbox"]',
            'div[role="textbox"]',
            'div[aria-label="เขียนความคิดเห็น..."]'
        ];
        
        let targetBox = null;
        for (let sel of commentSelectors) {
            targetBox = await page.$(sel);
            if (targetBox) break;
        }

        if (targetBox) {
            await targetBox.click();
            await wait(1000);
            await page.keyboard.type(job.message, { delay: 50 });
            await wait(1000);
            await page.keyboard.press('Enter');
            
            console.log("✅ คอมเมนต์สำเร็จ");
            return 'SUCCESS';
        } else {
            console.log("❌ ไม่พบช่องคอมเมนต์");
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
const puppeteer = require('puppeteer');

async function runCommentBot(job) {
    // 💡 สำคัญ: เปลี่ยน headless เป็น false เพื่อให้คุณเห็นหน้าจอบอททำงานสดๆ บนเซิร์ฟเวอร์
    // วิธีนี้จะช่วยให้รู้ทันทีว่ามันติดอะไร
    const browser = await puppeteer.launch({ 
        headless: false, 
        args: ['--no-sandbox', '--window-size=1280,800'] 
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2' });
        await page.waitForTimeout(5000);

        // ⭐ ปรับปรุง Selector ให้กว้างขึ้น (ไม่พึ่งพาชื่อภาษาอย่างเดียว)
        const commentSelectors = [
            'div[role="textbox"][contenteditable="true"]',
            'div[aria-label="เขียนความคิดเห็น..."]',
            'div[aria-label="Write a comment..."]',
            '.notranslate[role="textbox"]'
        ];

        let targetBox = null;
        for (let sel of commentSelectors) {
            targetBox = await page.$(sel);
            if (targetBox) break;
        }

        if (targetBox) {
            console.log("✅ พบช่องคอมเมนต์แล้ว!");
            await targetBox.click();
            await page.keyboard.type(job.message, { delay: 100 });
            await page.keyboard.press('Enter');
            console.log("✅ คอมเมนต์สำเร็จ");
            return 'SUCCESS';
        } else {
            console.log("❌ หาช่องคอมเมนต์ไม่เจอ");
            return 'FAILED';
        }
    } catch (e) {
        console.error("Error:", e.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runCommentBot };
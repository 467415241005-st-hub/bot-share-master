const puppeteer = require('puppeteer');
const path = require('path');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: 'new', 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-notifications', 
            '--window-size=1280,1024',
            '--disable-blink-features=AutomationControlled'
        ] 
    });
    const page = await browser.newPage();
    
    // จำลองเป็นเบราว์เซอร์คนจริงๆ ให้เนียนที่สุด
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 1024 });

    try {
        console.log(`[FB] เริ่มทำงานจองแชร์โพสต์: ${job.targetUrl}`);

        // ⭐ 1. ระบบล็อกอิน
        const cookies = JSON.parse(job.account.cookies || "[]");
        if (cookies && cookies.length > 0) {
            await page.setCookie(...cookies);
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
        } else if (job.account.fbEmail && job.account.fbPassword) {
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
            const emailInput = await page.$('#email');
            if (emailInput) {
                await page.type('#email', job.account.fbEmail);
                await page.type('#pass', job.account.fbPassword);
                await page.click('[name="login"]');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{});
            }
        }

        // ⭐ 2. ไปหน้าโพสต์เป้าหมาย
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.waitForTimeout(5000); // รอให้ Facebook โหลดกล่องข้อความครบ 100%

        // ⭐ สคริปต์กวาดล้าง Pop-up ที่บังจอ (สำคัญมาก)
        try {
            const closeSelectors = [
                'div[aria-label="ปิด"]', 'div[aria-label="Close"]', 
                'div[aria-label="ไม่ใช่ตอนนี้"]', 'div[aria-label="Not Now"]'
            ];
            for (let sel of closeSelectors) {
                const btns = await page.$$(sel);
                for(let btn of btns) { await btn.click().catch(()=>{}); }
            }
        } catch(e) {}

        // ⭐ 3. โหมดจับคีย์เวิร์ด
        if (job.mode === 'KEYWORD' && job.keyword) {
            const pageText = await page.evaluate(() => document.body.innerText);
            if (!pageText.includes(job.keyword)) {
                console.log(`⏳ [FB] ยังไม่พบคำว่า "${job.keyword}" รอรอบถัดไป...`);
                return 'WAITING';
            }
        }

        // ⭐ 4. พิมพ์และส่งข้อความ
        const repeatCount = parseInt(job.repeat) || 1;
        let successCount = 0;

        for (let i = 0; i < repeatCount; i++) {
            // ค้นหาช่องคอมเมนต์แบบครอบคลุม
            const commentSelectors = [
                'div[aria-label="เขียนความคิดเห็น..."][role="textbox"]',
                'div[aria-label="Write a comment..."][role="textbox"]',
                'div[aria-label="เขียนความคิดเห็น"][role="textbox"]',
                'div[role="textbox"][contenteditable="true"]'
            ];
            
            let targetBox = null;
            for (let sel of commentSelectors) {
                const elements = await page.$$(sel);
                if (elements.length > 0) {
                    targetBox = elements[elements.length - 1]; // เลือกกล่องล่างสุด
                    break;
                }
            }

            if (targetBox) {
                // เลื่อนจอไปหากล่อง และคลิกเพื่อนำเคอร์เซอร์ไปวาง
                await page.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), targetBox);
                await page.waitForTimeout(1000);
                
                await targetBox.click().catch(async () => {
                    await page.evaluate(el => el.focus(), targetBox); // สำรองถ้าคลิกปกติไม่ได้
                });
                await page.waitForTimeout(500);
                
                // พิมพ์ข้อความ
                await page.keyboard.type(job.message, { delay: 30 });
                await page.waitForTimeout(1000);
                
                // ส่งด้วย Enter
                await page.keyboard.press('Enter');
                
                console.log(`✅ [FB] คอมเมนต์รอบที่ ${i+1}/${repeatCount} สำเร็จ`);
                successCount++;
                await page.waitForTimeout(3000); 
            } else {
                console.log(`❌ [FB] ไม่พบช่องคอมเมนต์`);
            }
        }

        return successCount > 0 ? 'SUCCESS' : 'FAILED'; 

    } catch (error) {
        console.error("❌ [FB] Error:", error.message);
        // ถ่ายรูปหน้าจอเก็บไว้ดูว่ามันพังเพราะอะไร (จะเซฟไว้ในโฟลเดอร์ public)
        await page.screenshot({ path: path.join(__dirname, '../public', `error-fb-${Date.now()}.png`) }).catch(()=>{});
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runCommentBot };
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function runCommentBot(job) {
    // 💡 ปรับแต่งสำหรับ VPS (Linux) โดยเฉพาะ: 
    // - headless: 'new' (รันไร้หน้าจอ)
    // - เพิ่ม args ป้องกัน Error "Missing X server" และแรมเต็ม
    const browser = await puppeteer.launch({ 
        headless: 'new', 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--disable-gpu',           
            '--no-zygote',
            '--single-process',
            '--disable-notifications'
        ] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // ฟังก์ชันรอแทน waitForTimeout (ตัวนี้ปลอดภัยไม่พัง)
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    try {
        console.log(`[FB] เริ่มทำงานกับบัญชี: ${job.account.fbEmail}`);
        
        // 1. โหลดคุกกี้ (ถ้ามี)
        const cookies = JSON.parse(job.account.cookies || "[]");
        if (cookies.length > 0) {
            await page.setCookie(...cookies);
        }

        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(5000); 

        // 2. ค้นหาช่องคอมเมนต์ (ใช้หลาย Selector กันพลาด)
        const selectors = [
            'div[contenteditable="true"][role="textbox"]',
            'div[role="textbox"]',
            'div[aria-label="เขียนความคิดเห็น..."]',
            'textarea'
        ];
        
        let targetBox = null;
        for(let s of selectors) {
            targetBox = await page.$(s);
            if(targetBox) break;
        }

        if (targetBox) {
            console.log("✅ พบช่องคอมเมนต์");
            await targetBox.click();
            await wait(1000);
            await page.keyboard.type(job.message, { delay: 50 });
            await wait(1000);
            await page.keyboard.press('Enter');
            
            console.log("✅ คอมเมนต์สำเร็จ");
            return 'SUCCESS';
        } else {
            console.log("❌ ไม่พบช่องคอมเมนต์");
            // แคปรูปหน้าจอตอนพังเก็บไว้ใน public/
            const errPath = path.join(__dirname, '../public', `error-fb-${Date.now()}.png`);
            await page.screenshot({ path: errPath, fullPage: true }).catch(()=>{});
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
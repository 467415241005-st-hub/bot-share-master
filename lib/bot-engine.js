const puppeteer = require('puppeteer');
const path = require('path');

async function runCommentBot(job) {
    console.log(`[FB-BOT] เริ่มทำงานงาน ID: ${job.id}`);
    
    // 1. ตั้งค่า Browser สำหรับ VPS (ต้องมีโหมดนี้เพื่อให้รันบน Linux ได้)
    const browser = await puppeteer.launch({ 
        headless: 'new', 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', // ป้องกัน RAM เต็มบน VPS
            '--disable-gpu',           // ป้องกัน Error เรื่องกราฟิก
            '--no-zygote',
            '--single-process',
            '--disable-notifications'
        ] 
    });
    
    const page = await browser.newPage();
    // ตั้งค่า UserAgent ป้องกันการโดนบล็อกเป็นบอท
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // ฟังก์ชันรอแบบปลอดภัย (ไม่ใช้ waitForTimeout ที่พังไปแล้ว)
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    try {
        // 2. โหลดคุกกี้ (ต้องโหลดก่อนไปหน้าเว็บ)
        if (job.account && job.account.cookies) {
            const cookies = JSON.parse(job.account.cookies);
            await page.setCookie(...cookies);
            console.log("[FB-BOT] โหลดคุกกี้เรียบร้อย");
        }

        // 3. ไปที่หน้าโพสต์
        console.log(`[FB-BOT] กำลังนำทางไป: ${job.targetUrl}`);
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(3000); 

        // 4. ค้นหาช่องคอมเมนต์ (ใช้หลาย Selector กันพลาด)
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
            console.log("[FB-BOT] พบช่องคอมเมนต์ กำลังพิมพ์...");
            await targetBox.click();
            await wait(500);
            await page.keyboard.type(job.message, { delay: 50 });
            await wait(1000);
            await page.keyboard.press('Enter');
            
            console.log("✅ คอมเมนต์สำเร็จ!");
            return 'SUCCESS';
        } else {
            console.log("❌ ไม่พบช่องคอมเมนต์ (หรืออาจติดหน้า Login)");
            // แคปรูปเก็บหลักฐานไว้ดูว่าติดอะไร
            const errPath = path.join(__dirname, '../public', `error-fb-${Date.now()}.png`);
            await page.screenshot({ path: errPath, fullPage: true }).catch(()=>{});
            return 'FAILED';
        }
    } catch (e) {
        console.error("❌ Error ในการรันบอท:", e.message);
        return 'FAILED';
    } finally {
        await browser.close();
        console.log("[FB-BOT] ปิดเบราว์เซอร์แล้ว");
    }
}

module.exports = { runCommentBot };
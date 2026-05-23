const puppeteer = require('puppeteer');
const path = require('path');

async function runCommentBot(job) {
    console.log(`[FB-BOT] เริ่มทำงานงาน ID: ${job.id}`);
    
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
    
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    try {
        // 1. จัดการเรื่อง Login (คุกกี้ว่าง ให้ล็อกอินใหม่ด้วย Email/Password)
        let isLoggedIn = false;
        if (job.account && job.account.cookies && job.account.cookies !== "[]") {
            const cookies = JSON.parse(job.account.cookies);
            await page.setCookie(...cookies);
            console.log("[FB-BOT] โหลดคุกกี้เรียบร้อย");
            isLoggedIn = true;
        }

        if (!isLoggedIn) {
            console.log("[FB-BOT] ไม่มีคุกกี้ กำลังเข้าสู่ระบบด้วย Email/Password...");
            await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2' });
            
            // พิมพ์ Email และ Password ที่พี่ผูกไว้
            await page.waitForSelector('#email');
            await page.type('#email', job.account.fbEmail, { delay: 30 });
            await page.type('#pass', job.account.fbPassword, { delay: 30 });
            await page.keyboard.press('Enter');
            
            console.log("[FB-BOT] กดล็อกอินแล้ว รอโหลด...");
            await wait(8000); // รอให้ล็อกอินสำเร็จ
            
            // ตรวจสอบว่าล็อกอินผ่านไหม
            if (await page.$('#pass')) {
                console.log("❌ [FB-BOT] รหัสผ่านผิด หรือติดหน้ายืนยันตัวตน!");
                return 'FAILED';
            }
            console.log("[FB-BOT] ล็อกอินสำเร็จ!");
        }

        // 2. ไปที่หน้าโพสต์เป้าหมาย
        console.log(`[FB-BOT] กำลังนำทางไปโพสต์: ${job.targetUrl}`);
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(5000); 

        // 3. ค้นหาช่องคอมเมนต์และพิมพ์
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
            await wait(1000);
            await page.keyboard.type(job.message, { delay: 50 });
            await wait(1000);
            await page.keyboard.press('Enter');
            
            console.log("✅ คอมเมนต์สำเร็จ!");
            return 'SUCCESS';
        } else {
            console.log("❌ ไม่พบช่องคอมเมนต์ (โพสต์อาจถูกจำกัดการมองเห็น หรือโครงสร้างผิดปกติ)");
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
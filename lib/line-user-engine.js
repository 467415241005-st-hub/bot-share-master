const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

async function runLinePersonalBot(job) {
    console.log(`[LINE-BOT] เริ่มทำงานงาน ID: ${job.id}`);
    
    const extensionDir = path.join(__dirname, '../line_extension');
    
    // 💡 ระบบดาวน์โหลดซอร์สโค้ด LINE Extension อัตโนมัติจาก Google ถ้ายังไม่มีไฟล์ในเครื่อง vps
    if (!fs.existsSync(extensionDir) || fs.readdirSync(extensionDir).length === 0) {
        console.log("[LINE-BOT] ไม่พบไฟล์ระบบ LINE ในเซิร์ฟเวอร์ กำลังดาวน์โหลดเวอร์ชันล่าสุดส่งตรงจาก Chrome Store...");
        fs.mkdirSync(extensionDir, { recursive: true });
        
        try {
            // ลิงก์ตรงดึงไฟล์ .crx จาก Google Chrome Web Store
            const crxUrl = 'https://clients2.google.com/service/update2/crx?response=redirect&os=win&arch=x64&os_arch=x86_64&nacl_arch=x86-64&prod=chromecrx&prodchannel=&prodversion=120.0.0.0&acceptformat=crx3&x=id%3Dophjlpahpchlmihnnnihgmmeilfjmjjc%26uc';
            const zipPath = path.join(__dirname, '../line_extension.zip');
            
            const writer = fs.createWriteStream(zipPath);
            const response = await axios({ url: crxUrl, method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);
            
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            
            // ใช้ extract-zip แตกไฟล์ออกมาเป็นโฟลเดอร์อัตโนมัติ
            const extract = require('extract-zip');
            await extract(zipPath, { dir: extensionDir });
            fs.unlinkSync(zipPath); // ลบไฟล์ zip ทิ้งหลังแตกเสร็จ
            console.log("✅ [LINE-BOT] ดาวน์โหลดและเซ็ตอัพ LINE Extension สำเร็จ!");
        } catch (downloadErr) {
            console.error("❌ ดาวน์โหลด Extension ล้มเหลว:", downloadErr.message);
            return 'FAILED';
        }
    }

    // ตั้งค่าเปิดเบราว์เซอร์บน VPS พร้อมจำลองหน้าจอและดึง Extension มาเปิดใช้งาน
    const browser = await puppeteer.launch({ 
        headless: 'new',
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu',
            `--disable-extensions-except=${extensionDir}`,
            `--load-extension=${extensionDir}`,
            '--window-size=1200,800'
        ] 
    });
    
    const page = await browser.newPage();
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    try {
        console.log("[LINE-BOT] กำลังเปิดหน้าแชท LINE Extension...");
        await page.goto('chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html', { waitUntil: 'networkidle2', timeout: 40000 });
        await wait(3000);

        const needsLogin = await page.$('#id');
        if (needsLogin) {
            console.log("[LINE-BOT] กรอกข้อมูลล็อกอินเข้าสู่ระบบบัญชีส่วนตัว...");
            await page.type('#id', job.account.lineEmail, { delay: 40 });
            await page.type('#passwd', job.account.linePassword, { delay: 40 });
            await page.click('.mdCMN01Btn'); 
            await wait(6000);
            
            const isPinVisible = await page.$('.mdMN01PinCode');
            if (isPinVisible) {
                console.log("⚠️ [LINE-BOT] ติดรหัส PIN! กรุณาเช็ครหัสที่รูปหน้าเว็บ");
                const pinPath = path.join(__dirname, '../public', `line-pin-code.png`);
                await page.screenshot({ path: pinPath }).catch(()=>{});
                return 'FAILED';
            }
        }

        console.log(`[LINE-BOT] กำลังค้นหากลุ่มแชทชื่อ: ${job.targetUrl}`);
        await page.waitForSelector('#search_input', { timeout: 15000 });
        await page.click('#search_input');
        await page.type('#search_input', job.targetUrl, { delay: 80 });
        await page.keyboard.press('Enter');
        await wait(2500);
        
        const chatItem = await page.$('.mdCMN09Li');
        if (!chatItem) {
            console.log(`❌ [LINE-BOT] ไม่พบกลุ่มชื่อ: ${job.targetUrl}`);
            return 'FAILED';
        }
        await chatItem.click();
        await wait(2000);
        
        const repeatCount = parseInt(job.repeat) || 1;
        for (let i = 0; i < repeatCount; i++) {
            await page.waitForSelector('#chatTextarea', { timeout: 10000 });
            await page.click('#chatTextarea');
            await page.type('#chatTextarea', job.message, { delay: 30 });
            await page.keyboard.press('Enter');
            
            console.log(`✅ [LINE-BOT] พิมพ์จองส่งรอบที่ ${i+1}/${repeatCount} สำเร็จ!`);
            if (i < repeatCount - 1) await wait(2000);
        }

        return 'SUCCESS';

    } catch (e) {
        console.error("❌ เกิดข้อผิดพลาด:", e.message);
        const errPath = path.join(__dirname, '../public', `error-line-${Date.now()}.png`);
        await page.screenshot({ path: errPath, fullPage: true }).catch(()=>{});
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runLinePersonalBot };
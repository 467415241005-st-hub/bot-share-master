const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// ฟังก์ชันหลักสำหรับเปิด Browser โดยใช้ Profile ถาวร
async function launchLineBrowser(accountId) {
    const extensionDir = path.join(__dirname, '../line_extension');
    const profileDir = path.join(__dirname, '../line_profiles', `acc_${accountId}`); // 💡 เก็บโปรไฟล์ถาวร
    
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

    return await puppeteer.launch({ 
        headless: 'new',
        userDataDir: profileDir, // 💡 ทำให้จำการล็อกอินได้ ไม่ติด PIN บ่อยๆ
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            `--disable-extensions-except=${extensionDir}`,
            `--load-extension=${extensionDir}`
        ] 
    });
}

// 🟢 ฟังก์ชันที่ 1: สำหรับกดปุ่ม "ดึงข้อมูลกลุ่ม" (เวอร์ชันถ่ายรูป QR Code ให้สแกน)
async function syncLineGroups(account) {
    console.log(`[LINE-SYNC] เริ่มดึงข้อมูลกลุ่มบัญชี: ${account.lineEmail || account.groupName}`);
    const browser = await launchLineBrowser(account.id);
    const page = await browser.newPage();
    const wait = (ms) => new Promise(res => setTimeout(res, ms));

    try {
        await page.goto('chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html', { waitUntil: 'networkidle2' });
        await wait(3000);

        // ตรวจสอบว่าอยู่หน้า Login หรือไม่
        const isLoginPage = await page.$('input[placeholder="Email address"], input[type="text"], #id');
        
        if (isLoginPage) {
            console.log("📸 บอทกำลังสร้าง QR Code...");
            
            // 1. ถ่ายรูป QR Code โชว์ที่หน้าเว็บ
            const qrPath = path.join(__dirname, '../public', 'line-qr-code.png');
            await page.screenshot({ path: qrPath });

            console.log("⏳ รอให้สแกน QR Code (ภายใน 60 วินาที)...");
            
            try {
                // 2. สั่งให้บอทรอจนกว่าหน้าแชทจะโหลดขึ้นมา (แปลว่าสแกนสำเร็จ)
                await page.waitForSelector('.mdCMN09Li', { timeout: 60000 });
                console.log("✅ สแกนสำเร็จ! เข้าสู่ระบบแล้ว");
                
                // รอให้รายชื่อกลุ่มโหลดเสร็จ
                await wait(3000); 
            } catch (err) {
                // ถ้าลูกค้าสแกนไม่ทันใน 1 นาที ให้แจ้ง Error
                return { success: false, error: 'หมดเวลา! กรุณากด "ดึงกลุ่ม" อีกครั้ง แล้วรีบสแกน QR Code ที่ลิงก์ /line-qr-code.png' };
            }
        }

        console.log("[LINE-SYNC] กำลังอ่านรายชื่อกลุ่ม...");
        await page.waitForSelector('.mdCMN09Li', { timeout: 15000 });
        
        const groups = await page.evaluate(() => {
            const elements = document.querySelectorAll('.mdCMN09Li .mdCMN09H3');
            return Array.from(elements).map(el => el.innerText.trim()).filter(t => t !== '');
        });

        console.log(`✅ ดึงได้ทั้งหมด ${groups.length} กลุ่ม`);
        return { success: true, groups: groups };
    } catch (e) {
        console.error("❌ Sync Error:", e.message);
        // แอบถ่ายรูปตอน Error เพื่อหาสาเหตุ
        const errPath = path.join(__dirname, '../public', 'line-qr-code.png');
        await page.screenshot({ path: errPath }).catch(()=>{});
        return { success: false, error: 'โหลดช้าหรือมีข้อผิดพลาด (ดูรูปหน้าจอที่ลิงก์ /line-qr-code.png)' };
    } finally {
        await browser.close();
    }
}

// 🟢 ฟังก์ชันที่ 2: สำหรับยิงส่งข้อความ (ทำงานเร็วขึ้นเพราะไม่ต้องล็อกอินใหม่)
async function runLinePersonalBot(job) {
    console.log(`[LINE-BOT] เริ่มส่งข้อความบัญชี ID: ${job.lineAccountId}`);
    const browser = await launchLineBrowser(job.lineAccountId);
    const page = await browser.newPage();
    const wait = (ms) => new Promise(res => setTimeout(res, ms));

    try {
        await page.goto('chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html', { waitUntil: 'networkidle2' });
        await wait(3000);

        // เช็คว่า session หลุดหรือยัง
        const isLoginPage = await page.$('input[placeholder="Email address"], input[type="text"], #id');
        if (isLoginPage) {
            return 'FAILED'; // ถ้า session หลุด ให้ตีกลับเป็น FAILED ต้องไปกด sync ใหม่
        }

        console.log(`[LINE-BOT] ค้นหากลุ่ม: ${job.targetUrl}`);
        await page.waitForSelector('#search_input', { timeout: 10000 });
        await page.type('#search_input', job.targetUrl);
        await page.keyboard.press('Enter');
        await wait(2000);
        
        const chatItem = await page.$('.mdCMN09Li');
        if (!chatItem) return 'FAILED';
        
        await chatItem.click();
        await wait(1500);
        
        const repeatCount = parseInt(job.repeat) || 1;
        for (let i = 0; i < repeatCount; i++) {
            await page.waitForSelector('#chatTextarea', { timeout: 10000 });
            await page.type('#chatTextarea', job.message);
            await page.keyboard.press('Enter');
            console.log(`✅ ส่งรอบที่ ${i+1} สำเร็จ!`);
            if (i < repeatCount - 1) await wait(1500);
        }
        return 'SUCCESS';
    } catch (e) {
        console.error("❌ Send Error:", e.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runLinePersonalBot, syncLineGroups };
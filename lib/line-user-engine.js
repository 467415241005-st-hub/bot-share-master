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

// 🟢 ฟังก์ชันที่ 1: สำหรับกดปุ่ม "ดึงข้อมูลกลุ่ม"
async function syncLineGroups(account) {
    console.log(`[LINE-SYNC] เริ่มดึงข้อมูลกลุ่มบัญชี: ${account.lineEmail}`);
    const browser = await launchLineBrowser(account.id);
    const page = await browser.newPage();
    const wait = (ms) => new Promise(res => setTimeout(res, ms));

    try {
        await page.goto('chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html', { waitUntil: 'networkidle2' });
        await wait(3000);

        // จัดการล็อกอินถ้า session หลุด
        if (await page.$('#id')) {
            console.log("[LINE-SYNC] กำลังล็อกอินเข้าสู่ระบบ...");
            await page.type('#id', account.lineEmail);
            await page.type('#passwd', account.linePassword);
            await page.click('.mdCMN01Btn');
            await wait(5000);
            
            // ถ้าติด PIN ให้เซฟรูปเก็บไว้เผื่อแอดมินมาดู
            if (await page.$('.mdMN01PinCode')) {
                const pinPath = path.join(__dirname, '../public', `pin_${account.id}.png`);
                await page.screenshot({ path: pinPath });
                console.log(`⚠️ ติด PIN! บันทึกรูปไว้ที่ /pin_${account.id}.png`);
                return { success: false, error: 'บัญชีนี้ติด PIN ยืนยันตัวตนในระบบครั้งแรก' };
            }
        }

        console.log("[LINE-SYNC] กำลังอ่านรายชื่อกลุ่ม...");
        await page.waitForSelector('.mdCMN09Li', { timeout: 15000 });
        
        // 💡 ดึงชื่อแชท/กลุ่มทั้งหมดออกมา
        const groups = await page.evaluate(() => {
            const elements = document.querySelectorAll('.mdCMN09Li .mdCMN09H3');
            return Array.from(elements).map(el => el.innerText.trim()).filter(t => t !== '');
        });

        console.log(`✅ ดึงได้ทั้งหมด ${groups.length} กลุ่ม`);
        return { success: true, groups: groups };
    } catch (e) {
        console.error("❌ Sync Error:", e.message);
        return { success: false, error: 'ไม่สามารถดึงข้อมูลกลุ่มได้' };
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

        if (await page.$('#id')) {
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
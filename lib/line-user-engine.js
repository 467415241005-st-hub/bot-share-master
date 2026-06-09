const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// ฟังก์ชันหลักสำหรับเปิด Browser โดยใช้ Profile ถาวร
async function launchLineBrowser(accountId) {
    const extensionDir = path.join(__dirname, '../line_extension');
    const profileDir = path.join(__dirname, '../line_profiles', `acc_${accountId}`); 
    
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

    return await puppeteer.launch({ 
        headless: 'new',
        userDataDir: profileDir, 
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            `--disable-extensions-except=${extensionDir}`,
            `--load-extension=${extensionDir}`
        ] 
    });
}

// 🟢 ฟังก์ชันเสริม (ใหม่!): สำหรับให้บอทสลับแชทไปส่งรายงานผล
async function sendLineReport(page, targetAdminName, reportMessage) {
    try {
        console.log(`[REPORT] กำลังส่งรายงานผลไปที่แชท: ${targetAdminName}`);
        
        // 1. ไปที่ช่องค้นหา และลบข้อความเก่าทิ้ง (ถ้ามี)
        await page.waitForSelector('#search_input', { timeout: 10000 });
        await page.click('#search_input', { clickCount: 3 }); 
        await page.keyboard.press('Backspace');
        
        // 2. พิมพ์ชื่อกลุ่มแอดมิน หรือชื่อ LINE ส่วนตัวลูกค้า
        await page.type('#search_input', targetAdminName);
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 2000)); // รอโหลดผลลัพธ์
        
        // 3. คลิกเลือกแชทแรกที่ค้นเจอ
        const chatItem = await page.$('.mdCMN09Li');
        if (!chatItem) {
            console.log("❌ ไม่พบชื่อแชทเป้าหมายสำหรับส่งรายงาน");
            return false;
        }
        await chatItem.click();
        await new Promise(r => setTimeout(r, 1500));
        
        // 4. พิมพ์ข้อความรายงานผลและกดส่ง
        await page.waitForSelector('#chatTextarea', { timeout: 10000 });
        await page.type('#chatTextarea', reportMessage);
        await page.keyboard.press('Enter');
        
        console.log("✅ บอทส่งรายงานผลสำเร็จ!");
        return true;
    } catch (error) {
        console.error("❌ ส่งรายงานผลไม่สำเร็จ:", error.message);
        return false;
    }
}

// 🟢 ฟังก์ชันที่ 1: สำหรับกดปุ่ม "ดึงข้อมูลกลุ่ม" (กล้อง HD ชัดแจ๋ว)
async function syncLineGroups(account) {
    console.log(`[LINE-SYNC] เริ่มดึงข้อมูลกลุ่มบัญชี: ${account.lineEmail || account.groupName}`);
    const browser = await launchLineBrowser(account.id);
    const page = await browser.newPage();
    
    // อัปเกรดหน้าจอเป็น 1024x768 และเพิ่มความคมชัดระดับ Retina (x2)
    await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2 });
    
    const wait = (ms) => new Promise(res => setTimeout(res, ms));

    try {
        await page.goto('chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html', { waitUntil: 'networkidle2' });
        await wait(3000);

        // ตรวจสอบว่าอยู่หน้า Login หรือไม่
        const isLoginPage = await page.$('input[placeholder="Email address"], input[type="text"], #id');
        
        if (isLoginPage) {
            console.log("📸 บอทกำลังรอสแกน QR Code และยืนยันรหัส...");
            const qrPath = path.join(__dirname, '../public', 'line-qr-code.png');
            
            let isLoggedIn = false;
            // ให้บอทถ่ายรูปอัปเดตหน้าจอซ้ำๆ ทุกๆ 2 วินาที (รวม 60 วินาที)
            for (let i = 0; i < 30; i++) {
                await page.screenshot({ path: qrPath }).catch(()=>{}); 
                
                // เช็คว่ายืนยันรหัสผ่าน ทะลุเข้าหน้าแชทหรือยัง
                const chatReady = await page.$('.mdCMN09Li');
                if (chatReady) {
                    isLoggedIn = true;
                    console.log("✅ ยืนยันรหัสสำเร็จ! เข้าสู่ระบบแล้ว");
                    break;
                }
                await wait(2000); 
            }

            if (!isLoggedIn) {
                return { success: false, error: 'หมดเวลา! กรุณากด "ดึงกลุ่ม" ใหม่' };
            }
            
            await wait(3000); 
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
        const errPath = path.join(__dirname, '../public', 'line-qr-code.png');
        await page.screenshot({ path: errPath }).catch(()=>{});
        return { success: false, error: 'โหลดช้าหรือมีข้อผิดพลาด (ลองใหม่อีกครั้ง)' };
    } finally {
        await browser.close();
    }
}

// 🟢 ฟังก์ชันที่ 2: สำหรับยิงส่งข้อความและรายงานผล
async function runLinePersonalBot(job) {
    console.log(`[LINE-BOT] เริ่มส่งข้อความบัญชี ID: ${job.lineAccountId}`);
    const browser = await launchLineBrowser(job.lineAccountId);
    const page = await browser.newPage();
    const wait = (ms) => new Promise(res => setTimeout(res, ms));

    try {
        await page.goto('chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html', { waitUntil: 'networkidle2' });
        await wait(3000);

        const isLoginPage = await page.$('input[placeholder="Email address"], input[type="text"], #id');
        if (isLoginPage) {
            return 'FAILED'; 
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

        // 🌟 เพิ่มการส่งรายงานผลตรงนี้หลังจากส่งข้อความเสร็จ!
        // 💡 พี่สามารถเปลี่ยน 'แอดมินบ้านแชร์' เป็นชื่อแชทที่ลูกค้าต้องการให้รายงานผลได้เลยครับ
        const targetAdminName = 'แอดมินบ้านแชร์'; 
        const reportMessage = `✅ ระบบจองแชร์ทำงานเสร็จสิ้น\nเป้าหมาย: ${job.targetUrl}\nจำนวน: ${repeatCount} รอบเรียบร้อยครับ`;
        await sendLineReport(page, targetAdminName, reportMessage);

        return 'SUCCESS';
    } catch (e) {
        console.error("❌ Send Error:", e.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runLinePersonalBot, syncLineGroups };
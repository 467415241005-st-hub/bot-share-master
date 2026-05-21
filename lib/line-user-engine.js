// lib/line-user-engine.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function runLinePersonalBot(job) {
    const userDataDir = path.join(__dirname, `../sessions/line_user_${job.lineAccountId}`);
    
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
    }

    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: true, 
        viewport: { width: 1280, height: 720 },
        args: ['--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    
    try {
        // ไปที่ตัวจำลอง LINE Web Client หรือ Web Interface สำหรับ Login
        await page.goto('https://line.me/th/'); 

        // Logic การจัดการสิทธิ์ล็อกอินแบบคุ้กกี้ หรือข้อมูลบัญชี
        if (job.lineAccount.loginType === 'CREDENTIALS' && job.lineAccount.lineEmail) {
            await page.fill('input[name="email"]', job.lineAccount.lineEmail);
            await page.fill('input[name="password"]', job.lineAccount.linePassword);
            await page.click('button[type="submit"]');
        } 
        
        await page.waitForTimeout(5000); 

        // [ระบบค้นหาห้องแชท]: ค้นหาและเข้าห้องแชทตามชื่อกลุ่ม
        console.log(`[LINE] เข้ากลุ่มเป้าหมาย (ค้นหาชื่อ): "${job.targetUrl}"`);
        
        try {
            // 1. รอให้ช่องค้นหาของ LINE โหลดเสร็จ แล้วพิมพ์ชื่อกลุ่ม
            await page.waitForSelector('input.mdSearchInput__input', { timeout: 10000 });
            await page.fill('input.mdSearchInput__input', job.targetUrl);
            
            // 2. หน่วงเวลาให้ LINE โหลดรายชื่อแชทที่ค้นหาขึ้นมา (สำคัญมาก ห้ามข้าม)
            await page.waitForTimeout(2000); 

            // 3. คลิกเลือกแชทที่ชื่อตรงกับที่ค้นหา
            const chatSelector = page.locator(`.mdChatList__title:has-text("${job.targetUrl}")`).first();
            await chatSelector.waitFor({ state: 'visible', timeout: 5000 });
            await chatSelector.click();
            
            // 4. รอให้กล่องพิมพ์ข้อความพร้อม
            await page.waitForSelector('textarea#chat_input_text', { timeout: 5000 });
            console.log(`[LINE] เข้าห้องแชท "${job.targetUrl}" สำเร็จ`);
        } catch (e) {
            console.log(`[LINE] หาชื่อกลุ่มไม่พบ หรือ Selector อาจไม่ถูกต้อง ข้ามการค้นหา...`);
        }

        // ⭐ ⭐ เพิ่มระบบดักจับคีย์เวิร์ด (จองหลังเรท) สำหรับไลน์ ⭐ ⭐
        if (job.mode === 'KEYWORD' && job.keyword) {
            console.log(`[LINE] เริ่มทำงานโหมดจับคีย์เวิร์ด รอดูดข้อความเรท: "${job.keyword}"`);
            let isMatched = false;
            
            // วนลูปอ่านค่าแชทตัวล่าสุดในหน้าต่าง LINE ทุกๆ 1.5 วินาที สแกนสูงสุด 1,000 รอบ (ประมาณ 25 นาที)
            for (let checkLoop = 0; checkLoop < 1000; checkLoop++) {
                const latestText = await page.evaluate(() => {
                    // ใช้ตัวคัดกรองอ่าน Bubble แชทตัวล่างสุดบนหน้าเว็บ LINE
                    const bubbles = document.querySelectorAll('.mdmLIstMessage, [class*="message-text"], [class*="bubble"]');
                    return bubbles.length > 0 ? bubbles[bubbles.length - 1].innerText : '';
                });

                if (latestText.includes(job.keyword)) {
                    console.log(`[LINE] ตรวจเจอข้อความคีย์เวิร์ดเรียบร้อย: "${job.keyword}"! กำลังส่งข้อความจองทันที...`);
                    isMatched = true;
                    break;
                }

                // หน่วงเวลา 1.5 วินาทีก่อนวนสแกนประโยคถัดไป
                await page.waitForTimeout(1500); 
            }

            if (!isMatched) {
                console.log(`[LINE] หมดเวลารอคีย์เวิร์ด ไม่พบข้อความหลังเรทในกลุ่มตามเวลาที่กำหนด`);
                return 'FAILED';
            }
        }

        // ขั้นตอนการคอมเมนต์และส่งข้อความจองตามจำนวนครั้ง (repeat)
        const repeatCount = job.repeat || 1;
        for (let i = 0; i < repeatCount; i++) {
            // โค้ดส่งจริงผ่านหน้าจอดิจิทัล Playwright
            try {
                // ลองใช้ Selector ของช่องแชทถ้ามี
                await page.fill('textarea#chat_input_text', job.message);
                await page.keyboard.press('Enter');
            } catch (e) {
                // สำรองกรณี Selector พัง ให้พิมพ์สดไปเลย
                await page.keyboard.type(job.message);
                await page.keyboard.press('Enter');
            }
            console.log(`[LINE] ส่งสำเร็จ รอบที่ ${i+1}/${repeatCount} -> ข้อความ: "${job.message}"`);
            if (i < repeatCount - 1) await page.waitForTimeout(1500);
        }

        return 'SUCCESS';
    } catch (error) {
        console.error("LINE Engine Error:", error);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runLinePersonalBot };
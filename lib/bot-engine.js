const puppeteer = require('puppeteer');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: true, // ตั้งเป็น false หากต้องการดูหน้าจอบอททำงานสดๆเพื่อแก้บั๊ก
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-notifications', 
            '--disable-blink-features=AutomationControlled'
        ] 
    });
    const page = await browser.newPage();

    // 🌟 จำลองเป็นเบราว์เซอร์คนจริงๆ (สำคัญมากป้องกันเฟสบุ๊คบล็อกการล็อกอิน)
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
        // ⭐ 1. ระบบล็อกอิน (รองรับทั้ง Cookies และ Email/Password)
        const cookies = JSON.parse(job.account.cookies || "[]");
        
        if (cookies && cookies.length > 0) {
            console.log(`[FB] ล็อกอินด้วย Cookies...`);
            await page.setCookie(...cookies);
        } else if (job.account.fbEmail && job.account.fbPassword) {
            console.log(`[FB] ล็อกอินด้วยอีเมล: ${job.account.fbEmail}`);
            // ใช้หน้าล็อกอินหลักของเฟสบุ๊ค
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 });
            
            // เช็คว่ามีช่องอีเมลให้กรอกหรือไม่
            const emailInput = await page.$('#email');
            if (emailInput) {
                await page.type('#email', job.account.fbEmail, { delay: 50 });
                await page.type('#pass', job.account.fbPassword, { delay: 50 });
                await page.click('[name="login"]');
                
                console.log(`[FB] กดปุ่ม Login แล้ว กำลังรอระบบเฟสบุ๊คโหลด...`);
                // รอจนกว่าจะเปลี่ยนหน้าเสร็จ (เผื่อติดโหลดช้า)
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => console.log('[FB] หมดเวลารอโหลดหน้าเว็บ แต่จะลองรันต่อ...'));
            } else {
                console.log(`[FB] ไม่พบช่องล็อกอิน (อาจจะล็อกอินค้างไว้อยู่แล้ว)`);
            }
        } else {
            throw new Error("ไม่มีข้อมูลสำหรับล็อกอิน (อีเมล หรือ คุกกี้)");
        }

        // ⭐ 2. ไปยังโพสต์เป้าหมาย
        console.log(`[FB] กำลังไปยังโพสต์เป้าหมาย...`);
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.waitForTimeout(3000); // หน่วงเวลารอให้คอมเมนต์โหลดเสร็จ

        // ⭐ 3. ระบบดักจับคีย์เวิร์ด (โหมดจับคีย์เวิร์ด)
        if (job.mode === 'KEYWORD' && job.keyword) {
            const pageText = await page.evaluate(() => document.body.innerText);
            if (!pageText.includes(job.keyword)) {
                console.log(`⏳ [FB] ยังไม่พบคำว่า "${job.keyword}" ในโพสต์นี้...`);
                return 'WAITING'; 
            }
            console.log(`🎯 [FB] เจอคีย์เวิร์ด "${job.keyword}" แล้ว! เริ่มทำงาน...`);
        }

        // ⭐ 4. ระบบค้นหาช่องพิมพ์และคอมเมนต์
        const repeatCount = parseInt(job.repeat) || 1;
        let successCount = 0;

        for (let i = 0; i < repeatCount; i++) {
            try {
                // ค้นหาช่องคอมเมนต์ (อัปเดต Selector เผื่อไว้ทั้ง Desktop และ Mobile)
                const commentBoxSelector = 'div[contenteditable="true"][role="textbox"], textarea[aria-label="เขียนความคิดเห็น..."], textarea[name="add_comment_text_text"]';
                await page.waitForSelector(commentBoxSelector, { timeout: 15000 }); 
                
                // สั่งเลื่อนจอไปหาช่องคอมเมนต์ (กันมันมองไม่เห็น)
                await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if(el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, commentBoxSelector);
                await page.waitForTimeout(1000);
                
                // คลิกที่ช่องพิมพ์ แล้วค่อยพิมพ์ข้อความ
                await page.click(commentBoxSelector);
                await page.waitForTimeout(500);
                await page.keyboard.type(job.message, { delay: 30 }); // พิมพ์ช้าๆ ให้เหมือนคน
                await page.waitForTimeout(500); // หน่วงรอนิดนึงก่อนกด Enter
                await page.keyboard.press('Enter');
                
                console.log(`✅ [FB] คอมเมนต์รอบที่ ${i+1}/${repeatCount} สำเร็จ`);
                successCount++;
                
                if (i < repeatCount - 1) {
                    await page.waitForTimeout(3000); // หน่วงเวลา 3 วิ กันเฟสบุ๊คบล็อกสแปม
                }
            } catch (commentErr) {
                console.error(`❌ [FB] ไม่สามารถคอมเมนต์รอบที่ ${i+1} ได้:`, commentErr.message);
            }
        }

        // ถ้ารันผ่านอย่างน้อย 1 รอบถือว่าสำเร็จ
        return successCount > 0 ? 'SUCCESS' : 'FAILED'; 
    } catch (error) {
        console.error("❌ [FB] บอททำงานพลาด (Error):", error.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runCommentBot };
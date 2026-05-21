const puppeteer = require('puppeteer');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: true, // ตั้งเป็น false หากต้องการดูหน้าจอบอททำงานสดๆ
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications', '--disable-blink-features=AutomationControlled'] 
    });
    const page = await browser.newPage();

    try {
        // ⭐ 1. ระบบล็อกอิน (รองรับทั้ง Cookies และ Email/Password)
        const cookies = JSON.parse(job.account.cookies || "[]");
        
        if (cookies && cookies.length > 0) {
            console.log(`[FB] ล็อกอินด้วย Cookies...`);
            await page.setCookie(...cookies);
        } else if (job.account.fbEmail && job.account.fbPassword) {
            console.log(`[FB] ล็อกอินด้วยอีเมล: ${job.account.fbEmail}`);
            // ไปหน้าล็อกอินมือถือ (m.facebook) จะโหลดไวกว่าและบอททำงานง่ายกว่า
            await page.goto('https://m.facebook.com/login', { waitUntil: 'networkidle2' });
            await page.waitForSelector('input[name="email"]', { timeout: 10000 });
            await page.type('input[name="email"]', job.account.fbEmail);
            await page.type('input[name="pass"]', job.account.fbPassword);
            await page.click('button[name="login"]');
            
            // หน่วงเวลารอให้เฟสบุ๊คโหลดหน้าล็อกอินเสร็จ
            await page.waitForTimeout(5000); 
        } else {
            throw new Error("ไม่มีข้อมูลสำหรับล็อกอิน (อีเมล หรือ คุกกี้)");
        }

        // ⭐ 2. ไปยังโพสต์เป้าหมาย
        console.log(`[FB] กำลังไปยังโพสต์เป้าหมาย...`);
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

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
        for (let i = 0; i < repeatCount; i++) {
            
            // ค้นหาช่องคอมเมนต์ (ใช้ Selector ที่แม่นยำขึ้น)
            const commentBoxSelector = 'div[contenteditable="true"][role="textbox"]';
            await page.waitForSelector(commentBoxSelector, { timeout: 15000 }); 
            
            // คลิกที่ช่องพิมพ์ แล้วค่อยพิมพ์ข้อความ
            await page.click(commentBoxSelector);
            await page.keyboard.type(job.message);
            await page.waitForTimeout(500); // หน่วงรอนิดนึงก่อนกด Enter
            await page.keyboard.press('Enter');
            
            console.log(`✅ [FB] คอมเมนต์รอบที่ ${i+1}/${repeatCount} สำเร็จ`);
            
            if (i < repeatCount - 1) {
                await page.waitForTimeout(2500); // กันโดนบล็อกสแปม
            }
        }

        return 'SUCCESS'; 
    } catch (error) {
        console.error("❌ [FB] บอททำงานพลาด:", error.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runCommentBot };
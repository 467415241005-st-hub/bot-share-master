const puppeteer = require('puppeteer');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: true, // เปลี่ยนเป็น false ถ้ารันในคอมตัวเองเพื่อดูการทำงาน
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-notifications', 
            '--disable-blink-features=AutomationControlled'
        ] 
    });
    const page = await browser.newPage();

    // 🌟 จำลองเป็นเบราว์เซอร์คนจริงๆ 
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
        // ⭐ 1. ระบบล็อกอินแบบหน้าจอคอม (Standard Facebook)
        const cookies = JSON.parse(job.account.cookies || "[]");
        
        if (cookies && cookies.length > 0) {
            console.log(`[FB] ล็อกอินด้วย Cookies...`);
            await page.setCookie(...cookies);
        } else if (job.account.fbEmail && job.account.fbPassword) {
            console.log(`[FB] ล็อกอินด้วยอีเมล: ${job.account.fbEmail}`);
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 });
            
            const emailInput = await page.$('#email');
            if (emailInput) {
                await page.type('#email', job.account.fbEmail, { delay: 50 });
                await page.type('#pass', job.account.fbPassword, { delay: 50 });
                await page.click('[name="login"]');
                console.log(`[FB] กดปุ่ม Login แล้ว กำลังรอระบบเฟสบุ๊คโหลด...`);
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
            }
        } else {
            throw new Error("ไม่มีข้อมูลสำหรับล็อกอิน (อีเมล หรือ คุกกี้)");
        }

        // ⭐ 2. ไปยังโพสต์เป้าหมาย
        console.log(`[FB] กำลังไปยังโพสต์เป้าหมาย: ${job.targetUrl}`);
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.waitForTimeout(4000); // หน่วงเวลาให้เฟสบุ๊คโหลด 100%

        // ⭐ 3. ระบบดักจับคีย์เวิร์ด
        if (job.mode === 'KEYWORD' && job.keyword) {
            const pageText = await page.evaluate(() => document.body.innerText);
            if (!pageText.includes(job.keyword)) {
                console.log(`⏳ [FB] ยังไม่พบคำว่า "${job.keyword}" ในโพสต์นี้...`);
                return 'WAITING'; 
            }
            console.log(`🎯 [FB] เจอคีย์เวิร์ด "${job.keyword}" แล้ว! เริ่มทำงาน...`);
        }

        // ⭐ 4. ระบบค้นหาช่องพิมพ์ พิมพ์ และกดปุ่มส่ง
        const repeatCount = parseInt(job.repeat) || 1;
        let successCount = 0;

        for (let i = 0; i < repeatCount; i++) {
            try {
                // 🎯 ค้นหาช่องคอมเมนต์แบบ Standard UI
                const commentBoxSelector = 'div[role="textbox"][contenteditable="true"]';
                await page.waitForSelector(commentBoxSelector, { timeout: 15000 }); 
                
                const commentBoxes = await page.$$(commentBoxSelector);
                
                if (commentBoxes.length > 0) {
                    const targetBox = commentBoxes[commentBoxes.length - 1]; // เลือกกล่องล่างสุด หรือจะใช้ [0] ก็ได้
                    
                    await page.evaluate((el) => {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, targetBox);
                    await page.waitForTimeout(1000);
                    
                    // ✅ สเต็ปที่ 1: คลิกลงไปในช่องคอมเมนต์
                    await targetBox.click();
                    await page.waitForTimeout(500);
                    
                    // ✅ สเต็ปที่ 2: พิมพ์ข้อความ
                    await page.keyboard.type(job.message, { delay: 40 }); 
                    await page.waitForTimeout(1000);
                    
                    // ✅ สเต็ปที่ 3: หาปุ่มส่งแล้วคลิก (แทนการกด Enter)
                    try {
                        // ปกติพอพิมพ์เสร็จ ปุ่มไอคอนส่งจะโผล่มา และมี aria-label เหล่านี้
                        const sendBtnSelector = 'div[aria-label="แสดงความคิดเห็น"], div[aria-label="Comment"], div[aria-label="ส่ง"], div[aria-label="Send"]';
                        const sendButton = await page.$(sendBtnSelector);
                        
                        if (sendButton) {
                            await sendButton.click();
                            console.log(`[FB] คลิกลงที่ปุ่มส่งคอมเมนต์สำเร็จ`);
                        } else {
                            // ถ้าหาปุ่มไม่เจอจริงๆ ค่อยสำรองใช้ Enter
                            await page.keyboard.press('Enter');
                            console.log(`[FB] หาปุ่มส่งไม่เจอ ใช้การกด Enter แทน`);
                        }
                    } catch (btnErr) {
                        await page.keyboard.press('Enter');
                    }
                    
                    console.log(`✅ [FB] คอมเมนต์รอบที่ ${i+1}/${repeatCount} สำเร็จ`);
                    successCount++;
                    
                    if (i < repeatCount - 1) {
                        await page.waitForTimeout(4000); // หน่วงเวลากันบล็อก
                    }
                } else {
                    console.log(`❌ [FB] หาช่องคอมเมนต์แบบ div ไม่เจอในหน้านี้`);
                }
            } catch (commentErr) {
                console.error(`❌ [FB] ไม่สามารถคอมเมนต์รอบที่ ${i+1} ได้:`, commentErr.message);
            }
        }

        return successCount > 0 ? 'SUCCESS' : 'FAILED'; 
    } catch (error) {
        console.error("❌ [FB] บอททำงานพลาด (Error):", error.message);
        return 'FAILED';
    } finally {
        await browser.close();
    }
}

module.exports = { runCommentBot };
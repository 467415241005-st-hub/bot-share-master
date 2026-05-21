const puppeteer = require('puppeteer');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: true, // ลองเปลี่ยนเป็น false ถ้ารันในเครื่องตัวเอง เพื่อดูว่ามันติดหน้าไหน
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
            // ใช้หน้า mbasic เพื่อลดความซับซ้อนของ HTML และโหลดไวกว่า
            await page.goto('https://mbasic.facebook.com/', { waitUntil: 'networkidle2', timeout: 30000 });
            
            // เช็คว่ามีช่องอีเมลให้กรอกหรือไม่ (สำหรับ mbasic.facebook.com)
            const emailInput = await page.$('input[name="email"]');
            if (emailInput) {
                await page.type('input[name="email"]', job.account.fbEmail, { delay: 50 });
                await page.type('input[name="pass"]', job.account.fbPassword, { delay: 50 });
                await page.click('input[name="login"]');
                
                console.log(`[FB] กดปุ่ม Login แล้ว กำลังรอระบบเฟสบุ๊คโหลด...`);
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => console.log('[FB] หมดเวลารอโหลดหน้าเว็บ แต่จะลองรันต่อ...'));
            } else {
                console.log(`[FB] ไม่พบช่องล็อกอิน (อาจจะล็อกอินค้างไว้อยู่แล้ว)`);
            }
        } else {
            throw new Error("ไม่มีข้อมูลสำหรับล็อกอิน (อีเมล หรือ คุกกี้)");
        }

        // ⭐ 2. แปลงลิงก์เป้าหมายไปเป็น mbasic.facebook.com 
        let targetUrl = job.targetUrl;
        if (targetUrl.includes('www.facebook.com')) {
            targetUrl = targetUrl.replace('www.facebook.com', 'mbasic.facebook.com');
        } else if (targetUrl.includes('m.facebook.com')) {
            targetUrl = targetUrl.replace('m.facebook.com', 'mbasic.facebook.com');
        }
        
        console.log(`[FB] กำลังไปยังโพสต์เป้าหมาย: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.waitForTimeout(2000); 

        // ⭐ 3. ระบบดักจับคีย์เวิร์ด (โหมดจับคีย์เวิร์ด)
        if (job.mode === 'KEYWORD' && job.keyword) {
            const pageText = await page.evaluate(() => document.body.innerText);
            if (!pageText.includes(job.keyword)) {
                console.log(`⏳ [FB] ยังไม่พบคำว่า "${job.keyword}" ในโพสต์นี้...`);
                return 'WAITING'; 
            }
            console.log(`🎯 [FB] เจอคีย์เวิร์ด "${job.keyword}" แล้ว! เริ่มทำงาน...`);
        }

        // ⭐ 4. ระบบค้นหาช่องพิมพ์และคอมเมนต์ (mbasic.facebook.com)
        const repeatCount = parseInt(job.repeat) || 1;
        let successCount = 0;

        for (let i = 0; i < repeatCount; i++) {
            try {
                // สำหรับ mbasic ช่องคอมเมนต์จะเป็น textarea ธรรมดาที่มี name="comment_text" 
                // หรือมี action link สำหรับเข้าไปหน้าคอมเมนต์
                
                // เช็คว่ามีกล่องข้อความให้พิมพ์เลยไหม
                let commentInput = await page.$('textarea[name="comment_text"]');
                
                if (!commentInput) {
                    // ถ้าไม่มี ต้องหาลิงก์ "แสดงความคิดเห็น" หรือ "Comment" แล้วคลิกเข้าไปก่อน
                    const commentLinks = await page.$$('a');
                    for (const link of commentLinks) {
                        const text = await page.evaluate(el => el.innerText, link);
                        if (text.includes('แสดงความคิดเห็น') || text.includes('Comment')) {
                            await link.click();
                            await page.waitForNavigation({ waitUntil: 'networkidle2' });
                            break;
                        }
                    }
                    commentInput = await page.$('textarea[name="comment_text"]');
                }

                if (commentInput) {
                    await page.type('textarea[name="comment_text"]', job.message, { delay: 30 });
                    await page.waitForTimeout(500); 
                    // กดปุ่มส่ง (ปุ่มมักจะเขียนว่า แสดงความคิดเห็น / Post)
                    await page.click('input[value="แสดงความคิดเห็น"], input[value="Post"], input[type="submit"]');
                    
                    console.log(`✅ [FB] คอมเมนต์รอบที่ ${i+1}/${repeatCount} สำเร็จ`);
                    successCount++;
                    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
                } else {
                    console.error(`❌ [FB] หาช่องพิมพ์ไม่เจอในหน้าเว็บ`);
                }
                
                if (i < repeatCount - 1) {
                    await page.waitForTimeout(3000); // หน่วงเวลา 3 วิ กันเฟสบุ๊คบล็อกสแปม
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
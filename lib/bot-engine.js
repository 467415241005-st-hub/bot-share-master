const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

async function runCommentBot(job) {
    const browser = await puppeteer.launch({ 
        headless: 'new', 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-notifications', 
            '--window-size=1280,1024',
            '--disable-blink-features=AutomationControlled',
            '--lang=th-TH,th'
        ] 
    });
    const page = await browser.newPage();
    
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8' });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 1024 });

    try {
        console.log(`[FB] เริ่มทำงานจองแชร์โพสต์: ${job.targetUrl}`);

        // ⭐ 1. ระบบล็อกอิน
        const cookies = JSON.parse(job.account.cookies || "[]");
        if (cookies && cookies.length > 0) {
            await page.setCookie(...cookies);
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 60000 });
        } else if (job.account.fbEmail && job.account.fbPassword) {
            await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2', timeout: 60000 });
            const emailInput = await page.$('#email');
            if (emailInput) {
                await page.type('#email', job.account.fbEmail, { delay: 50 });
                await page.type('#pass', job.account.fbPassword, { delay: 50 });
                await page.click('[name="login"]');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{});
            }
        }

        // ⭐ 2. ไปหน้าโพสต์เป้าหมาย
        await page.goto(job.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForTimeout(5000); 

        // ⭐ สคริปต์กวาดล้าง Pop-up ที่บังจอ
        try {
            const closeSelectors = [
                'div[aria-label="ปิด"]', 'div[aria-label="Close"]', 
                'div[aria-label="ไม่ใช่ตอนนี้"]', 'div[aria-label="Not Now"]',
                'div[aria-label="ปฏิเสธ"]', 'div[aria-label="Decline"]'
            ];
            for (let sel of closeSelectors) {
                const btns = await page.$$(sel);
                for(let btn of btns) { await btn.click().catch(()=>{}); }
            }
            await page.waitForTimeout(1000);
        } catch(e) {}

        // ⭐ 3. โหมดจับคีย์เวิร์ด
        if (job.mode === 'KEYWORD' && job.keyword) {
            const pageText = await page.evaluate(() => document.body.innerText);
            if (!pageText.includes(job.keyword)) {
                console.log(`⏳ [FB] ยังไม่พบคำว่า "${job.keyword}" รอรอบถัดไป...`);
                return 'WAITING';
            }
        }

        // ⭐ 4. พิมพ์และส่งข้อความ (ระบบ HYBRID ยิง 2 ชั้น)
        const repeatCount = parseInt(job.repeat) || 1;
        let successCount = 0;

        for (let i = 0; i < repeatCount; i++) {
            let commented = false;

            // --- [วิธีที่ 1] พยายามคอมเมนต์ผ่านหน้าจอคอมพิวเตอร์ปกติ (Standard UI) ---
            const commentSelectors = [
                'div[aria-label="เขียนความคิดเห็น..."][role="textbox"]',
                'div[aria-label="Write a comment..."][role="textbox"]',
                'div[role="textbox"][contenteditable="true"]'
            ];
            
            let targetBox = null;
            for (let sel of commentSelectors) {
                const elements = await page.$$(sel);
                if (elements.length > 0) {
                    for (let el of elements.reverse()) {
                        const isVisible = await page.evaluate(e => {
                            const rect = e.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        }, el);
                        if (isVisible) { targetBox = el; break; }
                    }
                }
                if (targetBox) break;
            }

            if (targetBox) {
                await page.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), targetBox);
                await page.waitForTimeout(1000);
                await targetBox.click().catch(async () => await page.evaluate(el => el.focus(), targetBox));
                await page.waitForTimeout(500);
                await page.keyboard.type(job.message, { delay: 40 });
                await page.waitForTimeout(1000);
                
                try {
                    const sendBtn = await page.$('div[aria-label="แสดงความคิดเห็น"], div[aria-label="ส่ง"], div[aria-label="Comment"], div[aria-label="Send"]');
                    if (sendBtn) await sendBtn.click();
                    else await page.keyboard.press('Enter');
                } catch (e) {
                    await page.keyboard.press('Enter');
                }
                
                console.log(`✅ [FB] คอมเมนต์ (โหมดปกติ) รอบที่ ${i+1}/${repeatCount} สำเร็จ`);
                commented = true;
                successCount++;
            } 
            
            // --- [วิธีที่ 2] หากโหมดปกติล้มเหลว สลับเข้า mbasic อัตโนมัติ (เสถียร ชัวร์ 100%) ---
            if (!commented) {
                console.log(`⚠️ [FB] โหมดปกติหาช่องคอมเมนต์ไม่เจอ! สลับไปโหมด mbasic...`);
                let mbasicUrl = job.targetUrl.replace('www.facebook.com', 'mbasic.facebook.com').replace('m.facebook.com', 'mbasic.facebook.com');
                await page.goto(mbasicUrl, { waitUntil: 'networkidle2', timeout: 45000 });
                await page.waitForTimeout(2000);

                let commentInput = await page.$('textarea[name="comment_text"]');
                if (!commentInput) {
                    const links = await page.$$('a');
                    for (let link of links) {
                        const text = await page.evaluate(el => el.innerText, link);
                        if (text && (text.includes('แสดงความคิดเห็น') || text.includes('Comment') || text.includes('ความคิดเห็น'))) {
                            await link.click();
                            await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(()=>{});
                            break;
                        }
                    }
                    commentInput = await page.$('textarea[name="comment_text"]');
                }

                if (commentInput) {
                    await page.type('textarea[name="comment_text"]', job.message, { delay: 30 });
                    await page.waitForTimeout(500);
                    await page.click('input[value="แสดงความคิดเห็น"], input[value="Post"], input[type="submit"]');
                    
                    console.log(`✅ [FB] คอมเมนต์ (โหมด mbasic) รอบที่ ${i+1}/${repeatCount} สำเร็จ`);
                    commented = true;
                    successCount++;
                    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(()=>{});
                }
            }

            if (!commented) {
                console.log(`❌ [FB] ล้มเหลว: ไม่พบช่องคอมเมนต์ทั้ง 2 โหมด`);
                throw new Error("หาช่องคอมเมนต์ไม่เจอ (อาจจะไม่มีสิทธิ์คอมเมนต์โพสต์นี้)");
            }

            if (i < repeatCount - 1) await page.waitForTimeout(4000); 
        }

        return successCount > 0 ? 'SUCCESS' : 'FAILED'; 

    } catch (error) {
        console.error("❌ [FB] Error:", error.message);
        const publicDir = path.join(__dirname, '../public');
        if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
        const jobIdStr = job.id ? job.id : Date.now();
        const errorImgPath = path.join(publicDir, `error-fb-${jobIdStr}.png`);
        await page.screenshot({ path: errorImgPath, fullPage: true }).catch(()=>{});
        return 'FAILED';
    } finally {  
        await browser.close();
    }
}

module.exports = { runCommentBot };
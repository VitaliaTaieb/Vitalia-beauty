const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { chromium } = require('playwright');

(async () => {
  const server = createServer((req, res) => {
    const file = req.url.split('?')[0] === '/admin.html' ? 'admin.html' : 'index.html';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
    const base = `http://127.0.0.1:${server.address().port}`;
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 1);
    const day = date.toISOString().slice(0, 10);
    const services = [1, 2].map(id => ({ id, 'salon_id.': id, name: 'טיפול '+id,
      price: 120 + id, duration_minutes: 60, break_after_minutes: 15 }));
    const imported = { ...services[0], id: 99, name: 'Imported internal', import_only: true };
    const token = 'a'.repeat(64);
    for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      const errors = [], submissions = [];
      await context.route('https://challenges.cloudflare.com/**', route => route.fulfill({ contentType: 'application/javascript',
        body: 'window.turnstile={render:(selector,opts)=>{queueMicrotask(()=>opts.callback("test-challenge-token"));return 0},reset:()=>{}};' }));
      await context.route('https://*.supabase.co/**', async route => {
        const req = route.request(), url = new URL(req.url()); let data = [];
        if (url.pathname.endsWith('/services')) data = [...services, imported];
        if (url.pathname.endsWith('/salons')) data = [{id:1,address:'Address 1'},{id:2,address:'Address 2'}];
        if (url.pathname.endsWith('/available_slots')) data = [1,2].map(salon_id => ({salon_id,work_date:day,start_time:'09:00:00',end_time:'18:00:00'}));
        if (url.pathname.includes('/functions/')) {
          const body = req.postDataJSON();
          if (body.action === 'availability') data = {busy:[],overrides:[],holiday:null};
          else if (body.action === 'my_booking') data = {booking:{starts_at:day+'T10:00:00+02:00',status:'confirmed'},salon:{name:'Vitalia',address:'Address'},service:{name:'טיפול'}};
          else { submissions.push(body); data = {booking:{id:42},client_token:token}; }
        }
        await route.fulfill({json:data});
      });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      for (const salon of [1,2]) {
        await page.goto(base);
        await page.locator(`button[onclick="openBooking(${salon})"]`).click();
        await page.locator('#service option[value="'+salon+'"]').waitFor({state:'attached'});
        assert.equal(await page.locator('#service option').count(), 2, 'separate menu excludes imported procedures');
        await page.locator('#clientName').fill('Test Customer');
        await page.locator('#clientPhone').fill('0501234567');
        await page.locator('#service').selectOption(String(salon));
        await page.locator('#bookingDate').click();
        const shown = await page.evaluate(() => monthCursor.getMonth());
        if (shown !== date.getMonth()) await page.locator('#nextMonth').click();
        await page.locator('#calendarDays button.available').filter({hasText:new RegExp('^'+date.getDate()+'$')}).click();
        await page.locator('#bookingTime option[value="10:00"]').waitFor({state:'attached'});
        await page.locator('#bookingTime').selectOption('10:00');
        await page.locator('#submitBooking').click();
        await page.getByText('התור נקבע בהצלחה!',{exact:false}).waitFor();
        assert.match(await page.locator('#myBookings').innerText(), /טיפול/);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('vitalia_my_bookings'))[0]),token);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
        await page.locator('#closeBooking').click();
      }
      assert.equal(submissions.length,2); assert.deepEqual(submissions.map(x=>x.salon_id),[1,2]);
      assert.deepEqual(errors,[]);
      console.log(`PASS customer booking, separate menus, lookup, layout at ${viewport.width}px`);
      // Saved login is refreshed, then reused after reload; the password is never stored.
      await context.unroute('https://*.supabase.co/**');
      let refreshes = 0;
      await context.route('https://*.supabase.co/**', async route => {
        const req=route.request(),url=new URL(req.url());let data={};
        if(url.pathname.includes('/auth/v1/token')){refreshes++;data={access_token:'fresh.jwt',refresh_token:'rotated',expires_in:3600};}
        else if(url.pathname.includes('/functions/')){
          const body=req.postDataJSON();
          assert.equal(req.headers().authorization,'Bearer fresh.jwt');
          data=body.action==='calendar'?{bookings:[],slots:[],holidays:[]}:{slots:[],bookings:[],overrides:[],breaks:[],services:services.filter(x=>x['salon_id.']===body.salon_id)};
        }
        await route.fulfill({json:data});
      });
      await page.evaluate(()=>localStorage.setItem('vitalia_admin_session',JSON.stringify({access_token:'old.jwt',refresh_token:'old-refresh',expires_at:1})));
      await page.goto(base+'/admin.html');
      await page.locator('#dashboard').waitFor({state:'visible'});
      await page.reload();await page.locator('#dashboard').waitFor({state:'visible'});
      assert.equal(refreshes,1);
      await page.locator('#lang').selectOption('he');
      assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.locator('#signout').click();await page.locator('#authCard').waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>localStorage.getItem('vitalia_admin_session')),null);
      assert.deepEqual(errors,[]);
      console.log(`PASS persistent admin login, refresh, Hebrew, logout at ${viewport.width}px`);
      await context.close();
    }
  } finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});

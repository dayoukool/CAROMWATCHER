# Test de bout en bout : Chrome sans écran, import d'une vidéo, calibrage au doigt, attente du verdict.
import sys, json
from playwright.sync_api import sync_playwright
CORNERS = [[96, 58], [548, 60], [612, 330], [28, 326]]
page_url = 'file:///home/claude/carambole/docs/index.html'
videos = sys.argv[1:] or ['/tmp/coup16.mp4']
with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
    pg = br.new_page(viewport={'width': 412, 'height': 900}, device_scale_factor=2)
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(page_url)
    for n, v in enumerate(videos):
        pg.set_input_files('#file', v)
        if n == 0:
            pg.wait_for_selector('#calibBar:not([hidden])', timeout=20000)
            pg.screenshot(path='/tmp/shot_calib0.png')
            box = pg.locator('#view').bounding_box()
            for (x, y) in CORNERS:
                pg.mouse.click(box['x'] + x / 640 * box['width'], box['y'] + y / 360 * box['height'])
            pg.screenshot(path='/tmp/shot_calib.png')
            pg.click('#btnCalibOk')
        pg.wait_for_function(f"document.querySelector('#status').textContent.includes('analysée') && JSON.parse(localStorage.getItem('car.history')||'[]').length >= {n+1}", timeout=240000)
        print('images traitées', pg.evaluate("(() => { const d = window.__carambole; const t = d.times; let gaps = 0; for (let i = 1; i < t.length; i++) if (t[i] - t[i-1] > 0.025) gaps++; d.times = []; const n = d.frames; d.frames = 0; return {n, gaps}; })()"))
        pg.wait_for_timeout(500)
        res = pg.evaluate("document.querySelector('#result').innerText")
        print('--- vidéo', v, '\n', res[:900])
        pg.screenshot(path=f'/tmp/shot_result{n}.png', full_page=True)
    pg.click('nav button[data-tab=hist]')
    pg.wait_for_timeout(300)
    pg.screenshot(path='/tmp/shot_hist.png', full_page=True)
    print('erreurs console:', errs)
    br.close()

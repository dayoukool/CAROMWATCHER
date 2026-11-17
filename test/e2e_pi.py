# Test de bout en bout du mode Raspberry Pi : page servie par le Pi (caméra simulée), connexion automatique,
# étalonnage à 8 points au doigt, verdicts reçus en direct.
import sys, json
from playwright.sync_api import sync_playwright
url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8091/'
pts = json.load(open('/tmp/pts.json'))
with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    pg = br.new_page(viewport={'width': 412, 'height': 900}, device_scale_factor=2)
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(url)
    pg.wait_for_selector('#calibBar:not([hidden])', timeout=15000)
    pg.wait_for_timeout(800)
    box = pg.locator('#view').bounding_box()
    for i, (u, v) in enumerate(pts):
        pg.mouse.click(box['x'] + u * box['width'], box['y'] + v * box['height'])
        if i == 5: pg.screenshot(path='/tmp/pi_calib.png')
    pg.click('#btnCalibOk')
    pg.wait_for_timeout(1500)
    print('après calibrage :', pg.evaluate("document.querySelector('#piInfo').textContent"))
    pg.screenshot(path='/tmp/pi_live.png')
    pg.wait_for_function("JSON.parse(localStorage.getItem('car.history')||'[]').length >= 3", timeout=120000)
    pg.wait_for_timeout(300)
    print('statut :', pg.evaluate("document.querySelector('#status').textContent"))
    print('dernier verdict :', pg.evaluate("document.querySelector('#result .verdict').innerText.replace(/\\n/g,' ')"), '|', pg.evaluate("document.querySelector('#result .reason').innerText"))
    for h in pg.evaluate("JSON.parse(localStorage.getItem('car.history'))")[::-1]:
        print('  ', 'POINT' if h['valid'] else 'non  ', h['reason'], '|', h['effect']['label'])
    pg.screenshot(path='/tmp/pi_result.png', full_page=True)
    # correction envoyée au Pi
    pg.click('#result [data-fix="0"]')
    pg.wait_for_timeout(500)
    print('erreurs console :', errs)
    br.close()

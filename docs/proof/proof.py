# Browser proof for the Connect muse.ai card, the relabelled scenarios and the read-only tier card. Needs: npm ci && npm run build, then
#   node docs/proof/harness.mjs &   (three in-process copies of Muse on 5701-5703 with a stub fetch: nothing real is contacted)
#   python3 docs/proof/proof.py       (Playwright, headless Chromium; writes the PNGs next to this file)
import json, os, sys
from playwright.sync_api import sync_playwright
OUT = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)
res = []
def check(name, ok, extra=''):
    res.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name + (' :: ' + str(extra) if extra and not ok else ''))
def shot(loc, name):
    loc.screenshot(path=f'{OUT}/{name}.png')
def set_theme(page, t):
    page.evaluate("t => { document.documentElement.setAttribute('data-theme', t); }", t)
    page.wait_for_timeout(100)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={'width': 1100, 'height': 900}, permissions=['clipboard-read', 'clipboard-write'], color_scheme='light')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

    # ---- Mock ----
    page.goto('http://127.0.0.1:5701/'); page.wait_for_selector('[data-testid=connect-muse]')
    card = page.locator('[data-testid=connect-muse]')
    check('mock: card titled Connect muse.ai', page.get_by_role('heading', name='Connect muse.ai').is_visible())
    check('mock: says connector not enabled in this mode', 'not enabled in Mock mode' in card.inner_text())
    check('mock: no copy buttons', page.locator('[data-testid=cm-url-copy]').count() == 0)
    shot(card, 'connect-mock')
    # relabelled scenarios
    page.wait_for_selector('[data-testid=row-label-1]')
    labels = [page.locator(f'[data-testid=row-label-{n}]').inner_text() for n in range(1, 11)]
    check('mock: rows 1 reads Boston $480 SH103', labels[0].replace('\n', ' ').split() == ['Boston', '$480', 'SH103'], labels[0])
    check('mock: no row shows a bare flight id first', all(not l.strip().startswith('SH') for l in labels), labels)
    check('mock: Run aria-label', page.locator('[data-testid=run-1]').get_attribute('aria-label') == 'Run: Agent, Boston, $480')
    check('mock: Rules say still works', 'Denied by your rule' in page.locator('[data-testid=expect-3]').inner_text())
    page.locator('[data-testid=scenario-table]').scroll_into_view_if_needed()
    shot(page.locator('[data-testid=scenario-table]'), 'scenarios-mock-light')
    set_theme(page, 'dark'); shot(page.locator('[data-testid=scenario-table]'), 'scenarios-mock-dark'); set_theme(page, 'light')
    # a row still runs (same ids, Mock engine)
    page.locator('[data-testid=run-3]').click()
    page.get_by_role('button', name='Yes, I consent').click(timeout=10000)
    page.wait_for_selector('[data-testid=booking-banner]', timeout=10000)
    check('mock: row 3 (London $620 agent) still denied by your rule', 'booking stopped' in page.locator('[data-testid=booking-headline]').inner_text().lower() or page.locator('[data-testid=booking-banner]').get_attribute('data-status') == 'denied', page.locator('[data-testid=booking-banner]').inner_text())
    # chat natural phrases (signed in by the run above)
    page.reload(); page.wait_for_selector('#ask-muse', timeout=10000)
    page.fill('#ask-muse', 'book a flight to London'); page.keyboard.press('Enter')
    page.wait_for_timeout(1500)
    feed = page.locator('.feed').inner_text()
    check('mock chat: "book a flight to London" reaches the booking tool', 'book a flight to London' in feed and ('London' in feed or 'booking' in feed.lower()), feed[-300:])
    page.fill('#ask-muse', 'book a flight for 451'); page.keyboard.press('Enter'); page.wait_for_timeout(600)
    check('mock chat: unlisted price gets a plain reply', 'No listed flight costs $451' in page.locator('.feed').inner_text())
    page.fill('#ask-muse', 'hello'); page.keyboard.press('Enter'); page.wait_for_timeout(500)
    check('mock chat: help text is natural', 'book a flight to London' in page.locator('.feed').inner_text())

    # ---- Real, local address ----
    page.goto('http://127.0.0.1:5702/'); page.wait_for_selector('[data-testid=cm-url-value]')
    card = page.locator('[data-testid=connect-muse]')
    check('real/local: card is near the top, before Sign in', page.evaluate("""() => { const c = document.querySelector('[data-testid=connect-muse]'); const s = document.querySelector('.signin'); const r = c.getBoundingClientRect(); return r.top < 700 && c.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING; }"""))
    check('real/local: warning shown', 'muse.ai runs in the cloud and cannot reach this address. Use the hosted URL.' in page.locator('[data-testid=connect-muse-warning]').inner_text())
    txt = card.inner_text()
    for needle in ['http://127.0.0.1:5702/mcp', 'airline-connector', 'Client secret', 'none', 'S256', 'mcp', 'https://chat.agent.example/oauth/callback',
                   'Step 1: ask muse.ai to add it', 'Step 2: sign in', 'Step 3: check you have four tools', 'Step 4: try these prompts', 'How the prompts work',
                   'loyalty_balance', 'get_loyalty_status', 'list_flights', 'book_flight', 'Book me a flight to London for $620 tomorrow', 'Book me a flight to Denver for $450 tomorrow', 'Book me a flight to Denver tomorrow', 'Book me a flight to Seattle for $500 tomorrow', 'List the flights I can book', 'How many points do I have?']:
        check(f'real/local: card text has {needle!r}', needle.lower() in txt.lower())
    check('real/local: prompt filled with the real URL', 'URL: http://127.0.0.1:5702/mcp.' in page.locator('[data-testid=cm-prompt]').inner_text())
    # copy buttons + clipboard
    for tid, want in [('cm-url', 'http://127.0.0.1:5702/mcp'), ('cm-client', 'airline-connector'), ('cm-secret', 'none'), ('cm-pkce', 'S256'), ('cm-scope', 'mcp'), ('cm-redirect-0', 'https://chat.agent.example/oauth/callback')]:
        page.locator(f'[data-testid={tid}-copy]').click()
        got = page.evaluate('navigator.clipboard.readText()')
        vis = page.locator(f'[data-testid={tid}-copy-state]').is_visible() and page.locator(f'[data-testid={tid}-copy-state]').inner_text().strip() == 'Copied'
        check(f'real/local: {tid} copies {want!r} and shows Copied', got == want and vis, (got, vis))
    page.locator('[data-testid=cm-prompt-copy]').click()
    got = page.evaluate('navigator.clipboard.readText()')
    check('real/local: prompt copy puts the whole prompt on the clipboard', got.startswith('Set up an MCP connector for me. Name: SkyHigh Airline Connector. URL: http://127.0.0.1:5702/mcp.') and got.endswith('list the tools you got.'), got[:80])
    page.wait_for_timeout(2800)
    check('real/local: Copied goes away', not page.locator('[data-testid=cm-prompt-copy-state]').is_visible())
    # keyboard: tab to the first Copy button and press Space, then Enter on another
    page.evaluate('document.activeElement && document.activeElement.blur()')
    page.locator('[data-testid=cm-url-copy]').focus()
    page.keyboard.press('Space'); page.wait_for_timeout(200)
    check('keyboard: Space on focused Copy copies', page.evaluate('navigator.clipboard.readText()') == 'http://127.0.0.1:5702/mcp' and page.locator('[data-testid=cm-url-copy-state]').is_visible())
    page.keyboard.press('Tab')  # onto the client copy button (the state span is not focusable)
    focused = page.evaluate("document.activeElement.getAttribute('data-testid')")
    page.keyboard.press('Enter'); page.wait_for_timeout(200)
    check('keyboard: Tab reaches the next Copy button and Enter copies', focused == 'cm-client-copy' and page.evaluate('navigator.clipboard.readText()') == 'airline-connector', focused)
    outline = page.evaluate("getComputedStyle(document.activeElement).outlineStyle")
    check('keyboard: focus ring visible', outline != 'none', outline)
    # tier card read-only
    page.locator('[data-testid=tier-card]').scroll_into_view_if_needed(); page.wait_for_selector('[data-testid=tier-readonly]')
    check('read-only: note shown', 'Read-only here: change the tier and limit on the local Muse page' in page.locator('[data-testid=tier-readonly]').inner_text())
    check('read-only: every write control disabled', all(page.locator(f'[data-testid={t}]').is_disabled() for t in ['tier-premium', 'tier-standard', 'tier-none', 'limit-250', 'limit-500', 'limit-1000', 'limit-default', 'limit-input', 'limit-apply']))
    check('read-only: Check PingOne still works', page.locator('[data-testid=tier-read]').is_enabled())
    page.locator('[data-testid=tier-read]').click(); page.wait_for_timeout(800)
    check('read-only: card shows what PingOne holds (stub)', 'Premier Gold' in page.locator('[data-testid=tier-current]').inner_text() and '$750' in page.locator('[data-testid=tier-current]').inner_text(), page.locator('[data-testid=tier-current]').inner_text())
    shot(page.locator('[data-testid=tier-card]'), 'tier-card-read-only')
    page.evaluate("window.scrollTo(0,0)")
    shot(card, 'connect-real-local-light')
    set_theme(page, 'dark'); shot(card, 'connect-real-local-dark')
    set_theme(page, 'light')
    # toggle to Mock: card says not enabled
    page.locator('[data-testid=mode-mock]').click(); page.wait_for_selector('[data-testid=connect-muse-off]')
    check('real->mock toggle: card switches to the not-enabled line', 'not enabled in Mock mode' in page.locator('[data-testid=connect-muse]').inner_text())
    page.locator('[data-testid=mode-real]').click(); page.wait_for_selector('[data-testid=cm-url-value]')
    check('mock->real toggle: card is back', page.locator('[data-testid=cm-url-value]').is_visible())

    # ---- Real, public address ----
    page.goto('http://127.0.0.1:5703/'); page.wait_for_selector('[data-testid=cm-url-value]')
    check('real/public: URL is the https address', page.locator('[data-testid=cm-url-value]').inner_text() == 'https://muse.example/mcp')
    check('real/public: NO warning', page.locator('[data-testid=connect-muse-warning]').count() == 0)
    shot(page.locator('[data-testid=connect-muse]'), 'connect-real-public-light')

    # ---- 375px ----
    m = b.new_context(viewport={'width': 375, 'height': 800}, permissions=['clipboard-read', 'clipboard-write'])
    mp = m.new_page()
    for port, name in [(5702, 'connect-375-local'), (5703, 'connect-375-public'), (5701, 'connect-375-mock')]:
        mp.goto(f'http://127.0.0.1:{port}/'); mp.wait_for_selector('[data-testid=connect-muse]'); mp.wait_for_timeout(500)
        over = mp.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(f'375px {name}: no horizontal page scroll', over <= 0, over)
        c = mp.locator('[data-testid=connect-muse]').bounding_box()
        check(f'375px {name}: card fits the viewport', c['x'] >= 0 and c['x'] + c['width'] <= 376, c)
        if name != 'connect-375-public': shot(mp.locator('[data-testid=connect-muse]'), name)
    mp.goto('http://127.0.0.1:5701/'); mp.wait_for_selector('[data-testid=scenario-table]')
    over = mp.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check('375px mock: scenarios, no horizontal page scroll', over <= 0, over)
    mp.locator('[data-testid=scenario-table]').scroll_into_view_if_needed(); shot(mp.locator('[data-testid=scenario-table]'), 'scenarios-375')
    # dark at 375, real local
    md = b.new_context(viewport={'width': 375, 'height': 800}, color_scheme='dark'); dp = md.new_page()
    dp.goto('http://127.0.0.1:5702/'); dp.wait_for_selector('[data-testid=cm-url-value]'); shot(dp.locator('[data-testid=connect-muse]'), 'connect-375-local-dark')
    check('no page errors in the console', not [e for e in errors if 'favicon' not in e and '401' not in e], errors[:3])
    b.close()
fails = [n for n, ok in res if not ok]
print(f'\n{len(res) - len(fails)} passed, {len(fails)} failed'); sys.exit(1 if fails else 0)

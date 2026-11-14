"""Scripted ride lanes: fixed tap sequences per app, prices read from the accessibility tree.

Each app's flow was mapped by hand on this phone. No model calls, so a lane takes seconds.
Pricing never books: tap_label refuses anything labelled Request, Choose or Book. Booking goes
through confirm_label, which only book() calls after the user says yes in the chat.
"""
import re
import time

FORBIDDEN = re.compile(r'request|choose|book|confirm (ride|pickup)|select ', re.I)
ELEMENT = re.compile(r'<XCUIElementType(\w+) [^>]*?label="([^"]*)"[^>]*?visible="true"[^>]*? x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"')
NOT_CARS = re.compile(r'bike|scooter|wait|pet|priority|reserve|courier|moto', re.I)


class Phone:
    def __init__(self, call, device):
        self.call, self.device = call, device
        size = self.act({'action': 'window_size'})['value']
        self.w, self.h = size['width'], size['height']

    def act(self, body):
        return self.call('POST', f'/api/devices/{self.device}/actions', body)

    def tap(self, x, y):
        self.act({'action': 'tap', 'x': x, 'y': y})

    def type(self, text):
        self.act({'action': 'text', 'text': text})

    def source(self):
        return self.act({'action': 'source'})['value']

    def elements(self):
        for kind, label, x, y, w, h in ELEMENT.findall(self.source()):
            yield kind, label.replace('&amp;', '&'), (int(x) + int(w) / 2) / self.w, (int(y) + int(h) / 2) / self.h

    def _tap_match(self, pattern, min_y, allow_forbidden):
        for kind, label, cx, cy in self.elements():
            if kind in ('TextField', 'SearchField', 'Keyboard', 'Key') or cy < min_y:
                continue
            if re.search(pattern, label, re.I):
                if not allow_forbidden and FORBIDDEN.search(label):
                    raise RuntimeError(f'refused to tap "{label}"')
                self.tap(cx, cy)
                return label
        return None

    def tap_label(self, pattern, min_y=0.0):
        return self._tap_match(pattern, min_y, allow_forbidden=False)

    def confirm_label(self, pattern):
        return self._tap_match(pattern, 0.5, allow_forbidden=True)

    def labels(self, pattern):
        return [label for kind, label, cx, cy in self.elements() if re.search(pattern, label, re.I)]

    def wait_for(self, pattern, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            match = re.search(pattern, self.source())
            if match:
                return match
            time.sleep(1)
        return None


def open_fresh(phone, bundle):
    phone.act({'action': 'terminate_app', 'bundle_id': bundle})
    phone.act({'action': 'launch_app', 'bundle_id': bundle})


def pick_result(phone, dest, min_y, fallback):
    time.sleep(2.5)
    if not phone.tap_label(re.escape(dest), min_y):
        phone.tap(*fallback)


def dedupe(options):
    seen, out = set(), []
    for o in options:
        if o['tier'] not in seen and not NOT_CARS.search(o['tier']):
            seen.add(o['tier'])
            out.append(o)
    return sorted(out, key=lambda o: o['price'])


UBER_OPTION = re.compile(r'^([^,]+),Fare \$([\d.]+).*?Driver is (\d+) minute')
LYFT_OPTION = re.compile(r'^([^,]+), Price is \$([\d.]+)(?:, discounted from \$([\d.]+))?.*?, in (\d+) min')
TIER_NAMES = {'ex el': 'XL'}


def skip_after_ride_prompt(phone):
    """After a trip, Uber opens on a 'leave a tip / rate your trip' screen that hides the search bar.
    Skip it without tipping or rating: only a Skip-style button is ever tapped, never a tip amount."""
    if re.search(r'Leave a tip|Rate your (ride|trip)|How was your (ride|trip)|pourboire|Notez votre course',
                 phone.source(), re.I):
        phone.tap_label(r'^\s*(Skip|Not now|Ignorer|Plus tard)\s*$')
        time.sleep(2.5)


def uber_to_prices(phone, dest, step):
    open_fresh(phone, 'com.ubercab.UberClient'); time.sleep(3.5)
    skip_after_ride_prompt(phone)
    step('searching'); phone.tap(0.3, 0.22); time.sleep(1.5); phone.type(dest)
    step('picking destination'); pick_result(phone, dest, 0.25, (0.3, 0.30))
    step('reading prices')
    if not phone.wait_for(r'UberX,Fare \$', 12):
        return []
    found = [UBER_OPTION.match(label) for label in phone.labels(r',Fare \$')]
    return dedupe([{'tier': m.group(1), 'price': float(m.group(2)), 'eta': int(m.group(3)), 'was': None} for m in found if m])


def lyft_to_prices(phone, dest, step):
    open_fresh(phone, 'com.zimride.instant'); time.sleep(3.5)
    step('searching'); phone.tap(0.5, 0.21); time.sleep(1.5); phone.type(dest)
    step('picking destination'); pick_result(phone, dest, 0.33, (0.4, 0.38))
    step('reading prices')
    if not phone.wait_for(r'Standard, Price is \$', 12):
        return []
    found = [LYFT_OPTION.match(label) for label in phone.labels(r', Price is \$')]
    return dedupe([{'tier': TIER_NAMES.get(m.group(1), m.group(1)), 'price': float(m.group(2)), 'eta': int(m.group(4)),
                    'was': float(m.group(3)) if m.group(3) else None} for m in found if m])


def waymo_to_prices(phone, dest, step):
    open_fresh(phone, 'com.waymo.client'); time.sleep(4)
    step('searching'); phone.tap(0.5, 0.33); time.sleep(1.5); phone.type(dest); phone.tap(0.86, 0.885)
    step('picking destination'); pick_result(phone, dest, 0.25, (0.4, 0.685))
    time.sleep(4)
    phone.tap_label(r'^Confirm dropoff$')
    step('reading prices')
    price = phone.wait_for(r'label="\$([\d.]+)"', 12)
    if not price:
        return []
    eta = next((int(m.group(1)) for label in phone.labels(r'min to pickup') if (m := re.search(r'(\d+) min', label))), None)
    return [{'tier': 'Waymo', 'price': float(price.group(1)), 'eta': eta, 'was': None}]


PRICERS = {'Uber': uber_to_prices, 'Lyft': lyft_to_prices, 'Waymo': waymo_to_prices}

# How to select a tier, and which button books it, per app. Mapped on this phone.
CONFIRM = {
    'Uber': lambda tier: [rf'^{re.escape(tier)},Fare', rf'^Choose {re.escape(tier)}$', r'^(Confirm pickup|Confirm|Request .*)$'],
    'Lyft': lambda tier: [rf'^{re.escape({v: k for k, v in TIER_NAMES.items()}.get(tier, tier))}, Price is', r'^(Select|Request|Confirm) .*', r'^(Confirm pickup|Request .*)$'],
    'Waymo': lambda tier: [None, r'^Request ride$', None],
}
BOOKED = r'(?i)(finding|looking for|connecting you|matched|on the way|arriving|driver|your ride|cancel ride|cancel trip)'


def book(phone, app, tier, dest, step, dry_run=False):
    options = PRICERS[app](phone, dest, step)
    quote = next((o for o in options if o['tier'] == tier), options[0] if options else None)
    if not quote:
        return {'status': 'no_price'}
    select, confirm, second = CONFIRM[app](quote['tier'])
    step('selecting ' + quote['tier'])
    if select:
        phone.tap_label(select, 0.3)
        time.sleep(1.5)
    buttons = phone.labels(r'^(Choose|Request|Select|Confirm)')
    if dry_run:
        return {'status': 'dry_run', 'quote': quote, 'would_tap': buttons}
    step('requesting')
    tapped = phone.confirm_label(confirm)
    if not tapped:
        return {'status': 'no_button', 'quote': quote, 'buttons': buttons}
    time.sleep(3)
    if second:
        phone.confirm_label(second)
    booked = phone.wait_for(BOOKED, 20)
    return {'status': 'booked' if booked else 'unconfirmed', 'quote': quote, 'tapped': tapped}


def destination(request):
    text = re.sub(r"[?!.]|\b(right now|asap|what'?s (the )?cheapest|cheapest|please)\b", ' ', request, flags=re.I)
    m = re.search(r'^.*\bto\s+(?:the\s+)?(.+?)(?:,\s*San Francisco)?\s*$', text.strip(), re.I)
    return re.sub(r'\s+', ' ', (m.group(1) if m else text)).strip(' ,')

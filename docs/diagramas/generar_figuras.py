"""Genera los diagramas UML de la arquitectura en PNG (requiere Pillow y Arial).
Uso: python generar_figuras.py"""
import math
import pathlib
from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).parent
FONT = "C:/Windows/Fonts/arial.ttf"
BOLD = "C:/Windows/Fonts/arialbd.ttf"
ITALIC = "C:/Windows/Fonts/ariali.ttf"
BLUE, ORANGE, INK, GREY = "#2B5F9E", "#C9772B", "#222222", "#666666"
LIGHT, PEACH, PALE = "#E8F0FA", "#FDF1E3", "#F6F8FB"
F = lambda size, path=FONT: ImageFont.truetype(path, size)


class Canvas:
    def __init__(self, w, h):
        self.img = Image.new("RGB", (w, h), "white")
        self.d = ImageDraw.Draw(self.img)

    def wrap(self, text, font, width):
        lines = []
        for para in text.split("\n"):
            cur = ""
            for word in para.split(" "):
                probe = f"{cur} {word}".strip()
                if self.d.textlength(probe, font=font) <= width or not cur:
                    cur = probe
                else:
                    lines.append(cur)
                    cur = word
            lines.append(cur)
        return lines

    def text(self, x, y, text, size=30, path=FONT, fill=INK, anchor="mm", width=None, gap=1.18, bg=None):
        font = F(size, path)
        lines = self.wrap(text, font, width) if width else text.split("\n")
        h = size * gap
        y0 = y - h * (len(lines) - 1) / 2 if anchor[1] == "m" else y
        if bg:
            w = max(self.d.textlength(l, font=font) for l in lines)
            left = x - w / 2 if anchor[0] == "m" else (x if anchor[0] == "l" else x - w)
            self.d.rectangle([left - 8, y0 - size * 0.72, left + w + 8, y0 + h * (len(lines) - 1) + size * 0.72], fill=bg)
        for i, line in enumerate(lines):
            self.d.text((x, y0 + i * h), line, font=font, fill=fill, anchor=anchor)
        return len(lines) * h

    def box(self, x0, y0, x1, y1, fill=LIGHT, outline=BLUE, width=4, radius=14):
        self.d.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill, outline=outline, width=width)

    def component(self, x0, y0, x1, y1, label, size=30, fill=LIGHT):
        self.box(x0, y0, x1, y1, fill=fill)
        self.text((x0 + x1) / 2, (y0 + y1) / 2, label, size, width=x1 - x0 - 30)

    def database(self, x0, y0, x1, y1, label, size=26):
        e = 30
        self.d.rectangle([x0, y0 + e / 2, x1, y1 - e / 2], fill=PEACH)
        self.d.ellipse([x0, y1 - e, x1, y1], fill=PEACH, outline=ORANGE, width=4)
        self.d.rectangle([x0 + 3, y0 + e / 2, x1 - 3, y1 - e / 2], fill=PEACH)
        self.d.line([x0, y0 + e / 2, x0, y1 - e / 2], fill=ORANGE, width=4)
        self.d.line([x1, y0 + e / 2, x1, y1 - e / 2], fill=ORANGE, width=4)
        self.d.ellipse([x0, y0, x1, y0 + e], fill=PEACH, outline=ORANGE, width=4)
        self.text((x0 + x1) / 2, (y0 + y1) / 2 + 12, label, size, width=x1 - x0 - 16)

    def package(self, x0, y0, x1, y1, title, size=30, bottom=False):
        self.box(x0, y0, x1, y1, fill=PALE, outline=GREY, width=3, radius=10)
        self.text(x0 + 22, y1 - 34 if bottom else y0 + 34, title, size, BOLD, BLUE, anchor="lm")

    def head(self, x, y, angle, filled=True, fill=INK, size=22):
        a, b = angle + math.radians(155), angle - math.radians(155)
        pa = (x + size * math.cos(a), y + size * math.sin(a))
        pb = (x + size * math.cos(b), y + size * math.sin(b))
        if filled:
            self.d.polygon([(x, y), pa, pb], fill=fill)
        else:
            self.d.line([pa, (x, y), pb], fill=fill, width=4)

    def line(self, pts, dashed=False, fill=INK, width=4):
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if not dashed:
                self.d.line([x0, y0, x1, y1], fill=fill, width=width)
                continue
            length = math.hypot(x1 - x0, y1 - y0)
            n = int(length // 26) or 1
            for i in range(0, n, 2):
                s, e = i / n, min((i + 1) / n, 1)
                self.d.line([x0 + (x1 - x0) * s, y0 + (y1 - y0) * s, x0 + (x1 - x0) * e, y0 + (y1 - y0) * e], fill=fill, width=width)

    def arrow(self, pts, dashed=False, fill=INK):
        self.line(pts, dashed, fill)
        (x0, y0), (x1, y1) = pts[-2], pts[-1]
        self.head(x1, y1, math.atan2(y1 - y0, x1 - x0), filled=not dashed, fill=fill)

    def actor(self, x, y, label, size=28):
        self.d.ellipse([x - 26, y - 90, x + 26, y - 38], outline=INK, width=4, fill="white")
        self.d.line([x, y - 38, x, y + 30], fill=INK, width=4)
        self.d.line([x - 44, y - 12, x + 44, y - 12], fill=INK, width=4)
        self.d.line([x, y + 30, x - 36, y + 84], fill=INK, width=4)
        self.d.line([x, y + 30, x + 36, y + 84], fill=INK, width=4)
        self.text(x, y + 128, label, size)

    def save(self, name):
        self.img.save(OUT / name, dpi=(300, 300))


def componentes():
    c = Canvas(2100, 1560)
    bus = 400
    pkgs = {"U": (480, 40, 1240, 360), "O": (480, 460, 1240, 880), "P": (480, 1030, 1240, 1340)}
    c.package(*pkgs["U"], "Gestión de Usuarios :3002")
    c.component(520, 110, 880, 230, "users-service")
    c.database(960, 110, 1200, 300, "users.db\n+ outbox")
    c.arrow([(880, 170), (960, 170)])

    c.package(*pkgs["O"], "Procesamiento de Pedidos :3003")
    c.component(520, 530, 880, 660, "orders-service\n(orquestador de saga)")
    c.component(520, 750, 880, 850, "Pago simulado (adaptador)", 26, fill="white")
    c.database(960, 530, 1200, 730, "orders.db\n+ outbox")
    c.arrow([(880, 590), (960, 590)])
    c.arrow([(700, 660), (700, 750)])
    c.text(710, 705, "charge / refund", 24, anchor="lm", fill=GREY)

    c.package(*pkgs["P"], "Gestión de Productos :3001", bottom=True)
    c.component(520, 1070, 880, 1190, "products-service")
    c.database(960, 1060, 1200, 1270, "products.db")
    c.arrow([(880, 1130), (960, 1130)])

    c.package(1500, 200, 2070, 880, "Notificaciones :3004")
    c.component(1540, 270, 2030, 400, "notifications-service\n(worker asíncrono)")
    c.database(1660, 480, 1910, 660, "notifications.db\n(inbox)", 24)
    c.component(1540, 750, 2030, 850, "Correo simulado (adaptador)", 26, fill="white")
    c.arrow([(1785, 400), (1785, 480)])
    c.arrow([(1990, 400), (1990, 750)])
    c.text(1980, 575, "send", 24, anchor="rm", fill=GREY)

    c.actor(150, 610, "Cliente\n(web o móvil)")
    c.line([(205, 610), (bus, 610)])
    c.line([(bus, 170), (bus, 1130)])
    c.arrow([(bus, 170), (520, 170)])
    c.arrow([(bus, 595), (520, 595)])
    c.arrow([(bus, 1130), (520, 1130)])
    c.text(bus - 8, 130, "REST: registro,\nlogin, perfil", 24, anchor="rm", fill=GREY)
    c.text(bus - 8, 540, "REST + JWT:\npedidos", 24, anchor="rm", fill=GREY)
    c.text(bus - 8, 1090, "REST:\ncatálogo", 24, anchor="rm", fill=GREY)
    c.line([(bus, 170), (bus, 18), (1960, 18)])
    c.arrow([(1960, 18), (1960, 270)])
    c.text(1400, 18, "REST + JWT: mis notificaciones", 24, fill=GREY, bg="white")

    c.arrow([(700, 880), (700, 1070)])
    c.text(725, 955, "REST síncrono: reservar y liberar stock\n(timeout, retry, circuit breaker)", 25, anchor="lm", bg="white")
    c.arrow([(1240, 800), (1500, 800)], dashed=True, fill=BLUE)
    c.text(1370, 745, "evento asíncrono\n(outbox) order.*", 24, fill=BLUE, bg="white")
    c.arrow([(1240, 300), (1500, 300)], dashed=True, fill=BLUE)
    c.text(1370, 245, "evento asíncrono\n(outbox)\nuser.registered", 24, fill=BLUE, bg="white")

    c.line([(60, 1430), (190, 1430)])
    c.text(210, 1430, "Llamada síncrona (HTTP/REST)", 26, anchor="lm")
    c.line([(60, 1490), (190, 1490)], dashed=True, fill=BLUE)
    c.text(210, 1490, "Evento asíncrono sobre HTTP, con reintentos. Cada servicio es el único propietario de su base de datos.", 26, anchor="lm")
    c.save("01-componentes.png")


class Seq:
    def __init__(self, participants, width=2100, size=27):
        self.names = participants
        self.size = size
        self.width = width
        step = (width - 340) / (len(participants) - 1)
        self.x = {k: 170 + i * step for i, (k, _) in enumerate(participants)}
        self.ops = []
        self.step = step

    def msg(self, a, b, text, dashed=False):
        self.ops.append(("msg", a, b, text, dashed))

    def div(self, text):
        self.ops.append(("div", text))

    def note(self, a, b, text):
        self.ops.append(("note", a, b, text))

    def frame(self, label, ops):
        self.ops.append(("frame", label, len(ops)))
        self.ops.extend(ops)
        self.ops.append(("endframe",))

    def render(self, name):
        probe = Canvas(10, 10)
        font = F(self.size)
        heights = []
        for op in self.ops:
            if op[0] == "msg":
                _, a, b, text, _ = op
                span = max(abs(self.x[a] - self.x[b]), self.step) - 30
                n = len(probe.wrap(text, font, span))
                heights.append(n * self.size * 1.2 + 44 + (30 if a == b else 0))
            elif op[0] == "div":
                heights.append(100)
            elif op[0] == "note":
                _, a, b, text = op
                span = abs(self.x[a] - self.x[b]) + self.step * 0.7
                heights.append(len(probe.wrap(text, font, span - 30)) * self.size * 1.2 + 44)
            elif op[0] == "frame":
                heights.append(60)
            else:
                heights.append(26)
        top, n = 150, len(self.ops)
        h = top + sum(heights) + 60
        c = Canvas(self.width, int(h))
        for k, label in self.names:
            c.line([(self.x[k], top - 40), (self.x[k], h - 20)], dashed=True, fill=GREY, width=3)
        for k, label in self.names:
            half = min(self.step / 2 - 10, 150)
            c.component(self.x[k] - half, 20, self.x[k] + half, top - 40, label, 25)
        y = top
        stack = []
        for op, height in zip(self.ops, heights):
            if op[0] == "msg":
                _, a, b, text, dashed = op
                xa, xb = self.x[a], self.x[b]
                if a == b:
                    c.text(xa + 20, y + 4, text, self.size, anchor="lt", width=self.step * 1.0)
                    yy = y + height - 34
                    c.arrow([(xa, yy - 20), (xa + 60, yy - 20), (xa + 60, yy), (xa, yy)])
                else:
                    span = abs(xa - xb)
                    width = max(span, self.step) - 30
                    mid = (xa + xb) / 2
                    if span < self.step * 0.9:
                        mid = (xa + xb) / 2
                    lines = c.wrap(text, font, width)
                    for i, line in enumerate(lines):
                        c.d.rectangle([mid - c.d.textlength(line, font=font) / 2 - 6, y + i * self.size * 1.2 - 2, mid + c.d.textlength(line, font=font) / 2 + 6, y + (i + 1) * self.size * 1.2], fill="white")
                        c.d.text((mid, y + i * self.size * 1.2), line, font=font, fill=INK, anchor="mt")
                    yy = y + len(lines) * self.size * 1.2 + 16
                    c.arrow([(xa, yy), (xb, yy)], dashed=dashed)
            elif op[0] == "div":
                yy = y + 50
                c.line([(20, yy), (self.width - 20, yy)], fill=GREY, width=3)
                c.text(self.width / 2, yy, op[1], self.size, BOLD, BLUE, bg="white")
            elif op[0] == "note":
                _, a, b, text = op
                x0 = min(self.x[a], self.x[b]) - self.step * 0.35
                x1 = max(self.x[a], self.x[b]) + self.step * 0.35
                x0, x1 = max(x0, 10), min(x1, self.width - 10)
                c.box(x0, y + 6, x1, y + height - 12, fill="#FFF9D6", outline="#B59B2B", width=3, radius=4)
                c.text((x0 + x1) / 2, y + height / 2 - 3, text, self.size - 1, width=x1 - x0 - 24)
            elif op[0] == "frame":
                stack.append((y, op[1]))
            elif op[0] == "endframe":
                y0, label = stack.pop()
                c.d.rectangle([40, y0 + 8, self.width - 40, y + 8], outline=GREY, width=3)
                w = c.d.textlength(label, font=F(25, BOLD)) + 24
                c.d.rectangle([40, y0 + 8, 40 + w, y0 + 48], fill=LIGHT, outline=GREY, width=3)
                c.text(52, y0 + 28, label, 25, BOLD, anchor="lm")
            y += height
        c.save(name)


def secuencia_pedido():
    s = Seq([("C", "Cliente"), ("O", "orders-service"), ("DB", "orders.db"), ("P", "products-service"), ("Pay", "Pago simulado"), ("D", "Despachador (outbox)"), ("N", "notifications-service")], size=26)
    s.msg("C", "O", "POST /orders (JWT, items, paymentToken)")
    s.msg("O", "DB", "INSERT pedido PENDING")
    s.frame("loop: por cada línea", [
        ("msg", "O", "P", "POST /internal/products/:id/reservations", False),
        ("msg", "P", "O", "201 reserva (precio vigente)", True),
    ])
    s.msg("O", "Pay", "charge(orderId, total, token)")
    s.msg("Pay", "O", "aprobado (referencia)", True)
    s.msg("O", "DB", "TX: CONFIRMED + evento en outbox")
    s.msg("O", "C", "201 pedido CONFIRMED", True)
    s.div("Asíncrono: el cliente ya recibió la respuesta")
    s.msg("D", "DB", "leer eventos pendientes")
    s.msg("D", "N", "POST /events (eventId)")
    s.msg("N", "D", "202 Accepted", True)
    s.msg("D", "DB", "marcar evento como SENT")
    s.note("N", "N", "El worker envía el correo simulado")
    s.div("Compensación si el pago es rechazado")
    s.msg("Pay", "O", "rechazado", True)
    s.msg("O", "DB", "TX: PAYMENT_FAILED + stock-release + evento")
    s.msg("O", "C", "402 Payment Required", True)
    s.msg("D", "P", "DELETE /internal/products/:id/reservations/:rid")
    s.msg("P", "D", "204 stock repuesto", True)
    s.render("02-secuencia-pedido.png")


def secuencia_fallos():
    s = Seq([("C", "Cliente"), ("O", "orders-service"), ("B", "Circuit breaker + retry"), ("P", "products-service (caído)"), ("R", "Reconciliador")], size=28)
    s.msg("C", "O", "POST /orders")
    s.msg("O", "B", "reserve(...)")
    s.frame("loop: hasta 3 intentos, backoff y jitter", [
        ("msg", "B", "P", "POST reservations (timeout 1.5 s)", False),
        ("msg", "P", "B", "error de red o 5xx", True),
    ])
    s.msg("B", "O", "error transitorio", True)
    s.note("O", "O", "Fallback: el pedido queda PENDING con reintento programado")
    s.msg("O", "C", "202 Accepted + Retry-After", True)
    s.div("Tras 5 fallos seguidos: circuito OPEN")
    s.msg("C", "O", "POST /orders")
    s.msg("O", "B", "reserve(...)")
    s.msg("B", "O", "CircuitOpenError, sin usar la red", True)
    s.msg("O", "C", "202 Accepted (respuesta inmediata)", True)
    s.div("Productos vuelve a estar disponible")
    s.msg("R", "O", "process(orderId) al vencer la espera")
    s.msg("O", "B", "reserve(...) con el mismo reservationId")
    s.note("B", "B", "HALF_OPEN: una llamada de prueba")
    s.msg("B", "P", "POST reservations")
    s.msg("P", "B", "201 reserva; circuito CLOSED", True)
    s.note("O", "O", "Cobra (idempotente) y confirma el pedido")
    s.render("03-secuencia-fallos.png")


def estados():
    c = Canvas(2100, 1180)
    def st(x, y, label, w=340, h=100, fill=LIGHT):
        c.box(x - w / 2, y - h / 2, x + w / 2, y + h / 2, fill=fill, radius=44)
        c.text(x, y, label, 28, BOLD)
    def start(x, y):
        c.d.ellipse([x - 22, y - 22, x + 22, y + 22], fill=INK)
    def end(x, y):
        c.d.ellipse([x - 28, y - 28, x + 28, y + 28], outline=INK, width=4, fill="white")
        c.d.ellipse([x - 16, y - 16, x + 16, y + 16], fill=INK)

    start(90, 330)
    st(420, 330, "PENDING")
    st(1150, 110, "CONFIRMED")
    st(1150, 500, "REJECTED")
    st(1150, 720, "PAYMENT_FAILED", w=400)
    st(1150, 940, "FAILED")
    st(1780, 110, "SHIPPED")
    st(1720, 350, "CANCELLED")
    st(1780, 600, "DELIVERED")
    c.arrow([(112, 330), (250, 330)])
    c.text(180, 285, "POST\n/orders", 25, fill=GREY)
    c.line([(340, 280), (340, 190), (500, 190)])
    c.arrow([(500, 190), (500, 280)])
    c.text(420, 135, "falla transitoria\n(reintento programado)", 25, fill=GREY)
    c.arrow([(590, 310), (780, 110), (980, 110)])
    c.text(800, 58, "reserva y pago correctos", 25, fill=GREY)
    c.arrow([(590, 350), (760, 500), (980, 500)])
    c.text(860, 545, "sin producto o sin stock", 25, fill=GREY)
    c.arrow([(530, 380), (700, 720), (950, 720)])
    c.text(825, 668, "pago rechazado", 25, fill=GREY, bg="white")
    c.arrow([(420, 380), (420, 940), (980, 940)])
    c.text(680, 893, "reintentos agotados", 25, fill=GREY, bg="white")
    c.arrow([(1320, 110), (1610, 110)])
    c.text(1465, 70, "administrador", 25, fill=GREY)
    c.arrow([(1150, 160), (1150, 350), (1550, 350)])
    c.text(1350, 275, "dueño o admin: repone\nstock y reembolsa", 25, fill=GREY)
    c.line([(1950, 110), (2040, 110), (2040, 600)])
    c.arrow([(2040, 600), (1950, 600)])
    c.text(2030, 300, "admin", 25, fill=GREY, anchor="rm")
    end(1780, 740)
    c.arrow([(1780, 650), (1780, 712)])
    end(1970, 350)
    c.arrow([(1890, 350), (1942, 350)])
    for yy, x in [(500, 1320), (720, 1350), (940, 1320)]:
        c.arrow([(x, yy), (1450, yy)])
        end(1478, yy)
    c.save("04-estados-pedido.png")


def despliegue():
    c = Canvas(2100, 1270)
    c.component(600, 20, 1500, 130, "Balanceador de carga / API Gateway\n(TLS, autenticación, límite de peticiones)", 28)
    pools = [
        (40, 510, "Pool de Productos\n(réplicas sin estado)", "products-service #1..N"),
        (550, 1020, "Pool de Usuarios", "users-service #1..N"),
        (1060, 1530, "Pool de Pedidos", "orders-service #1..N"),
        (1570, 2060, "Pool de Notificaciones", "notifications-service\n(consumidores #1..N)"),
    ]
    dbs = ["PostgreSQL productos\n+ réplicas de lectura\n+ caché", "PostgreSQL usuarios", "PostgreSQL pedidos\n+ outbox", "PostgreSQL\nnotificaciones"]
    for (x0, x1, title, comp), db in zip(pools, dbs):
        c.box(x0, 230, x1, 560, fill=PALE, outline=GREY, width=3, radius=10)
        c.text((x0 + x1) / 2, 290, title, 27, BOLD, BLUE)
        c.component(x0 + 40, 370, x1 - 40, 510, comp, 27)
        mid = (x0 + x1) / 2
        c.arrow([(mid, 130), (mid, 230)]) if 600 < mid < 1500 else c.arrow([(mid, 75), (600 if mid < 600 else 1500, 75)][::-1] + [(mid, 230)])
        c.database(x0 + 50, 880, x1 - 50, 1110, db, 25)
        if x0 == 40:
            c.arrow([(mid - 60, 560), (mid - 60, 880)])
    for x in [785, 1160, 1815]:
        c.arrow([(x, 560), (x, 880)])
    c.database(1220, 640, 1530, 800, "RabbitMQ\n(evolución propuesta)", 25)
    c.arrow([(1375, 560), (1375, 640)], dashed=True, fill=BLUE)
    c.text(1385, 600, "order.*", 24, fill=BLUE, anchor="lm")
    c.line([(1530, 720), (1700, 720)], dashed=True, fill=BLUE)
    c.arrow([(1700, 720), (1700, 560)], dashed=True, fill=BLUE)
    c.text(1680, 650, "consumidores\ncompetidores", 24, fill=BLUE, anchor="rm", bg="white")
    c.line([(930, 560), (930, 720)], dashed=True, fill=BLUE)
    c.arrow([(930, 720), (1220, 720)], dashed=True, fill=BLUE)
    c.text(1075, 685, "user.*", 24, fill=BLUE)
    c.line([(1090, 560), (1090, 610), (360, 610)])
    c.arrow([(360, 610), (360, 560)])
    c.text(570, 610, "REST: reservar stock", 24, bg="white")
    c.text(1050, 1190, "Vista objetivo de producción. La implementación académica usa un proceso por servicio y SQLite local.", 26, fill=GREY)
    c.save("05-despliegue-escalado.png")


if __name__ == "__main__":
    componentes()
    secuencia_pedido()
    secuencia_fallos()
    estados()
    despliegue()
    print("Figuras generadas en", OUT)

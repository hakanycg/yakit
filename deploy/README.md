# Yakit - VPS kurulum dosyaları

Bu klasör Railway'den kendi VPS'imize geçerken kullanılacak üç dosyayı içerir
(bkz. `BEKLEYENLER.md` "Altyapı: veri merkezine geçiş").

- **`setup-firewall.sh`** — ufw güvenlik duvarı: varsayılan olarak her şeyi
  reddeder, yalnızca SSH (hız sınırlı), HTTP (80) ve HTTPS (443) açar. Node
  uygulama portu (4000) ve ajan loopback portu (4500) **hiçbir zaman**
  dışarıya açılmaz.
- **`nginx.conf`** — ters vekil şablonu: HTTPS sonlandırma (certbot ile),
  `/ws` WebSocket yükseltmesi, interkom ses kaydı için 26MB+ gövde limiti.
- **`yakit.service`** — systemd servis dosyası: uygulamayı arka planda tutar,
  çökerse otomatik yeniden başlatır.

## Kurulum sırası (yeni VPS'te)

```bash
sudo bash deploy/setup-firewall.sh
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/yakit
# nginx.conf içindeki DOMAIN_ADI yerlerini gerçek alan adıyla değiştirin
sudo ln -s /etc/nginx/sites-available/yakit /etc/nginx/sites-enabled/
sudo certbot --nginx -d DOMAIN_ADI
sudo cp deploy/yakit.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yakit
```

Uygulamanın kendi güvenlik katmanı (helmet/CSP/CORS/rate-limit) zaten
`server/src/app.ts` içinde — bu dosyalar yalnızca TLS sonlandırma, trafik
yönlendirme ve ağ seviyesi erişim kontrolünden sorumlu.

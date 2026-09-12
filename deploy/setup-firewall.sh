#!/usr/bin/env bash
# Yakit - VPS guvenlik duvari kurulumu (ufw)
#
# Ilke: varsayilan olarak HER SEYI reddet, yalnizca gerekli 3 portu ac.
# Node uygulamasi (4000) ve SQLite dosyasi disaridan HICBIR ZAMAN dogrudan
# erisilebilir olmamali - yalnizca nginx (127.0.0.1 uzerinden) konusur.
#
# Kullanim: yeni VPS'te sudo ile bir kere calistirin.
#   sudo bash deploy/setup-firewall.sh

set -euo pipefail

if ! command -v ufw >/dev/null 2>&1; then
  echo "ufw bulunamadi. Once kurun: sudo apt-get update && sudo apt-get install -y ufw"
  exit 1
fi

# Varsayilan: gelen HER SEY reddedilir, giden serbest birakilir.
ufw default deny incoming
ufw default allow outgoing

# SSH - kaba kuvvet denemelerini yavaslatmak icin rate-limit'li (ufw'nin kendi
# ozelligi: ayni IP'den kisa surede tekrarlanan baglanti denemelerini geciktirir).
ufw limit 22/tcp comment "SSH (rate-limited)"

# nginx'in dinledigi tek iki port - HTTP (certbot yenilemesi + 443'e yonlendirme
# icin acik kalmali) ve HTTPS.
ufw allow 80/tcp comment "HTTP (nginx, certbot icin acik kalmali)"
ufw allow 443/tcp comment "HTTPS (nginx)"

# ONEMLI: Node uygulama portu (varsayilan 4000, bkz. server/.env PORT) BURADA
# ACILMIYOR - kasitli. Uygulama yalnizca 127.0.0.1 uzerinden nginx'ten trafik
# alir; disaridan dogrudan port 4000'e erisim mumkun olmamali. Ayni sekilde
# istasyon ajaninin/yerel POS-yazici entegrasyonunun kullandigi 4500 portu da
# (bkz. agent/src/server.ts, loopback) yalnizca 127.0.0.1'de dinler - disariya
# hic acilmamali.

ufw --force enable
ufw status verbose
